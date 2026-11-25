import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkAnyoneOnDrive, judge, HOOK_MATCHER, checkExternalLinks, assertExternalLinks, externalBodyFileMain } from './share-before-send-gate.mjs';
import { assertCuramaLinks } from './curama-share-gate-adapter.mjs';
const url = 'https://docs.google.com/document/d/file123/edit';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-gate-'));
  t.after(() => { if (process.env.KEEP_TEST_ARTIFACTS !== '1') fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, '.claude'));
  const ledgerPath = path.join(dir, '.claude/share-ledger.jsonl'); fs.writeFileSync(ledgerPath, '');
  const offlinePath = path.join(dir, 'offline.mjs');
  fs.writeFileSync(offlinePath, "globalThis.fetch = async () => new Response('', { status: 403 });\n");
  return { dir, ledgerPath, offlinePath, checkExternal: async () => ({ decision: 'block', checks: [] }) };
}
const message = (body = url) => ({ tool_name: 'mcp__claude_ai_Discord__send_dm', tool_input: { recipient_id: 'other', content: body } });
test('Google Forms public response URL passes without share evidence', async t => {
  const opts = fixture(t);
  const formsUrl = 'https://docs.google.com/forms/d/e/1FAIpQLScJdyNl1ryrNXvshdF1yVaOjDueiWmObdcPVydj1m-DhPjWTw/viewform?usp=pp_url&entry.1172257432=abc';
  assert.equal((await judge(message(formsUrl), opts)).decision, 'pass');
  // 通常のフォーム編集URLは引き続きブロック対象
  assert.equal((await judge(message('https://docs.google.com/forms/d/1x29rPbBs6ha4FU2w3_JKFdL7p88tkIY31l1_DP1j3qY/edit'), opts)).decision, 'block');
});
test('no link passes; Google link without evidence blocks', async t => {
  const opts = fixture(t);
  assert.equal((await judge(message('hello'), opts)).decision, 'pass');
  assert.equal((await judge(message(), opts)).decision, 'block');
  assert.match((await judge(message(), opts)).reason, /--id file123 --to/);
  assert.match((await judge(message(), opts)).reason, /--to syain@orgiast\.jp で全社員に共有/);
});
test('recent ledger passes, old or future timestamps do not', async t => {
  const opts = fixture(t);
  for (const [age, decision] of [[0, 'pass'], [30 * 86400000, 'pass'], [31 * 86400000, 'block'], [-1000, 'block']]) {
    const now = Date.now(); fs.writeFileSync(opts.ledgerPath, JSON.stringify({ ts: new Date(now - age).toISOString(), fileId: 'file123', emails: ['a@example.com'], role: 'commenter' }));
    assert.equal((await judge(message(), { ...opts, now })).decision, decision);
  }
});
test('all linked files need evidence', async t => {
  const opts = fixture(t);
  fs.writeFileSync(opts.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), fileId: 'file123', emails: ['a@example.com'] }));
  assert.equal((await judge(message(url + ' https://drive.google.com/file/d/other/view'), opts)).decision, 'block');
});
test('transcript share_file or share CLI tool calls pass, prose and dry run do not', async t => {
  const opts = fixture(t); const transcript_path = path.join(opts.dir, 'transcript');
  for (const [block, decision] of [
    [{ type: 'tool_use', name: 'mcp__claude_ai_Google_Drive__share_file', input: { file_id: 'file123', email: 'a@example.com' } }, 'pass'],
    [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/drive-share.mjs --id file123 --to a@example.com' } }, 'pass'],
    [{ type: 'tool_use', name: 'PowerShell', input: { command: 'node tools/gdoc-publish.mjs --update file123 --share a@example.com' } }, 'pass'],
    [{ type: 'text', text: 'mcp__claude_ai_Google_Drive__share_file file123' }, 'block'],
    [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/drive-share.mjs --id file123 --to a@example.com --dry' } }, 'block'],
  ]) {
    fs.writeFileSync(transcript_path, JSON.stringify({ type: 'assistant', message: { content: [block] } }));
    assert.equal((await judge({ ...message(), transcript_path }, opts)).decision, decision);
  }
});
test('Bash and PowerShell body-file paths including spaces and relative cwd block', async t => {
  const opts = fixture(t); fs.writeFileSync(path.join(opts.dir, 'body text.txt'), url);
  for (const tool_name of ['Bash', 'PowerShell']) {
    const input = { tool_name, cwd: opts.dir, tool_input: { command: 'node tools/discord-dm.mjs user --body-file "body text.txt"' } };
    assert.equal((await judge(input, opts)).decision, 'block');
    input.tool_input.command = 'node tools/discord-dm.mjs user --body-file="body text.txt"';
    assert.equal((await judge(input, opts)).decision, 'block');
  }
});
test('all requested tools match and self-only Gmail passes', async t => {
  const opts = fixture(t);
  for (const name of ['mcp__claude_ai_Discord_1__reply_message', 'mcp__claude_ai_Discord__send_message', 'mcp__claude_ai_Gmail__forward', 'mcp__claude_ai_Gmail_2__update_draft', 'Bash', 'PowerShell']) assert.match(name, new RegExp(`^(?:${HOOK_MATCHER})$`));
  const input = { tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: 'kim@orgiast.jp', body: url } };
  assert.equal((await judge(input, opts)).decision, 'pass');
  input.tool_input.cc = 'other@example.com'; assert.equal((await judge(input, opts)).decision, 'block');
});
test('CLI malformed input and missing body file fail open; malformed or missing ledger still denies', t => {
  const opts = fixture(t);
  const run = (input, home = opts.dir) => spawnSync(process.execPath, ['--import', pathToFileURL(opts.offlinePath).href, 'tools/share-before-send-gate.mjs'], { input, encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } });
  for (const raw of ['{broken', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node tools/discord-dm.mjs user --body-file /does-not-exist' } })]) {
    const result = run(raw); assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim().split('\n').length, 1);
  }
  fs.writeFileSync(opts.ledgerPath, 'bad json');
  const deny = r => JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  assert.equal(deny(run(JSON.stringify(message()))), 'deny');
  assert.equal(deny(run(JSON.stringify(message()), path.join(opts.dir, 'no-ledger'))), 'deny');
});
test('CLI emits PreToolUse denial', t => {
  const opts = fixture(t);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(opts.offlinePath).href, 'tools/share-before-send-gate.mjs'], { input: JSON.stringify(message()), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: opts.dir } });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
