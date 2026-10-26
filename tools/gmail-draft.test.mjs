import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GMAIL_COMPOSE_SCOPE, DEFAULT_USER, buildRawMessage, buildForwardRaw, guardRecipients,
  renderChatDisplay, classifyTokenError, probeScopes, createDraft, deleteDraft, runCli,
} from './gmail-draft.mjs';

const ledger = { domains: ['orgiast.jp', 'toho-kogyo.com'], addresses: ['staff@gmail.com'] };
const input = { from: DEFAULT_USER, to: 'customer@example.com', subject: '制作のお見積り', body: 'こんにちは。\nよろしくお願いします。' };
const args = ['--to', input.to, '--subject', input.subject, '--body', input.body];
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const originalMessage = subject => Buffer.from([
  'From: 顧客 <customer@example.com>', 'Date: Sun, 25 Oct 2026 10:00:00 +0900',
  `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'To: seisaku-team@orgiast.jp',
  'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('元メール本文').toString('base64'),
].join('\r\n')).toString('base64url');

test('forward MIME は件名・識別ヘッダ・本文・message/rfc822 添付を保持し Fwd を重ねない', () => {
  for (const [sourceSubject, expected] of [['日本語件名', 'Fwd: 日本語件名'], ['Fwd: 済み', 'Fwd: 済み']]) {
    const raw = buildForwardRaw({ from: DEFAULT_USER, to: 'staff@orgiast.jp', messageId: 'msg_123', preface: '確認してください', originalRaw: originalMessage(sourceSubject) });
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    assert.match(mime, /X-Orgiast-Forward: msg_123/u);
    assert.match(mime, /Content-Type: message\/rfc822/u);
    assert.match(mime, /filename="=\?UTF-8\?B\?/u);
    const subjectLine = mime.match(/^Subject: ([\s\S]*?)\r\n(?! )/mu)[1].replace(/\r\n /gu, '');
    const decodedSubject = subjectLine.replace(/=\?UTF-8\?B\?([^?]+)\?=/gu, (_m, value) => Buffer.from(value, 'base64').toString());
    assert.equal(decodedSubject, expected);
    assert.ok(mime.includes(Buffer.from('確認してください\r\n\r\n---------- Forwarded message ---------').toString('base64').slice(0, 30)));
  }
});

test('forward CLI は内部宛を拒否せず raw 取得後に下書きを作る', async () => {
  const requests = [];
  const result = await cli(['--forward', 'msg_123', '--to', 'staff@orgiast.jp', '--body', '前置き', '--json'], {
    getToken: async () => 't', fetchImpl: async (url, options = {}) => {
      requests.push(url);
      if (url.includes('/messages/msg_123?format=raw')) return response({ raw: originalMessage('日本語件名') });
      const mime = Buffer.from(JSON.parse(options.body).message.raw, 'base64url').toString('utf8');
      assert.match(mime, /To: staff@orgiast.jp/u);
      return response({ id: 'forward-draft', message: { id: 'm' } });
    },
  });
  assert.equal(result.code, 0);
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(result.output[0]).id, 'forward-draft');
});

test('forward は構築後25MB超を too_large で停止する', async () => {
  const huge = Buffer.from(`Subject: large\r\nContent-Type: text/plain\r\n\r\n${'x'.repeat(19 * 1024 * 1024)}`).toString('base64url');
  const result = await cli(['--forward', 'msg', '--to', 'staff@orgiast.jp', '--json'], { fetchMessageRaw: async () => huge });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.output[0]).errorKind, 'too_large');
});

async function cli(argv, overrides = {}) {
  const output = [];
  let calls = 0;
  let tokens = 0;
  const code = await runCli({ argv, deps: {
    stdout: text => output.push(text), loadLedger: () => ledger,
    fetchImpl: async () => { calls++; throw new Error('unexpected fetch'); },
    getToken: async () => { tokens++; throw new Error('unexpected token'); },
    mintToken: async () => { tokens++; throw new Error('unexpected mint'); },
    readState: () => { throw new Error('no cached state'); },
    inspectDraft: async () => ({ ok: true, findings: [], llm: { provider: null, error: null } }),
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

test('添付は multipart/mixed、RFC 2047 ファイル名、推定 MIME type で格納', () => {
  const decoded = Buffer.from(buildRawMessage({ ...input, attachments: [{ name: '見積書.pdf', data: Buffer.from('%PDF') }] }), 'base64url').toString();
  assert.match(decoded, /Content-Type: multipart\/mixed/u);
  assert.match(decoded, /Content-Type: application\/pdf/u);
  assert.match(decoded, /filename="=\?UTF-8\?B\?/u);
  assert.match(decoded, /JVBERg==/u);
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

test('返信ヘッダと threadId を作成 API に渡す・注入を拒否する', async () => {
  const result = await cli([...args, '--thread-id', 'thread123', '--in-reply-to', '<original@example.com>', '--json'], {
    getToken: async () => 't', fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response({ messages: [{ payload: { headers: [{ name: 'Message-ID', value: '<original@example.com>' }] } }] });
      const { message } = JSON.parse(options.body);
      assert.equal(message.threadId, 'thread123');
      const raw = Buffer.from(message.raw, 'base64url').toString();
      assert.match(raw, /In-Reply-To: <original@example.com>\r\nReferences: <original@example.com>/);
      return response({ id: 'draft' });
    },
  });
  assert.equal(result.code, 0);
  for (const flags of [['--in-reply-to', '<x@y>\r\nBcc: a@b.com'], ['--thread-id', '../send']]) {
    const bad = await cli([...args, ...flags]);
    assert.equal(bad.code, 2);
    assert.equal(bad.calls + bad.tokens, 0);
  }
});
const draftHeaders = extra => ({ message: { payload: { headers: [
  { name: 'To', value: 'Customer <customer@example.com>' }, { name: 'Subject', value: '確認' }, ...extra,
] } } });
test('整合性 block は送信せず、ack 理由がある時だけ ledger に残して送る', async () => {
  const blocked = await cli(['--send','draft','--json'], { inspectDraft: async()=>({ok:false,findings:[{severity:'block'}],llm:{}}), getToken:async()=> 't', fetchImpl:async()=>response(draftHeaders([])) });
  assert.equal(blocked.code,2); assert.equal(blocked.calls,0);
  const ledger=[]; let calls=0;
  const acked = await cli(['--send','draft','--ack-consistency','緊急対応','--json'], { inspectDraft: async()=>({ok:false,findings:[{severity:'block'}],llm:{}}), appendLedger:(_p,s)=>ledger.push(s), getToken:async()=> 't', fetchImpl:async()=>{calls++; return calls===1?response(draftHeaders([])):response({id:'sent',threadId:'thread'})} });
  assert.equal(acked.code,0); assert.match(ledger[0],/緊急対応/u);
});
test('X-Orgiast-Forward ありは整合性チェックを呼ばずに送る', async () => {
  let inspected = 0; let calls = 0;
  const result = await cli(['--send', 'draft', '--json'], {
    inspectDraft: async () => { inspected++; return { ok: false, findings: [{ severity: 'block' }], llm: {} }; },
    getToken: async () => 't', fetchImpl: async () => ++calls === 1
      ? response(draftHeaders([{ name: 'X-Orgiast-Forward', value: 'msg_123' }]))
      : response({ id: 'sent', threadId: 'thread' }),
  });
  assert.equal(result.code, 0); assert.equal(inspected, 0); assert.equal(calls, 2);
  assert.equal(JSON.parse(result.output[0]).consistency, 'skipped_forward');
});
test('X-Orgiast-Forward なしは従来どおり整合性チェックを呼ぶ', async () => {
  let inspected = 0;
  const result = await cli(['--send', 'draft', '--json'], {
    inspectDraft: async () => { inspected++; return { ok: false, findings: [{ severity: 'block' }], llm: {} }; },
    readState: () => { throw new Error('no cache'); },
    getToken: async () => 't', fetchImpl: async () => response(draftHeaders([])),
  });
  assert.equal(result.code, 2); assert.equal(inspected, 1);
  assert.equal(JSON.parse(result.output[0]).errorKind, 'consistency_block');
});
test('送信は指定アカウントの下書きを取得後 compose で送信し JSON を返す', async () => {
  const requests = [];
  const result = await cli(['--send', 'draft-123', '--user', 'shared@orgiast.jp', '--json'], {
    getToken: async options => { assert.deepEqual(options, { user: 'shared@orgiast.jp', scope: GMAIL_COMPOSE_SCOPE }); return 't'; },
    fetchImpl: async (url, options) => {
      requests.push(url);
      if (requests.length === 1) { assert.match(url, /drafts\/draft-123\?format=full$/); return response(draftHeaders([])); }
      assert.match(url, /drafts\/send$/);
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { id: 'draft-123' });
      return response({ id: 'sent', threadId: 'thread' });
    },
  });
  assert.equal(result.code, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(result.output[0]), { action: 'send', user: 'shared@orgiast.jp', ok: true, sentMessageId: 'sent', threadId: 'thread', to: 'Customer <customer@example.com>', subject: '確認' });
});
test('送信前に To/Cc/Bcc の内部宛を拒否する（表示名・大小文字・台帳アドレス）', async () => {
  for (const name of ['To', 'cC', 'BCC']) {
    for (const value of ['Staff <STAFF@ORGIAST.JP>', 'staff@gmail.com']) {
      let calls = 0;
      const result = await cli(['--send', 'draft', '--json'], { getToken: async () => 't', fetchImpl: async () => {
        calls++; return response(draftHeaders([{ name, value }]));
      } });
      assert.equal(result.code, 3);
      assert.equal(calls, 1);
      assert.equal(JSON.parse(result.output[0]).errorKind, 'internal_recipient');
    }
  }
});
test('X-Orgiast-Forward 付き下書きだけ内部宛へ送信できる', async () => {
  let calls = 0;
  const result = await cli(['--send', 'draft', '--json'], { getToken: async () => 't', fetchImpl: async () => {
    calls++;
    return calls === 1 ? response(draftHeaders([{ name: 'To', value: 'staff@orgiast.jp' }, { name: 'X-Orgiast-Forward', value: 'msg_123' }])) : response({ id: 'sent', threadId: 'thread' });
  } });
  assert.equal(result.code, 0);
  assert.equal(calls, 2);
});
test('送信引数の不正・競合は無通信、宛先不明・取得失敗では送らない', async () => {
  for (const flags of [['--send'], ['--send', '../send'], ['--send', 'd', '--delete', 'd'], ['--send', 'd', '--check'], ['--send', 'd', '--dry-run'], ['--send', 'd', ...args], ['--send', 'd', '--thread-id', 't']]) {
    const result = await cli([...flags, '--json']);
    assert.equal(result.code, 2);
    assert.equal(result.calls + result.tokens, 0);
  }
  for (const resp of [() => response({}, 404), () => response({}), () => response({ message: { payload: { headers: [] } } })]) {
    let calls = 0;
    const result = await cli(['--send', 'd', '--json'], { getToken: async () => 't', fetchImpl: async () => { calls++; return resp(); } });
    assert.equal(result.code, 1);
    assert.equal(calls, 1);
  }
});
test('送信 API の失敗は再試行せず秘密を出さない', async () => {
  let calls = 0;
  const result = await cli(['--send', 'd', '--json'], { getToken: async () => 'SECRET', fetchImpl: async () => {
    calls++; return calls === 1 ? response(draftHeaders([])) : response({ error: 'SECRET' }, 403);
  } });
  assert.equal(result.code, 1);
  assert.equal(calls, 2);
  assert.equal(result.output[0].includes('SECRET'), false);
});

const replyMessage = (id, subject, references, labelIds = []) => ({ labelIds, payload: { headers: [
  { name: 'message-id', value: id }, { name: 'sUbJeCt', value: subject },
  ...(references ? [{ name: 'References', value: references }] : []),
] } });

test('スレッド取得で最後の非 DRAFT へ返信し、References と件名を引き継ぐ', async () => {
  for (const trailingDraft of [false, true]) {
    for (const subject of ['日程調整', 'Re: 日程調整', 're: 日程調整']) {
      for (const explicit of [false, true]) {
        const requests = [];
        const scopes = [];
        const messages = [replyMessage('<old@example.com>', '古い件名'),
          replyMessage('<parent@example.com>', subject, '<root@example.com> <old@example.com>')];
        if (trailingDraft) messages.push(replyMessage('<draft@example.com>', '下書き', '', ['DRAFT']));
        const result = await cli(['--to', input.to, '--body', input.body, '--thread-id', 'thread123', '--json',
          ...(explicit ? ['--subject', '指定件名'] : [])], {
          getToken: async options => { scopes.push(options.scope); assert.equal(options.user, DEFAULT_USER); return 't'; },
          fetchImpl: async (url, options) => {
            requests.push(url);
            if (requests.length === 1) {
              const parsed = new URL(url);
              assert.equal(parsed.pathname, '/gmail/v1/users/me/threads/thread123');
              assert.equal(parsed.searchParams.get('format'), 'metadata');
              assert.deepEqual(parsed.searchParams.getAll('metadataHeaders'), ['Message-ID', 'References', 'Subject']);
              assert.equal(options.method, 'GET');
              assert.equal(options.headers.Authorization, 'Bearer t');
              return response({ messages });
            }
            assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts');
            const { message } = JSON.parse(options.body);
            assert.equal(message.threadId, 'thread123');
            const raw = Buffer.from(message.raw, 'base64url').toString();
            assert.ok(raw.includes('In-Reply-To: <parent@example.com>\r\n'));
            assert.ok(raw.includes('References: <root@example.com> <old@example.com> <parent@example.com>\r\n'));
            const decodedSubject = [...raw.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/gu)].map(m => Buffer.from(m[1], 'base64').toString()).join('');
            assert.equal(decodedSubject, explicit ? '指定件名' : /^re:/i.test(subject) ? subject : `Re: ${subject}`);
            return response({ id: 'draft' });
          },
        });
        assert.equal(result.code, 0);
        assert.equal(requests.length, 2);
        assert.deepEqual(scopes, ['https://www.googleapis.com/auth/gmail.readonly', GMAIL_COMPOSE_SCOPE]);
      }
    }
  }
});

test('thread-id の dry-run は認証・APIなしで予定ヘッダを表示する', async () => {
  for (const json of [false, true]) {
    const result = await cli(['--to', input.to, '--body', input.body, '--thread-id', 'thread123', '--dry-run', ...(json ? ['--json'] : [])]);
    assert.equal(result.code, 0);
    assert.equal(result.calls + result.tokens, 0);
    const report = json ? JSON.parse(result.output[0]) : { headers: result.output[0] };
    assert.ok(report.headers.includes('In-Reply-To: (取得予定)'));
    assert.ok(report.headers.includes('References:'));
    assert.ok(result.output[0].includes('thread123'));
    if (json) assert.equal(report.threadId, 'thread123');
  }
});

test('thread-id なしは取得を行わず従来と同一の MIME を POST する', async () => {
  let calls = 0;
  const result = await cli([...args, '--json'], {
    getToken: async () => 't', fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts');
      assert.deepEqual(JSON.parse(options.body), { message: { raw: buildRawMessage(input) } });
      return response({ id: 'draft' });
    },
  });
  assert.equal(result.code, 0);
  assert.equal(calls, 1);
});

test('スレッド返信も内部宛は認証前に停止する', async () => {
  const result = await cli(['--to', 'staff@orgiast.jp', '--body', '本文', '--thread-id', 'thread123']);
  assert.equal(result.code, 3);
  assert.equal(result.calls + result.tokens, 0);
});

test('返信先なし・Message-ID 欠落・ヘッダ注入・取得失敗なら下書きを作らない', async () => {
  for (const [thread, status] of [
    [{ messages: [] }, 200],
    [{ messages: [replyMessage('<draft@example.com>', '件名', '', ['DRAFT'])] }, 200],
    [{ messages: [{ payload: { headers: [] } }] }, 200],
    [{ messages: [replyMessage('<parent@example.com>', '件名', '<root@example.com>\r\nBcc: evil@example.com')] }, 200],
    [{ messages: [replyMessage('<parent@example.com>\r\nBcc: evil@example.com', '件名')] }, 200],
    [{ error: 'SECRET' }, 403],
  ]) {
    let calls = 0;
    const result = await cli(['--to', input.to, '--body', input.body, '--thread-id', 'thread123', '--json'], {
      getToken: async () => 't', fetchImpl: async () => { calls++; return response(thread, status); },
    });
    assert.notEqual(result.code, 0);
    assert.equal(calls, 1);
    assert.equal(result.output[0].includes('SECRET'), false);
  }
});
