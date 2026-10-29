import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listItems } from './kim-inbox.mjs';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-inbox-'));
fs.mkdirSync(path.join(home, '.claude'));
fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
import { fileURLToPath } from 'node:url';
import { makeIndex } from './onboarding-sync.mjs';
import { main, sendDiscordDm } from './discord-dm.mjs';

const recipient = { id: '123456789', label: '百瀬' };
const resolve = async () => recipient;
const response = ({ ok = true, status = 200, json = {} } = {}) => ({ ok, status, json: async () => json });

test('DMチャンネル作成から本文投稿まで2回だけ呼ぶ', async () => {
  const calls = [];
  const result = await sendDiscordDm('百瀬', 'hello', {
    home, token: 'test-token', resolve, plainJaImpl: async (text) => text,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? response({ json: { id: 'dm-channel' } }) : response();
    },
  });
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /users\/@me\/channels$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient_id: recipient.id });
  assert.match(calls[1].url, /channels\/dm-channel\/messages$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { content: 'hello' });
});

test('本文は書き換えず、そのまま送る（LLM平易化を通さない）', async () => {
  const bodies = [];
  await sendDiscordDm('百瀬', 'dry-run 検証: 上記の件、ご確認ください', {
    home, token: 'test-token', resolve,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
    },
  });
  assert.equal(bodies[1].content, 'dry-run 検証: 上記の件、ご確認ください');
});

test('dry-runはfetchゼロで解決結果と本文を返す', async () => {
  let fetches = 0;
  const result = await sendDiscordDm('百瀬', 'preview', {
    home, dryRun: true, resolve, plainJaImpl: async (text) => text,
    fetchImpl: async () => { fetches += 1; throw new Error('unexpected fetch'); },
  });
  assert.equal(fetches, 0);
  assert.deepEqual(result, { dryRun: true, recipient, content: 'preview', copyToKim: 'in-session' });
});

test('kim 席の写しは会話で回収し Discord に送らない', async () => {
  const kim = { id: 'kim-id', label: '金功勇' };
  const calls = [];
  const result = await sendDiscordDm('百瀬', '連絡本文', {
    home, token: 'test-token', resolve: async target => target === '金功勇' ? kim : recipient,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith('/users/@me/channels')) return response({ json: { id: calls.length < 3 ? 'main-dm' : 'kim-dm' } });
      return response();
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.copyToKim, 'in-session');
});

test('相手が金功勇本人なら写しを送らない', async () => {
  const calls = [];
  const kim = { id: 'kim-id', label: '金功勇' };
  const result = await sendDiscordDm('金功勇', '本文', {
    home, token: 'test-token', resolve: async () => kim,
    fetchImpl: async (url) => { calls.push(url); return calls.length === 1 ? response({ json: { id: 'dm' } }) : response(); },
  });
  assert.equal(calls.length, 0);
  assert.equal(result.delivered, 'session-inbox');
  assert.equal(listItems(home).find(i => i.id === result.id).kind, 'info');
  assert.equal(result.copyToKim, 'skipped');
});

test('金功勇本人へのPRマージ依頼は送信せずblockedを返す', async () => {
  const kim = { id: 'kim-id', label: '金功勇' };
  let fetches = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await sendDiscordDm('金功勇', 'PR #943 をマージしてください', {
      home, token: 'test-token', resolve: async () => kim,
      fetchImpl: async () => { fetches += 1; throw new Error('unexpected fetch'); },
    });
    assert.equal(result.delivered, 'blocked');
    assert.equal(result.category, 'merge-request');
    assert.equal(fetches, 0);
  } finally { console.error = originalError; }
});

test('discord-dm CLIはblockedでexit 3、明示例外なら送信する', async () => {
  const kim = { id: 'kim-id', label: '金功勇' };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const options = { home, token: 'test-token', resolve: async () => kim };
    assert.equal(await main(['金功勇', '--body', 'PR #943 をマージしてください'], {
      ...options, fetchImpl: async () => { throw new Error('unexpected fetch'); },
    }), 3);
    const calls = [];
    assert.equal(await main(['金功勇', '--body', 'PR #943 をマージしてください', '--kim-action-required'], {
      ...options, allowlist: [{ category: 'test', pattern: '.' }],
      fetchImpl: async () => { calls.push(1); return calls.length === 1 ? response({ json: { id: 'dm' } }) : response(); },
    }), 0);
    assert.equal(calls.length, 2);
  } finally { console.log = originalLog; console.error = originalError; }
});

