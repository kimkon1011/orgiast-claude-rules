import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GMAIL_COMPOSE_SCOPE, DEFAULT_USER, buildRawMessage, guardRecipients,
  renderChatDisplay, classifyTokenError, probeScopes, createDraft, deleteDraft, runCli,
} from './gmail-draft.mjs';

const ledger = { domains: ['orgiast.jp', 'toho-kogyo.com'], addresses: ['staff@gmail.com'] };
const input = { from: DEFAULT_USER, to: 'customer@example.com', subject: '制作のお見積り', body: 'こんにちは。\nよろしくお願いします。' };
const args = ['--to', input.to, '--subject', input.subject, '--body', input.body];
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

async function cli(argv, overrides = {}) {
  const output = [];
  let calls = 0;
  let tokens = 0;
  const code = await runCli({ argv, deps: {
    stdout: text => output.push(text), loadLedger: () => ledger,
    fetchImpl: async () => { calls++; throw new Error('unexpected fetch'); },
    getToken: async () => { tokens++; throw new Error('unexpected token'); },
    mintToken: async () => { tokens++; throw new Error('unexpected mint'); },
    ...overrides,
  } });
  return { code, output, calls, tokens };
}

test('MIME は CRLF、日本語 B エンコード、Cc は省略できる', () => {
  const raw = buildRawMessage(input);
  assert.match(raw, /^[A-Za-z0-9_-]+$/u);
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [headers, body] = decoded.split('\r\n\r\n');
  assert.deepEqual(headers.split('\r\n').map(s => s.split(':')[0]),
    ['From', 'To', 'Subject', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']);
  assert.match(headers, new RegExp(`From: ${DEFAULT_USER}\\r\\nTo: customer@example.com\\r\\nSubject: =\\?UTF-8\\?B\\?`));
  assert.equal(Buffer.from(headers.match(/=\?UTF-8\?B\?([^?]*)\?=/u)[1], 'base64').toString(), input.subject);
  assert.equal(Buffer.from(body, 'base64').toString(), input.body.replace(/\n/gu, '\r\n'));
  assert.equal(decoded.replace(/\r\n/gu, '').includes('\n'), false);
  assert.match(headers, /Content-Type: text\/plain; charset="UTF-8"/u);
  assert.match(headers, /Content-Transfer-Encoding: base64/u);
});

test('Cc と長い日本語件名・本文を折り返して復元できる', () => {
  const subject = '日本語😀'.repeat(50);
  const decoded = Buffer.from(buildRawMessage({ ...input, subject, cc: ['a@example.com', 'b@example.com'], body: 'あ'.repeat(200) }), 'base64url').toString();
  assert.match(decoded, /\r\nCc: a@example.com, b@example.com\r\nSubject:/u);
  const words = [...decoded.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/gu)];
  assert.ok(words.every(m => m[0].length <= 75));
  assert.equal(words.map(m => Buffer.from(m[1], 'base64').toString()).join(''), subject);
  assert.ok(decoded.split('\r\n\r\n')[1].split('\r\n').every(s => s.length <= 76));
});

test('内部ドメイン・個人 Gmail・Cc を既存の内部判定でブロック', () => {
  for (const fields of [{ to: 'STAFF@ORGIAST.JP' }, { to: 'staff@toho-kogyo.com' }, { to: 'staff@gmail.com' }, { cc: 'staff@orgiast.jp' }]) {
    const result = guardRecipients({ ...input, ...fields }, ledger);
    assert.equal(result.blocked, true);
    assert.ok(result.internal.length);
    assert.ok(result.chatDisplay.includes(input.subject));
    assert.ok(result.chatDisplay.includes(input.body));
  }
  assert.deepEqual(guardRecipients(input, ledger), { blocked: false, internal: [] });
  assert.equal(renderChatDisplay(input), `宛先：${input.to}\n用件：${input.subject}\n本文：\n${input.body}`);
});

test('ヘッダ注入や曖昧な宛先は拒否する', () => {
  for (const fields of [{ to: 'a@example.com\r\nBcc: staff@orgiast.jp' }, { cc: 'invalid' }, { subject: 'x\nBcc: staff@orgiast.jp' }, { from: 'a@example.com,b@example.com' }, { to: 'Name <a@example.com>' }]) {
    assert.throws(() => buildRawMessage({ ...input, ...fields }));
  }
});

test('トークンエラーを分類する', () => {
  for (const error of ['unauthorized_client', 'invalid_grant', 'invalid_client']) assert.equal(classifyTokenError({ error }), 'scope_not_delegated');
  for (const json of [{ error: 'unknown' }, {}, null]) assert.equal(classifyTokenError(json), 'error');
});

test('スコープごとの失敗を保持し後続も試す・秘密の例外は出力しない', async () => {
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly', GMAIL_COMPOSE_SCOPE, 'https://www.googleapis.com/auth/gmail.send'];
  const seen = [];
  const results = await probeScopes({ user: DEFAULT_USER, keyPath: 'unused', scopes, mintToken: async options => {
    seen.push(options);
    if (options.scope === GMAIL_COMPOSE_SCOPE) throw Object.assign(new Error('SECRET assertion'), { tokenError: true, detail: { error: 'unauthorized_client', error_description: 'SECRET access_token' } });
    return 'SECRET token';
  } });
  assert.deepEqual(results.map(r => r.ok), [true, false, true]);
  assert.equal(results[1].errorKind, 'scope_not_delegated');
  assert.deepEqual(seen.map(o => o.scope), scopes);
  assert.ok(seen.every(o => o.user === DEFAULT_USER && o.keyPath === 'unused'));
  assert.equal(JSON.stringify(results).includes('SECRET'), false);
});

test('下書き POST の URL・認証・raw・戻り値', async () => {
  let calls = 0;
  const result = await createDraft({ user: DEFAULT_USER, raw: 'RAW', getToken: async options => {
    assert.deepEqual(options, { user: DEFAULT_USER, scope: GMAIL_COMPOSE_SCOPE }); return 't';
  }, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer t');
    assert.deepEqual(JSON.parse(options.body), { message: { raw: 'RAW' } });
    return response({ id: 'draft', message: { id: 'message', threadId: 'thread' } });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { id: 'draft', messageId: 'message', threadId: 'thread' });
});

test('CLI の内部宛は通常・dry-run・JSON すべて認証も fetch もゼロ', async () => {
  for (const flags of [[], ['--dry-run'], ['--json'], ['--json', '--dry-run']]) {
    const result = await cli([...args, '--cc', 'staff@gmail.com', ...flags]);
    assert.equal(result.code, 3);
    assert.equal(result.calls, 0);
    assert.equal(result.tokens, 0);
    assert.equal(result.output.length, 1);
    if (flags.includes('--json')) {
      const report = JSON.parse(result.output[0]);
      assert.equal(report.action, 'chat-display');
      assert.equal(report.user, DEFAULT_USER);
      assert.deepEqual(report.internal, ['staff@gmail.com']);
      assert.ok(report.chatDisplay.includes(input.body));
    } else assert.ok(result.output[0].includes(input.body));
  }
});

test('dry-run はキーなしで raw とヘッダを返し user 指定も反映', async () => {
  for (const extra of [[], ['--user', 'shared@orgiast.jp']]) {
    const result = await cli([...args, '--dry-run', '--json', ...extra]);
    assert.equal(result.code, 0);
    assert.equal(result.calls + result.tokens, 0);
    const report = JSON.parse(result.output[0]);
    assert.equal(report.user, extra[1] ?? DEFAULT_USER);
    assert.ok(report.headers.includes(`From: ${report.user}`));
    assert.ok(report.raw);
  }
});

test('--check は3スコープの認証のみ。Gmail API を呼ばない', async () => {
  const seen = [];
  const result = await cli(['--check', '--json'], { mintToken: async ({ scope }) => {
    seen.push(scope);
    if (scope === GMAIL_COMPOSE_SCOPE) throw Object.assign(new Error('secret'), { errorKind: 'scope_not_delegated' });
    return 't';
  } });
  assert.equal(result.code, 1);
  assert.equal(result.calls, 0);
  assert.equal(seen.length, 3);
  assert.ok(seen[2].endsWith('/gmail.send'));
  assert.deepEqual(JSON.parse(result.output[0]).results.map(r => r.ok), [true, false, true]);
  const human = await cli(['--check'], { mintToken: async () => { throw Object.assign(new Error(), { errorKind: 'scope_not_delegated' }); } });
  assert.match(human.output[0], /NG .*gmail.compose scope_not_delegated/u);
  assert.match(human.output[0], /Admin Console/u);
});

test('CLI 通常実行は共有アカウントで下書き作成し JSON を1個出す', async () => {
  let requests = 0;
  const result = await cli([...args, '--json'], {
    getToken: async ({ user }) => { assert.equal(user, DEFAULT_USER); return 't'; },
    fetchImpl: async (_url, options) => {
      requests++;
      assert.match(Buffer.from(JSON.parse(options.body).message.raw, 'base64url').toString(), /From: seisaku-team@orgiast.jp/u);
      return response({ id: 'd', message: { id: 'm', threadId: 'th' } });
    },
  });
  assert.equal(result.code, 0);
  assert.equal(requests, 1);
  assert.equal(result.output.length, 1);
  assert.equal(JSON.parse(result.output[0]).id, 'd');
});

test('引数・body-file の設定エラーは2、内容を漏らさず無通信', async () => {
  for (const argv of [[], [...args, '--body-file', 'missing'], [...args, '--unknown'], [...args, '--user'], ['--check', ...args], ['--to', input.to, '--subject', 'x', '--body-file', 'missing']]) {
    const result = await cli([...argv, '--json'], { readFile: () => { throw new Error('SECRET'); } });
    assert.equal(result.code, 2);
    assert.equal(result.calls + result.tokens, 0);
    assert.equal(result.output.length, 1);
    assert.equal(result.output[0].includes('SECRET'), false);
  }
  const fromFile = await cli(['--to', input.to, '--subject', 'x', '--body-file', 'body.txt', '--dry-run', '--json'], { readFile: p => { assert.equal(p, 'body.txt'); return 'ファイル本文'; } });
  assert.equal(fromFile.code, 0);
});

test('SA キー欠落・JSON 破損は設定エラー（例外の秘密を漏らさない）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-draft-test-'));
  try {
    for (const content of [null, '{ "private_key": "SECRET', '{}']) {
      const keyPath = path.join(dir, 'key.json');
      if (content !== null) fs.writeFileSync(keyPath, content);
      const results = await probeScopes({ keyPath, scopes: [GMAIL_COMPOSE_SCOPE] });
      assert.equal(results[0].errorKind, 'configuration_error');
      assert.equal(JSON.stringify(results).includes('SECRET'), false);
    }
    const result = await cli(['--check', '--json'], { mintToken: async () => { throw Object.assign(new Error('SECRET'), { errorKind: 'configuration_error' }); } });
    assert.equal(result.code, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API 失敗・例外・不正応答は秘密を表示せず失敗する', async () => {
  for (const fetchImpl of [async () => response({ error: { message: 'SECRET' } }, 403), async () => { throw new Error('SECRET access_token assertion'); }, async () => response({})]) {
    const result = await cli([...args, '--json'], { getToken: async () => 'SECRET', fetchImpl });
    assert.equal(result.code, 1);
    assert.equal(result.output[0].includes('SECRET'), false);
    assert.equal(JSON.parse(result.output[0]).ok, false);
  }
});

test('deleteDraft は compose スコープで DELETE し、204 を成功として返す', async () => {
  const requests = [];
  const result = await deleteDraft({ user: DEFAULT_USER, id: 'draft-123',
    getToken: async options => {
      assert.deepEqual(options, { user: DEFAULT_USER, scope: GMAIL_COMPOSE_SCOPE });
      return 't';
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(result, { deleted: true, id: 'draft-123' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-123');
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer t');
  assert.equal(requests[0].options.body, undefined);
});

test('deleteDraft の404は例外ではなく not_found を返す', async () => {
  const result = await deleteDraft({ id: 'missing', getToken: async () => 't',
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.deepEqual(result, { deleted: false, id: 'missing', errorKind: 'not_found' });
});

test('CLI --delete と作成用引数・check・dry-run は排他で、設定エラー2・無通信', async () => {
  for (const extra of [
    ['--to', input.to], ['--cc', input.to], ['--subject', 'x'], ['--body', 'x'],
    ['--body-file', 'unused'], ['--check'], ['--dry-run'], args,
  ]) {
    const result = await cli(['--delete', 'draft', ...extra, '--json']);
    assert.equal(result.code, 2);
    assert.equal(result.calls + result.tokens, 0);
    assert.equal(result.output.length, 1);
    assert.equal(JSON.parse(result.output[0]).errorKind, 'configuration_error');
  }
});

test('CLI --delete は宛先ガード不要で JSON を1個出し、送信 URL を呼ばない', async () => {
  for (const status of [204, 404]) {
    const requests = [];
    const result = await cli(['--delete', 'draft', '--user', 'shared@orgiast.jp', '--json'], {
      loadLedger: () => { throw new Error('recipient guard must not run'); },
      mintToken: async options => {
        assert.equal(options.user, 'shared@orgiast.jp');
        assert.equal(options.scope, GMAIL_COMPOSE_SCOPE);
        return 't';
      },
      getToken: undefined,
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method });
        return new Response(null, { status });
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.output.length, 1);
    assert.deepEqual(JSON.parse(result.output[0]), {
      action: 'delete', user: 'shared@orgiast.jp', ok: true, deleted: status === 204, id: 'draft',
      ...(status === 404 ? { errorKind: 'not_found' } : {}),
    });
    assert.equal(requests.some(r => r.url.includes('/send')), false);
    assert.deepEqual(requests, [{ url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft', method: 'DELETE' }]);
  }
});

test('削除の API・認証・通信エラーは秘密を漏らさず例外／CLI終了1になる', async () => {
  for (const [fetchImpl, getToken, kind] of [
    [async () => response({ error: 'SECRET' }, 401), async () => 'SECRET', 'unauthorized'],
    [async () => response({ error: 'SECRET' }, 403), async () => 'SECRET', 'forbidden_no_access'],
    [async () => response({ error: 'SECRET' }, 500), async () => 'SECRET', 'error'],
    [async () => response({}), async () => 'SECRET', 'error'],
    [async () => { throw new Error('SECRET'); }, async () => 'SECRET', 'error'],
    [async () => { assert.fail('fetch after token failure'); }, async () => { throw new Error('SECRET'); }, 'error'],
  ]) {
    await assert.rejects(deleteDraft({ id: 'draft', fetchImpl, getToken }), error => {
      assert.equal(error.errorKind, kind);
      assert.equal(error.message.includes('SECRET'), false);
      return true;
    });
    const result = await cli(['--delete', 'draft', '--json'], { fetchImpl, getToken });
    assert.equal(result.code, 1);
    assert.equal(result.output.length, 1);
    assert.equal(result.output[0].includes('SECRET'), false);
    const report = JSON.parse(result.output[0]);
    assert.equal(report.ok, false);
    assert.equal(report.deleted, false);
    assert.equal(report.id, 'draft');
    assert.equal(report.errorKind, kind);
  }
});

test('削除 ID の欠落・重複・不正なパスは認証前に設定エラーになる', async () => {
  for (const argv of [
    ['--delete'], ['--delete', ''], ['--delete', '../messages/send'],
    ['--delete', '..'], ['--delete', 'draft?alt=media'], ['--delete', 'a', '--delete', 'b'],
  ]) {
    const result = await cli([...argv, '--json']);
    assert.equal(result.code, 2);
    assert.equal(result.calls + result.tokens, 0);
  }
});
