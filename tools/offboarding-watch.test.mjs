import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { main, collectWorkspace, collectClaude, collectFleet, fleetTime } from './offboarding-watch.mjs';
import { main as register } from './register-offboarding-watch.mjs';
const now = Date.parse('2026-10-29T12:00:00+09:00');
const ok = data => ({ status: 'ok', data, count: data.length });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'offboarding-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (name, value) => { const f = path.join(home, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(value)); };
  const member = { name: '退職者', email: 'retired@orgiast.jp', claudeEmails: ['alias@orgiast.jp'], status: 'active', retiredOn: null, pcs: ['retired-PC'] };
  const ledger = { version: 1, contractedOrgUuids: ['org'], members: [member] };
  write('claude-account-ledger.json', ledger); write('knowledge-revoked-pcs.json', ['old-PC']);
  const f = { home, write, ledger, member, output: '', messages: [], calls: [] };
  f.deps = { home, toolsDir: home, serverDir: '/keyserve', env: {}, now: () => now,
    stdout: text => { f.output = text; },
    collectors: { workspace: async () => ok([{ primaryEmail: member.email, suspended: true }]),
      claude: async () => ok([{ email: 'alias@orgiast.jp' }]),
      fleet: async () => ok([{ pc: 'retired-PC', email: member.email, reportedAt: new Date(now - 1000).toISOString(), keyservePcId: 'retired-PC' }]) },
    notify: async body => { f.messages.push(body); return { delivered: 'dm' }; },
    spawn: (cmd, args, opts) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = input => { f.calls.push({ cmd, args, opts, input }); queueMicrotask(() => child.emit('close', 0)); };
      return child;
    },
  };
  f.run = async args => { const code = await main(['--json', ...(args || [])], f.deps); return { code, result: JSON.parse(f.output) }; };
  return f;
}
test('Workspace停止から退職判定し4種を検出・別名メール照合', async t => {
  const f = fixture(t), { result } = await f.run();
  assert.deepEqual(result.findings.map(x => x.type), ['claude-member','recent-login','unrevoked-pc','ledger-active']);
  assert.equal(result.retired.length, 1);
  assert.ok(fs.existsSync(path.join(f.home, '.claude/logs/offboarding-watch/2026-10-29.json')));
});
test('status/退職日/archived/Workspace欠落による判定、取得失敗で欠落と推定しない', async t => {
  for (const mode of ['retired','date','archived','missing','unavailable','future']) {
    const f = fixture(t);
    if (mode === 'retired') f.member.status = 'retired';
    if (mode === 'date') f.member.retiredOn = '2026-10-29';
    if (mode === 'future') f.member.retiredOn = '2026-10-30';
    f.write('claude-account-ledger.json', f.ledger);
    f.deps.collectors.workspace = async () => mode === 'unavailable' ? { status: 'unavailable', reason: 'HTTP 403', data: [] }
      : ok(mode === 'missing' ? [] : [{ primaryEmail: f.member.email, archived: mode === 'archived' }]);
    assert.equal((await f.run()).result.retired.length, ['unavailable','future'].includes(mode) ? 0 : 1, mode);
  }
});
test('台帳外・組織外ドメイン、ログイン7日境界・未来と古い報告は除外', async t => {
  const f = fixture(t);
  f.deps.collectors.claude = async () => ok([{ email: 'outsider@example.com' }]);
  f.deps.collectors.fleet = async () => ok([
    { pc: 'boundary', email: f.member.email, reportedAt: new Date(now - 7*86400e3).toISOString() },
    { pc: 'old', email: f.member.email, reportedAt: new Date(now - 7*86400e3 - 1).toISOString() },
    { pc: 'future', email: f.member.email, reportedAt: new Date(now + 1).toISOString() },
    { pc: 'unknown', email: 'other@orgiast.jp', reportedAt: new Date(now).toISOString() },
  ]);
  const { result } = await f.run();
  assert.equal(result.findings.filter(x => x.type === 'recent-login').length, 1);
  assert.equal(result.unknown.length, 2);
});
test('全データ源の未取得が結果と通知に残る・秘密例外を隠す', async t => {
  const f = fixture(t);
  for (const k of ['workspace','claude','fleet']) f.deps.collectors[k] = async () => { throw Error('secret-key'); };
  fs.unlinkSync(path.join(f.home, 'claude-account-ledger.json'));
  fs.unlinkSync(path.join(f.home, 'knowledge-revoked-pcs.json'));
  const { result } = await f.run(['--notify']);
  for (const k of ['workspace','claude','fleet','ledger','revoked']) {
    assert.equal(result.sources[k].status, 'unavailable'); assert.ok(f.messages[0].includes(`未取得: ${k}（`));
  }
  assert.ok(!f.output.includes('secret-key'));
});
test('同内容の同日通知抑止、異なる内容と翌日は送る、検出ゼロは送らない', async t => {
  const f = fixture(t);
  await f.run(['--notify']); await f.run(['--notify']); assert.equal(f.messages.length, 1);
  f.deps.collectors.claude = async () => ok([]);
  await f.run(['--notify']); assert.equal(f.messages.length, 2);
  await f.run(['--notify','--date','2026-10-30']); assert.equal(f.messages.length, 3);
  f.deps.collectors.workspace = async () => ok([{ primaryEmail: f.member.email }]);
  await f.run(['--notify']); assert.equal(f.messages.length, 3);
});
test('通知失敗は抑止記録にせず再送', async t => {
  const f = fixture(t); f.deps.notify = async () => ({ delivered: 'none' });
  assert.equal((await f.run(['--notify'])).code, 1);
  f.deps.notify = async body => { f.messages.push(body); return { delivered: 'dm' }; };
  await f.run(['--notify']); assert.equal(f.messages.length, 1);
});
test('apply: 正本と台帳更新・rm/add production/preview stdin・ledger-sync・再デプロイなし', async t => {
  const f = fixture(t); const { code, result } = await f.run(['--apply-revoke']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'knowledge-revoked-pcs.json'))), ['old-PC','retired-PC']);
  const member = JSON.parse(fs.readFileSync(path.join(f.home,'claude-account-ledger.json'))).members[0];
  assert.equal(member.status, 'retired'); assert.equal(member.retiredOn, '2026-10-29');
  assert.equal(f.calls.length, 8);
  for (const [i, name] of ['ORGIAST_REVOKED_PCS','KNOWLEDGE_LEDGER_JSON'].entries()) for (const [j,target] of ['production','preview'].entries()) {
    const idx = i*4+j*2;
    assert.deepEqual(f.calls[idx].args, ['env','rm',name,target,'-y']);
    assert.deepEqual(f.calls[idx+1].args, ['env','add',name,target,'--sensitive']);
    assert.equal(f.calls[idx+1].opts.cwd, '/keyserve');
  }
  assert.deepEqual(JSON.parse(f.calls[1].input), ['old-PC','retired-PC']);
  assert.deepEqual(JSON.parse(f.calls[5].input).retiredEmails, ['alias@orgiast.jp','retired@orgiast.jp']);
  assert.match(result.actions.join(' '), /次回デプロイまで効きません/);
  await f.run(['--apply-revoke']); assert.equal(f.calls.length, 16, '失敗からの復旧も含め毎回同期');
});
test('部分反映失敗は未完了と記録・秘密stdout非出力・壊れた正本を上書きしない', async t => {
  const f = fixture(t); f.deps.ledgerSync = async () => { throw Error('secret-token'); };
  const { result, code } = await f.run(['--apply-revoke']);
  assert.equal(code, 1); assert.match(result.actions.join(' '), /未完了/); assert.ok(!f.output.includes('secret-token'));
  f.write('knowledge-revoked-pcs.json', {}); f.calls.length = 0;
  await f.run(['--apply-revoke']); assert.equal(f.calls.length, 0);
});
test('Directory/AdminページングとHTTP失敗、認可スコープ/subject', async () => {
  let n = 0;
  const workspace = await collectWorkspace({ env: {}, getToken: async opts => {
    assert.equal(opts.impersonate, 'kim@orgiast.jp'); assert.match(opts.scope, /admin.directory.user.readonly$/); return 'token';
  }, fetch: async url => {
    n++; if (n === 2) assert.equal(url.searchParams.get('pageToken'), 'next');
    return { ok: true, json: async () => ({ users: [{ primaryEmail: `u${n}@orgiast.jp` }], ...(n === 1 ? { nextPageToken: 'next' } : {}) }) };
  } });
  assert.equal(workspace.count, 2);
  n = 0;
  const ctx = { home: '/nonexistent', env: { ANTHROPIC_ADMIN_KEY: 'secret-key' }, fetch: async (url,opts) => {
    assert.equal(opts.headers['x-api-key'], 'secret-key'); n++;
    if (n === 2) assert.equal(url.searchParams.get('after_id'), 'u1');
    return { ok: true, json: async () => ({ data: [{ email: `u${n}@orgiast.jp` }], has_more: n === 1, last_id: 'u1' }) };
  } };
  assert.equal((await collectClaude(ctx)).count, 2);
  for (const status of [401,403,404]) {
    ctx.fetch = async () => ({ ok: false, status });
    assert.match((await collectClaude(ctx)).reason, new RegExp(`HTTP ${status}`));
  }
  const denied = await collectWorkspace({ env: {}, getToken: async opts => { await opts.fetchImpl('token'); throw Error('secret'); }, fetch: async () => ({ ok:false,status:401 }) });
  assert.match(denied.reason, /HTTP 401.*DWD/);
});
test('fleetは実ログインemailを読む・ID不足を明示・JST変換', async () => {
  const result = await collectFleet({ home:'/nonexistent', env:{ FLEET_SHEET_URL:'https://example.test',FLEET_SHEET_TOKEN:'secret' }, fetch:async () => ({ ok:true,json:async()=>({ok:true,rows:[{label:'PC',claudeAccount:'user@orgiast.jp',reportedAt:'2026/10/29 07:10:00'}]}) }) });
  assert.equal(result.status, 'ok'); assert.equal(result.data[0].email,'user@orgiast.jp');
  assert.equal(result.keyserveIds.status,'unavailable');
  assert.equal(fleetTime('2026/10/29 07:10:00'),'2026-10-28T22:10:00.000Z');
});
test('定期登録はkim-PC Windowsだけ', () => {
  let calls=0; const spawnImpl=()=>{calls++;return {status:0,stdout:''};};
  register({platform:'linux',label:'kim-PC',spawnImpl}); register({platform:'win32',label:'other-PC',spawnImpl}); assert.equal(calls,0);
  register({platform:'win32',label:'kim-PC',spawnImpl}); assert.equal(calls,1);
  const source=fs.readFileSync(new URL('./register-offboarding-watch.ps1',import.meta.url),'utf8');
  assert.match(source, /07:10/); assert.match(source, /'--notify', '--apply-revoke'/); assert.match(source, /--is-controller/);
});

test('既存notify-kimのDM配信関数で本文・承認事項・未取得を保持する', async t => {
  const f = fixture(t), sent = [];
  delete f.deps.notify;
  fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude/orgiast-discord-bot-token.txt'), 'secret-test-token');
  f.deps.collectors.workspace = async () => ({ status: 'unavailable', reason: 'HTTP 401 unauthorized_client', data: [] });
  f.member.status = 'retired'; f.write('claude-account-ledger.json', f.ledger);
  f.deps.fetch = async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ id: 'mock-id' }) };
  };
  const { result, code } = await f.run(['--notify']);
  assert.equal(code, 0); assert.equal(result.notification.status, 'sent');
  assert.equal(sent.length, 2);
  assert.match(sent[1].body.content, /未取得: workspace（HTTP 401 unauthorized_client）/);
  assert.match(sent[1].body.content, /Claude 組織からの削除・Workspace 停止を承認/);
  assert.doesNotMatch(f.output, /secret-test-token/);
});