// ── anyone-link check tests ──
test('anyone-public file passes with checkAnyone returning true', async t => {
  const opts = fixture(t);
  const r = await judge(message(), { ...opts, checkAnyone: async () => true });
  assert.equal(r.decision, 'pass');
  // 台帳に anyone-with-link が記録されている
  const ledger = fs.readFileSync(opts.ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(ledger.some(e => e.fileId === 'file123' && e.emails.includes('anyone-with-link') && e.via === 'anyone-link-check'));
});
test('non-public file blocks with checkAnyone returning false', async t => {
  const opts = fixture(t);
  const r = await judge(message(), { ...opts, checkAnyone: async () => false });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /--id file123 --to/);
});
test('checkAnyone failure blocks with failure reason', async t => {
  const opts = fixture(t);
  const r = await judge(message(), { ...opts, checkAnyone: async () => { throw new Error('API error'); } });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /リンク公開かの確認に失敗/);
});
test('DWD owner permissions success passes using the owner subject', async t => {
  const opts = fixture(t);
  const subjects = [];
  const fetchImpl = async url => url.includes('/permissions?')
    ? Response.json({ permissions: [{ type: 'anyone', role: 'reader' }] })
    : Response.json({ owners: [{ emailAddress: 'owner@orgiast.jp' }] });
  const checkAnyone = id => checkAnyoneOnDrive(id, {
    getToken: async ({ impersonate }) => { subjects.push(impersonate); return 'token'; }, fetchImpl,
  });
  assert.equal((await judge(message(), { ...opts, checkAnyone })).decision, 'pass');
  assert.deepEqual(subjects, ['seisaku-team@orgiast.jp', 'owner@orgiast.jp']);
});
test('DWD failure and anonymous success passes', async t => {
  const opts = fixture(t);
  const fetchImpl = async url => url.startsWith('https://www.googleapis.com/')
    ? new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 })
    : new Response('', { status: url.includes('/file/d/') ? 200 : 404 });
  const checkAnyone = id => checkAnyoneOnDrive(id, { getToken: async () => 'token', fetchImpl });
  assert.equal((await judge(message(), { ...opts, checkAnyone })).decision, 'pass');
});
test('all methods failure blocks and exposes HTTP statuses', async t => {
  const opts = fixture(t);
  const fetchImpl = async url => new Response('', { status: url.includes('googleapis.com') ? 403 : 404 });
  const checkAnyone = id => checkAnyoneOnDrive(id, { getToken: async () => 'token', fetchImpl });
  const r = await judge(message(), { ...opts, checkAnyone });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /dwd-files\.get=HTTP 403/);
  assert.match(r.reason, /anonymous-file=HTTP 404/);
  assert.match(r.reason, /anonymous-folder=HTTP 404/);
});