test('--no-copy-kim は写し先を解決せず送らない', async () => {
  const targets = [];
  const calls = [];
  const code = await main(['百瀬', '--body', '本文', '--no-copy-kim'], {
    home, token: 'test-token', resolve: async target => { targets.push(target); return recipient; },
    fetchImpl: async () => { calls.push(1); return calls.length === 1 ? response({ json: { id: 'dm' } }) : response(); },
  });
  assert.equal(code, 0);
  assert.deepEqual(targets, ['百瀬']);
  assert.equal(calls.length, 2);
});

test('kim 席で写しの追加送信なしでも本送信はexit 0', async () => {
  const kim = { id: 'kim-id', label: '金功勇' };
  const originalLog = console.log;
  let output;
  console.log = value => { output = value; };
  try {
    let call = 0;
    const code = await main(['百瀬', '--body', '本文'], {
      home, token: 'test-token', resolve: async target => target === '金功勇' ? kim : recipient,
      fetchImpl: async (_url) => {
        call++;
        if (call === 1) return response({ json: { id: 'main-dm' } });
        if (call === 3) return response({ ok: false, status: 500 });
        return response();
      },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(output).copyToKim, 'in-session');
  } finally { console.log = originalLog; }
});

test('宛先不明・曖昧はexit 3で送信しない', async () => {
  let fetches = 0;
  const originalLog = console.log; const originalError = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const code = await main(['同姓', '--body', 'test'], {
      home, token: 'test-token', resolve: async () => null, plainJaImpl: async (text) => text,
      fetchImpl: async () => { fetches += 1; },
    });
    assert.equal(code, 3); assert.equal(fetches, 0);
  } finally { console.log = originalLog; console.error = originalError; }
});

test('トークン無しはexit 2で送信しない', async () => {
  let fetches = 0;
  const originalLog = console.log; const originalError = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const code = await main(['百瀬', '--body', 'test'], {
      token: '', resolve, plainJaImpl: async (text) => text,
      fetchImpl: async () => { fetches += 1; },
    });
    assert.equal(code, 2); assert.equal(fetches, 0);
  } finally { console.log = originalLog; console.error = originalError; }
});

test('送信本文からAPIキーとAuthorization付きURLを除去する', async () => {
  const bodies = [];
  await sendDiscordDm('百瀬', 'key sk-abcdefghijklmnopqr https://example.test/a?Authorization=secret-value', {
    home, token: 'test-token', resolve, plainJaImpl: async (text) => text,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
    },
  });
  assert.doesNotMatch(bodies[1].content, /sk-abcdefghijklmnopqr|secret-value/);
  assert.match(bodies[1].content, /\[REDACTED\]/);
});

test('新しい絶対ルール行はmakeIndexの出力に全文残る', () => {
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const body = fs.readFileSync(path.join(repo, 'ONBOARDING.md'), 'utf8');
  const index = makeIndex(body).split('\n');
  const prefix = '**🔴 社内連絡はDiscord';
  const rule = body.split(/\r?\n/).find((line) => line.startsWith(prefix));
  assert.ok(rule);
  assert.ok(index.includes(rule));
  assert.match(rule, /kim宛報告=kim-inbox.*PRマージ\/他PC依頼=fleet-mail/);
});

test('kim 宛 dry-run は台帳にも Discord にも書き込まない', async () => {
  const before = listItems(home).length;
  const result = await sendDiscordDm('kim', '判断', { home, dryRun: true, resolve: async () => ({ id: '715210673642012733', label: 'kim' }), fetchImpl: async () => assert.fail('送信禁止') });
  assert.equal(result.delivered, 'session-inbox'); assert.equal(listItems(home).length, before);
});
test('非 kim 席の写しは転送失敗でもローカル台帳へ残す', async t => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-remote-'));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  fs.mkdirSync(path.join(remote, '.claude'));
  fs.writeFileSync(path.join(remote, '.claude/cost-reporter.env'), 'REPORTER_LABEL=test-PC');
  fs.writeFileSync(path.join(remote, '.claude/fleet-pc-map.json'), JSON.stringify({ 'test-PC': { account: 'test@example.test' } }));
  let calls = 0;
  const result = await sendDiscordDm('百瀬', '報告本文', { home: remote, token: 'test', resolve, fetchImpl: async () => { calls++; return response({ json: { id: 'dm' } }); } });
  assert.equal(calls, 2); assert.equal(result.copyToKim.delivered, 'session-inbox');
  const item = listItems(remote)[0]; assert.equal(item.kind, 'info'); assert.match(item.text, /（写し）百瀬 へ送信: 報告本文/);
  assert.equal(item.status, 'open'); assert.ok(item.forwardError);
});
