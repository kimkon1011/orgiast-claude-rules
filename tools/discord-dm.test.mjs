import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIndex } from './onboarding-sync.mjs';
import { main, sendDiscordDm } from './discord-dm.mjs';

const recipient = { id: '123456789', label: '百瀬' };
const resolve = async () => recipient;
const response = ({ ok = true, status = 200, json = {} } = {}) => ({ ok, status, json: async () => json });

test('DMチャンネル作成から本文投稿まで2回だけ呼ぶ', async () => {
  const calls = [];
  const result = await sendDiscordDm('百瀬', 'hello', {
    token: 'test-token', resolve, plainJaImpl: async (text) => text,
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
    token: 'test-token', resolve,
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
    dryRun: true, resolve, plainJaImpl: async (text) => text,
    fetchImpl: async () => { fetches += 1; throw new Error('unexpected fetch'); },
  });
  assert.equal(fetches, 0);
  assert.deepEqual(result, { dryRun: true, recipient, content: 'preview', copyToKim: 'skipped' });
});

test('相手への送信後に金功勇へ写しを送る', async () => {
  const kim = { id: 'kim-id', label: '金功勇' };
  const calls = [];
  const result = await sendDiscordDm('百瀬', '連絡本文', {
    token: 'test-token', resolve: async target => target === '金功勇' ? kim : recipient,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith('/users/@me/channels')) return response({ json: { id: calls.length < 3 ? 'main-dm' : 'kim-dm' } });
      return response();
    },
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2].body, { recipient_id: kim.id });
  assert.equal(calls[3].body.content, '【写し】百瀬さんへ送った内容\n\n連絡本文');
  assert.equal(result.copyToKim.delivered, true);
});

test('相手が金功勇本人なら写しを送らない', async () => {
  const calls = [];
  const kim = { id: 'kim-id', label: '金功勇' };
  const result = await sendDiscordDm('金功勇', '本文', {
    token: 'test-token', resolve: async () => kim,
    fetchImpl: async (url) => { calls.push(url); return calls.length === 1 ? response({ json: { id: 'dm' } }) : response(); },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.copyToKim, 'skipped');
});

test('金功勇本人へのPRマージ依頼は送信せずblockedを返す', async () => {
  const kim = { id: 'kim-id', label: '金功勇' };
  let fetches = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await sendDiscordDm('金功勇', 'PR #943 をマージしてください', {
      token: 'test-token', resolve: async () => kim,
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
    const options = { token: 'test-token', resolve: async () => kim };
    assert.equal(await main(['金功勇', '--body', 'PR #943 をマージしてください'], {
      ...options, fetchImpl: async () => { throw new Error('unexpected fetch'); },
    }), 3);
    const calls = [];
    assert.equal(await main(['金功勇', '--body', 'PR #943 をマージしてください', '--kim-action-required'], {
      ...options,
      fetchImpl: async () => { calls.push(1); return calls.length === 1 ? response({ json: { id: 'dm' } }) : response(); },
    }), 0);
    assert.equal(calls.length, 2);
  } finally { console.log = originalLog; console.error = originalError; }
});

test('--no-copy-kim は写し先を解決せず送らない', async () => {
  const targets = [];
  const calls = [];
  const code = await main(['百瀬', '--body', '本文', '--no-copy-kim'], {
    token: 'test-token', resolve: async target => { targets.push(target); return recipient; },
    fetchImpl: async () => { calls.push(1); return calls.length === 1 ? response({ json: { id: 'dm' } }) : response(); },
  });
  assert.equal(code, 0);
  assert.deepEqual(targets, ['百瀬']);
  assert.equal(calls.length, 2);
});

test('金功勇への写し失敗でも本送信はexit 0', async () => {
  const kim = { id: 'kim-id', label: '金功勇' };
  const originalLog = console.log;
  let output;
  console.log = value => { output = value; };
  try {
    let call = 0;
    const code = await main(['百瀬', '--body', '本文'], {
      token: 'test-token', resolve: async target => target === '金功勇' ? kim : recipient,
      fetchImpl: async (_url) => {
        call++;
        if (call === 1) return response({ json: { id: 'main-dm' } });
        if (call === 3) return response({ ok: false, status: 500 });
        return response();
      },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(output).copyToKim.delivered, false);
  } finally { console.log = originalLog; }
});

test('宛先不明・曖昧はexit 3で送信しない', async () => {
  let fetches = 0;
  const originalLog = console.log; const originalError = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const code = await main(['同姓', '--body', 'test'], {
      token: 'test-token', resolve: async () => null, plainJaImpl: async (text) => text,
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
    token: 'test-token', resolve, plainJaImpl: async (text) => text,
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
  const prefix = '**🔴 kim への Discord DM';
  const rule = body.split(/\r?\n/).find((line) => line.startsWith(prefix));
  assert.ok(rule);
  assert.ok(index.some(line => line.startsWith(prefix)));
  assert.ok(!index.some(line => line.startsWith('**🔴 社内メンバー')));
});