test('owner confirms limited file returns false and blocks', async t => {
  const opts = fixture(t);
  const fetchImpl = async url => {
    assert.ok(url.startsWith('https://www.googleapis.com/'));
    return Response.json(url.includes('/permissions?')
      ? { permissions: [{ type: 'user', role: 'owner' }, { type: 'group', role: 'reader' }] }
      : { owners: [{ emailAddress: 'seisaku-team@orgiast.jp' }] });
  };
  const checkAnyone = id => checkAnyoneOnDrive(id, { getToken: async () => 'token', fetchImpl });
  assert.equal(await checkAnyone('file123'), false);
  assert.equal((await judge(message(), { ...opts, checkAnyone })).decision, 'block');
});

test('permissions 403 falls back to anonymous folder without credentials or redirects', async () => {
  const fetchImpl = async (url, options) => {
    if (url.includes('/permissions?')) return new Response('', { status: 403 });
    if (url.startsWith('https://www.googleapis.com/')) return Response.json({ owners: [{ emailAddress: 'owner@orgiast.jp' }] });
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'manual');
    return url.includes('/file/d/')
      ? new Response('', { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin' } })
      : new Response('', { status: 200 });
  };
  assert.equal(await checkAnyoneOnDrive('file123', { getToken: async () => 'token', fetchImpl }), true);
});

test('GWS failures retain HTTP status and login locations do not pass even with 200', async t => {
  const opts = fixture(t);
  const checkAnyone = id => checkAnyoneOnDrive(id, {
    getToken: async () => 'orgiast-server-side-gws',
    apiFetch: async () => { throw Object.assign(new Error('channel gws: HTTP 403'), { status: 403 }); },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers, undefined);
      return new Response('', { status: 200, headers: { location: 'https://accounts.google.com/ServiceLogin' } });
    },
  });
  const result = await judge(message(), { ...opts, checkAnyone });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /dwd-files\.get=HTTP 403/);
});

