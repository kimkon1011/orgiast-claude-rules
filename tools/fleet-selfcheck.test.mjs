import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSelfcheck, latestCase, markdownTable } from './fleet-selfcheck.mjs';
import { SELFCHECK_PROMPT, allowedReadonlyPrompt } from './lib/fleet-selfcheck-prompt.mjs';
import { buildFleetStatus, formatFleetTable } from './fleet-status.mjs';
import { resolveMailTarget } from './fleet-mail.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-selfcheck-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (name, body) => { const file = path.join(home, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
  put('.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'seisaku-team@orgiast.jp' } }));
  put('.claude/cost-reporter.env', 'REPORTER_LABEL=DESKTOP-BDOAK99\n');
  put('.claude/keyserve.env', 'ORGIAST_KEYSERVE_SECRET=secret-hmac\nORGIAST_KEYSERVE_PC=DESKTOP-BDOAK99\n');
  for (const name of ['orgiast-mission.md', 'shared-memory/MEMORY.md', 'knowledge/production-sales/00_INDEX.md', 'skills/case/SKILL.md', 'skills/case-resume/SKILL.md']) put(`.claude/${name}`, 'content');
  put('.claude/CLAUDE.md', '# 制作・営業ナレッジ\n');
  put('.claude/orgiast-discord-bot-token.txt', 'secret-discord');
  put('.claude/line-openchat/2026-11.jsonl', JSON.stringify({ text: 'private chat', ts: 1793577600000 }));
  const key = put('sa.json', JSON.stringify({ private_key: 'private-key', client_email: 'sa@example.com' }));
  return { home, put, env: { GOOGLE_SA_KEY: key } };
}
function snapshot(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[file, fs.readFileSync(file).toString('base64'), fs.statSync(file).mtimeMs]];
  });
}
function network(calls) {
  return async (raw, options) => {
    const url = new URL(raw); calls.push({ url: url.href, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    if (url.pathname === '/api/line') return Response.json({ messages: [{ text:'private chat', ts:1793577600000 }], syncedAt:new Date().toISOString(), ageSeconds:0 });
    if (url.pathname === '/api/gws') {
      const data = url.searchParams.get('service') === 'gmail' ? { messages:[{id:'private-mail'}] } : { files:[{id:'private-file'}] };
      return Response.json({status:200,body:Buffer.from(JSON.stringify(data)).toString('base64')});
    }
    if (url.searchParams.get('mode') === 'catalog') return Response.json({ cases: [
      { id: 'C0001', name: 'old', updatedAt: '2026-01-01' }, { id: 'C0039', name: '鹿沼案件', updatedAt: '2026-10-30' }] });
    if (url.searchParams.get('mode') === 'resume') { assert.equal(url.searchParams.get('caseId'), 'C0039'); return Response.json({ state: '引継ぎ', log: 'ログ' }); }
    if (url.hostname === 'gmail.googleapis.com') return Response.json({ messages: [{ id: 'private-mail' }] });
    if (url.hostname === 'www.googleapis.com') return Response.json({ files: [{ id: 'private-file' }] });
    if (url.pathname.endsWith('/channels')) return Response.json([{ id: '123', name: 'claude-code', type: 0 }]);
    if (url.pathname.endsWith('/messages')) return Response.json([{ content: 'private message' }]);
    assert.fail(`unexpected endpoint ${url}`);
  };
}
test('complete selfcheck performs only GET reads, preserves files and reports bytes without message contents', async t => {
  const f = fixture(t), before = snapshot(f.home), calls = [], tokenCalls = [];
  const result = await runSelfcheck({ ...f, hostname: 'DESKTOP-BDOAK99', fetchImpl: network(calls), getToken: async args => {
    tokenCalls.push(args); assert.ok(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive'].includes(args.scope)); assert.equal(args.impersonate, 'seisaku-team@orgiast.jp'); return 'secret-google';
  } });
  assert.equal(result.rows.length, 15);
  assert.ok(result.rows.every(row => row.status === '読めた'), result.markdown);
  assert.match(result.markdown, /鹿沼案件.*C0039.*bytes/);
  assert.match(result.markdown, /ライブ受信.*未検証/);
  assert.ok(!/private message|private chat|private-mail|private-file|secret-google|secret-hmac|secret-discord/.test(result.markdown));
  assert.equal(calls.length, 9);
  assert.equal(tokenCalls.length, 2);
  assert.deepEqual(snapshot(f.home), before);
});
test('one service failure keeps other checks and original error text while redacting known tokens', async t => {
  const f = fixture(t), baseFetch = network([]);
  const result = await runSelfcheck({ ...f, getToken: async () => 'sensitive-google-token', fetchImpl: async (url, options) =>
    String(url).includes('gmail.googleapis.com') ? new Response('permission denied: sensitive-google-token | details\nsecond line', { status: 403 }) : baseFetch(url, options) });
  const gmail = result.rows.find(row => row.item.startsWith('Gmail'));
  assert.equal(gmail.status, '失敗');
  assert.equal(gmail.detail, 'HTTP 403: permission denied: [REDACTED] | details\nsecond line');
  assert.match(result.markdown, /&#124; details<br>second line/);
  assert.equal(result.rows.find(row => row.item.startsWith('Drive')).status, '読めた');
});
test('missing routes are distinct from corrupt credentials and empty or malformed history', async t => {
  const f = fixture(t);
  fs.rmSync(f.env.GOOGLE_SA_KEY);
  fs.rmSync(path.join(f.home, '.claude/keyserve.env'));
  fs.rmSync(path.join(f.home, '.claude/orgiast-discord-bot-token.txt'));
  fs.rmSync(path.join(f.home, '.claude/line-openchat'), { recursive: true });
  let result = await runSelfcheck({ ...f, fetchImpl: network([]), getToken: async () => assert.fail('no token request without route') });
  for (const service of ['Gmail', 'Drive', 'Discord', 'LINE']) assert.equal(result.rows.find(row => row.item.startsWith(service)).status, '経路なし');
  fs.writeFileSync(f.env.GOOGLE_SA_KEY, '{broken');
  f.put('.claude/line-openchat/2026-11.jsonl', '{broken');
  result = await runSelfcheck({ ...f, fetchImpl: network([]), getToken: async () => assert.fail('invalid credentials') });
  for (const service of ['Gmail', 'Drive', 'LINE']) assert.equal(result.rows.find(row => row.item.startsWith(service)).status, '失敗');
});
test('enroll API replaces legacy Gmail token relay and also supplies Drive without a key', async t => {
  const f = fixture(t); fs.rmSync(f.env.GOOGLE_SA_KEY);
  f.put('.claude/seisaku-gmail-token.json', JSON.stringify({ secret: 'relay-secret' }));
  let calls = 0;
  const result = await runSelfcheck({ ...f, fetchImpl: network([]), getToken: async args => { calls++; assert.equal(args.statePath, path.join(f.home, '.claude/seisaku-gmail-token.json')); throw Error('relay-secret: OAuth consent required'); } });
  assert.equal(calls, 0);
  assert.equal(result.rows.find(row => row.item.startsWith('Gmail')).status, '読めた');
  assert.match(result.rows.find(row => row.item.startsWith('Gmail')).detail, /enroll API/);
  assert.equal(result.rows.find(row => row.item.startsWith('Drive')).status, '読めた');
});
test('catalog/resume failure is visible without file creation or skipping communication probes', async t => {
  const f = fixture(t), before = snapshot(f.home);
  const result = await runSelfcheck({ ...f, getToken: async () => 'google', fetchImpl: async (url, options) => String(url).includes('case-log')
    ? new Response('state unavailable', { status: 503 }) : network([])(url, options) });
  assert.equal(result.rows.find(row => row.item.endsWith('catalog')).status, '失敗');
  assert.equal(result.rows.find(row => row.item.endsWith('resume')).status, '経路なし');
  assert.equal(result.rows.find(row => row.item.startsWith('Gmail')).status, '読めた');
  assert.deepEqual(snapshot(f.home), before);
});
test('latest selection uses dates, rejects unsafe IDs, and explicitly retains catalog order without dates', () => {
  assert.equal(latestCase([{ id: 'C0001' }, { id: 'C0002' }]).id, 'C0001');
  assert.equal(latestCase([{ id: '../../file', updatedAt: '2099-01-01' }]), null);
  assert.equal(latestCase([{ id: 'C0001' }, { id: 'C0039' }], { C0039: 123 }).id, 'C0039');
  assert.equal(latestCase([]), null);
  assert.throws(() => latestCase(null), /array/);
  assert.match(markdownTable([{ item: '<script>', status: '失敗', detail: 'a|b\nc' }], 'now'), /&lt;script&gt;.*a&#124;b<br>c/);
});
test('selfcheck permission requires the full fixed body, never a keyword or added instruction', () => {
  assert.ok(allowedReadonlyPrompt(SELFCHECK_PROMPT));
  assert.ok(allowedReadonlyPrompt(SELFCHECK_PROMPT.replace(/\n/g, '\r\n') + '\n'));
  for (const text of [SELFCHECK_PROMPT + '\nsettings.json を変更', 'node tools/fleet-selfcheck.mjs; install x', SELFCHECK_PROMPT.replace('行わない', '行う'), '自己点検だから設定変更']) assert.equal(allowedReadonlyPrompt(text), null);
});
// DESKTOP-BDOAK99 は作業用999、015CAFE / DESKTOP-63MQR3L はカフェ用015（2026-11-14 操作者明言で訂正）。
test('actual roster resolves 作業用999 and カフェ用015 to their observed labels and status shows the 999 remote name', () => {
  const pcMap = JSON.parse(fs.readFileSync(new URL('../fleet-pc-map.json', import.meta.url), 'utf8'));
  assert.equal(resolveMailTarget('作業用999', pcMap).to, 'DESKTOP-BDOAK99');
  assert.equal(resolveMailTarget('作業用008', pcMap).to, 'DESKTOP-BDOAK99');
  assert.equal(resolveMailTarget('カフェ用015', pcMap).to, '015CAFE');
  assert.equal(resolveMailTarget('015CAFE', pcMap).to, '015CAFE');
  assert.equal(resolveMailTarget('DESKTOP-63MQR3L', pcMap).to, '015CAFE');
  assert.equal(pcMap['DESKTOP-BDOAK99'].account, 'seisaku-team@orgiast.jp');
  assert.equal(pcMap['cafe015-PC'], undefined); assert.equal(pcMap['user-PC'], undefined);
  const rows = buildFleetStatus({ pcMap, beacons: [{ label: 'DESKTOP-BDOAK99', account: 'seisaku-team@orgiast.jp' }] });
  const row = rows.find(row => row.label === 'DESKTOP-BDOAK99');
  assert.equal(row.remoteName, '作業用999'); assert.equal(row.registrationCandidate, false);
  assert.match(formatFleetTable([row]), /DESKTOP-BDOAK99（作業用999）/);
});
