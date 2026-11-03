import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBase64Url, downloadAttachment, parseArgs } from './gmail-attachment.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const USAGE = '使い方: node tools/gmail-attachment.mjs --user <address> --message <id> (--attachment <id>|--filename <name>) --out <path>';

function jsonResponse(value) {
  return { ok: true, json: async () => value };
}

function withTempDir(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'gmail-attachment-'));
  return Promise.resolve(fn(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('decodeBase64Url decodes URL-safe unpadded data', () => {
  const source = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xfb, 0xff]);
  assert.deepEqual(decodeBase64Url(source.toString('base64url')), source);
});

test('parseArgs accepts attachment id mode', () => {
  assert.deepEqual(parseArgs([
    '--user', 'user@example.com', '--message', 'abc', '--attachment', 'def', '--out', 'file.pdf',
  ]), { user: 'user@example.com', message: 'abc', attachment: 'def', out: 'file.pdf' });
});

test('parseArgs accepts filename mode', () => {
  const parsed = parseArgs([
    '--user', 'user@example.com', '--message', 'abc', '--filename', '完了謄本', '--out', 'file.pdf',
  ]);
  assert.equal(parsed.filename, '完了謄本');
});

test('parseArgs rejects missing or conflicting selectors', () => {
  const common = ['--user', 'user@example.com', '--message', 'abc', '--out', 'file.pdf'];
  assert.throws(() => parseArgs(common), /exactly one/);
  assert.throws(() => parseArgs([...common, '--attachment', 'x', '--filename', 'y']), /exactly one/);
});

test('parseArgs errors include usage', () => {
  const cases = [
    ['--unknown', 'x'],
    ['--user'],
    ['--message', 'abc', '--attachment', 'def', '--out', 'file.pdf'],
    ['--user', 'user@example.com', '--message', 'abc', '--out', 'file.pdf'],
  ];
  for (const argv of cases) assert.throws(() => parseArgs(argv), (error) => error.message.includes(USAGE));
});

test('downloadAttachment finds a filename and writes decoded PDF bytes', () => withTempDir(async (directory) => {
  const source = Buffer.from('%PDF-test-data');
  const output = join(directory, 'result.pdf');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return jsonResponse({ payload: { parts: [{ filename: '完了謄本.pdf', body: { attachmentId: 'att-1' } }] } });
    }
    return jsonResponse({ data: source.toString('base64url') });
  };
  const getToken = async (options) => {
    assert.deepEqual(options, {
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      impersonate: 'user@example.com',
    });
    return 'token';
  };

  const result = await downloadAttachment({
    user: 'user@example.com', message: 'message/1', filename: '完了謄本', out: output,
  }, { fetchImpl, getToken });

  assert.equal(result.bytes, source.length);
  assert.equal(result.header, '%PDF');
  assert.deepEqual(readFileSync(output), source);
  assert.deepEqual(calls.map(({ url }) => url), [
    `${API}/messages/message%2F1?format=full`,
    `${API}/messages/message%2F1/attachments/att-1`,
  ]);
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer token'));
}));

test('downloadAttachment with an attachment id fetches only the attachment', () => withTempDir(async (directory) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({ data: Buffer.from('data').toString('base64url') });
  };

  await downloadAttachment({
    user: 'user@example.com', message: 'msg', attachment: 'att/direct', out: join(directory, 'out.bin'),
  }, { fetchImpl, getToken: async () => 'token' });

  assert.deepEqual(calls, [`${API}/messages/msg/attachments/att%2Fdirect`]);
}));

test('downloadAttachment rejects when the filename is not found', () => withTempDir(async (directory) => {
  const fetchImpl = async () => jsonResponse({ payload: { parts: [] } });
  await assert.rejects(downloadAttachment({
    user: 'user@example.com', message: 'msg', filename: 'missing.pdf', out: join(directory, 'out.pdf'),
  }, { fetchImpl, getToken: async () => 'token' }), /attachment filename not found/);
}));

test('downloadAttachment rejects an ambiguous filename', () => withTempDir(async (directory) => {
  const fetchImpl = async () => jsonResponse({
    payload: {
      parts: [
        { filename: 'report.pdf', body: { attachmentId: 'att-1' } },
        { filename: 'REPORT.PDF', body: { attachmentId: 'att-2' } },
      ],
    },
  });
  await assert.rejects(downloadAttachment({
    user: 'user@example.com', message: 'msg', filename: 'report.pdf', out: join(directory, 'out.pdf'),
  }, { fetchImpl, getToken: async () => 'token' }), /ambiguous/);
}));