test('token endpoint HTTP status survives token error without leaking its message', async () => {
  await assert.rejects(checkAnyoneOnDrive('file123', {
    getToken: async ({ fetchImpl, signal }) => {
      await fetchImpl('https://oauth2.googleapis.com/token', { signal });
      throw new Error('sensitive token response');
    },
    fetchImpl: async url => new Response('', { status: url.includes('oauth2') ? 401 : 404 }),
  }), error => {
    assert.match(error.message, /reader-token=HTTP 401/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('one deadline covers token and subsequent requests and blocks on timeout', async t => {
  const opts = fixture(t);
  let sharedSignal;
  const checkAnyone = id => checkAnyoneOnDrive(id, {
    timeoutMs: 20,
    getToken: async ({ signal }) => { sharedSignal = signal; return 'token'; },
    fetchImpl: async (_url, { signal }) => {
      assert.equal(signal, sharedSignal);
      signal.throwIfAborted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const result = await judge(message(), { ...opts, checkAnyone });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /dwd-files\.get=timeout/);
  assert.match(result.reason, /anonymous-folder=timeout/);
});

const pdfUrl = 'https://drive.google.com/file/d/pdf123/view';
function externalMocks({ mime = 'application/pdf', permissions = [{ type: 'anyone', role: 'reader', allowFileDiscovery: false }], anonymous, apiStatus = 200 } = {}) {
  return {
    getToken: async () => 'private-api-token',
    apiFetch: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer private-api-token');
      if (apiStatus !== 200) return new Response('', { status: apiStatus });
      return Response.json(url.includes('/permissions?') ? { permissions } : { mimeType: mime, owners: [{ emailAddress: 'seisaku-team@orgiast.jp' }] });
    },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers, undefined);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'manual');
      return anonymous ? anonymous(url, options) : new Response('<title>File - Google Drive</title>', { headers: { 'content-type': 'text/html' } });
    },
  };
}
test('external Google native documents and PDF pass all three checks', async () => {
  for (const mime of ['application/pdf', 'application/vnd.google-apps.presentation', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.document']) {
    assert.equal((await checkExternalLinks(pdfUrl, externalMocks({ mime }))).decision, 'pass');
  }
});
test('external Office and shortcut MIME types block', async () => {
  for (const mime of ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword', 'application/vnd.google-apps.shortcut', undefined]) {
    const deps = externalMocks({ mime: mime ?? 'unknown' });
    deps.fetchImpl = async () => { assert.fail('must block before anonymous fetch'); };
    assert.equal((await checkExternalLinks(pdfUrl, deps)).decision, 'block');
  }
});
test('each URL is checked even for the same file; Office rendering/exports are blocked', async () => {
  for (const suffix of ['?rtpof=true', '?rtpof=TRUE', '/export/pptx', '?exportFormat=xlsx', '?format=docx']) {
    const result = await checkExternalLinks(`${pdfUrl}\n${pdfUrl}${suffix}`, externalMocks());
    assert.equal(result.decision, 'block'); assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].ok, true); assert.equal(result.checks[1].ok, false);
  }
});
test('individual, domain, public-writer and discoverable shares cannot pass external gate', async () => {
  for (const permissions of [[], [{ type: 'user', role: 'reader' }], [{ type: 'domain', role: 'reader' }], [{ type: 'anyone', role: 'writer', allowFileDiscovery: false }], [{ type: 'anyone', role: 'reader', allowFileDiscovery: true }]]) {
    assert.match((await checkExternalLinks(pdfUrl, externalMocks({ permissions }))).reason, /anyoneWithLink reader/);
  }
});
test('permission API errors fail closed even if anonymous HTTP would succeed', async () => {
  const deps = externalMocks({ apiStatus: 403 });
  deps.fetchImpl = async () => assert.fail('no anonymous fallback for missing metadata/permissions');
  assert.match((await checkExternalLinks(pdfUrl, deps)).reason, /HTTP 403/);
});
test('anonymous non-200, login redirect and 200 login page all block', async () => {
  for (const response of [
    () => new Response('', { status: 403 }),
    () => new Response('', { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin' } }),
    () => new Response('', { status: 200, headers: { location: 'https://accounts.google.com/ServiceLogin' } }),
    () => new Response('<title>Sign in - Google Accounts</title>'),
    () => new Response('<form action="https://accounts.google.com/ServiceLogin"></form>'),
  ]) assert.equal((await checkExternalLinks(pdfUrl, externalMocks({ anonymous: response }))).decision, 'block');
});
test('normal viewer sign-in link does not make a public document a login page', async () => {
  const anonymous = () => new Response('<title>Proposal - Google Drive</title><a href="https://accounts.google.com/ServiceLogin">Sign in</a>');
  assert.equal((await checkExternalLinks(pdfUrl, externalMocks({ anonymous }))).decision, 'pass');
});
test('anonymous redirect chain stays credential-free and rejects non-Google/loops', async () => {
  const target = 'https://drive.usercontent.google.com/download?id=pdf123';
  const anonymous = url => url === pdfUrl ? new Response('', { status: 302, headers: { location: target } }) : new Response('%PDF-test', { headers: { 'content-type': 'application/pdf' } });
  const pass = await checkExternalLinks(pdfUrl, externalMocks({ anonymous }));
  assert.equal(pass.decision, 'pass'); assert.equal(pass.checks[0].finalUrl, target);
  for (const location of ['https://example.com', pdfUrl]) {
    assert.equal((await checkExternalLinks(pdfUrl, externalMocks({ anonymous: () => new Response('', { status: 302, headers: { location } }) }))).decision, 'block');
  }
});
test('owner permission pagination checks every page', async () => {
  const subjects = [];
  const deps = externalMocks();
  deps.getToken = async ({ impersonate }) => { subjects.push(impersonate); return 'token'; };
  deps.apiFetch = async url => Response.json(!url.includes('/permissions?') ? { mimeType: 'application/pdf', owners: [{ emailAddress: 'owner@orgiast.jp' }] } : url.includes('pageToken=next') ? { permissions: [{ type: 'anyone', role: 'reader', allowFileDiscovery: false }] } : { permissions: [{ type: 'user', role: 'owner' }], nextPageToken: 'next' });
  assert.equal((await checkExternalLinks(pdfUrl, deps)).decision, 'pass');
  assert.deepEqual(subjects, ['seisaku-team@orgiast.jp', 'owner@orgiast.jp']);
});
test('external timeout and secret-bearing errors block without exposing credentials', async () => {
  const deps = externalMocks();
  deps.getToken = async () => { throw Error('private-api-token'); };
  const result = await checkExternalLinks(pdfUrl, deps);
  assert.equal(result.decision, 'block'); assert.doesNotMatch(result.reason, /private-api-token/);
  const timeout = externalMocks({ anonymous: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  assert.match((await checkExternalLinks(pdfUrl, { ...timeout, timeoutMs: 20 })).reason, /タイムアウト/);
});
test('external gate bypasses stale ledger and checks all links in Gmail bodies', async t => {
  const opts = fixture(t);
  fs.writeFileSync(opts.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), fileId: 'pdf123', emails: ['anyone-with-link'] }));
  const input = { tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: 'client@example.com', body: `${pdfUrl}\n${url}` } };
  const seen = [];
  const result = await judge(input, { ...opts, checkExternal: text => { seen.push(text); return checkExternalLinks(text, externalMocks({ permissions: [] })); } });
  assert.equal(result.decision, 'block'); assert.equal(result.checks.length, 2); assert.equal(seen.length, 1);
});
test('external CLI exits nonzero for invalid file/links and does not send anything', async t => {
  const opts = fixture(t); const file = path.join(opts.dir, 'outbound.txt');
  fs.writeFileSync(file, pdfUrl);
  assert.equal(await externalBodyFileMain(['--external-body-file', file], externalMocks()), 0);
  assert.equal(await externalBodyFileMain(['--external-body-file', file], externalMocks({ permissions: [] })), 2);
  assert.equal(await externalBodyFileMain(['--external-body-file', path.join(opts.dir, 'missing')], externalMocks()), 2);
  await assert.rejects(assertExternalLinks(pdfUrl, externalMocks({ permissions: [] })), /SHARE-BEFORE-SEND/);
  assert.equal((await checkExternalLinks('本文だけ', { getToken: () => assert.fail('no API needed') })).decision, 'pass');
});
test('curama adapter reads the actual textarea and prevents the send continuation', async () => {
  let sent = false;
  const page = { locator(selector) { assert.equal(selector, 'textarea[placeholder="メッセージを入力"]'); return { inputValue: async () => pdfUrl }; } };
  await assert.rejects(async () => { await assertCuramaLinks(page, externalMocks({ permissions: [] })); sent = true; }, /anyoneWithLink/);
  assert.equal(sent, false);
  assert.equal((await assertCuramaLinks(page, externalMocks())).decision, 'pass');
});
test('external shell body files are checked and unreadable files fail closed', async t => {
  const opts = fixture(t); const file = path.join(opts.dir, 'external body.txt'); fs.writeFileSync(file, pdfUrl);
  for (const tool_name of ['Bash', 'PowerShell']) {
    const input = { tool_name, tool_input: { command: `node tools/gmail-draft.mjs --to client@example.com --body-file "${file}"` } };
    assert.equal((await judge(input, { ...opts, checkExternal: text => checkExternalLinks(text, externalMocks()) })).decision, 'pass');
    input.tool_input.command = 'node tools/gmail-draft.mjs --to client@example.com --body-file does-not-exist';
    assert.equal((await judge(input, opts)).decision, 'block');
  }
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(opts.offlinePath).href, 'tools/share-before-send-gate.mjs', '--external-body-file', file], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).decision, 'block');
});
