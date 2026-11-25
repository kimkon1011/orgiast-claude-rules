// hook としての契約テスト: stdin(JSON) -> exit code。
// 判定関数の単体テストだけだと「どこを読むか」の不具合を取り逃す(実際 2026-08-30 に
// 「1つ前のターンを読む」不具合はこの形のテストでしか捕まらなかった)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'handoff-info-guard.mjs');
const FIXTURES = path.join(HERE, 'fixtures', 'handoff-info-guard');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function runHook(assistantText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-guard-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  const event = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } };
  fs.writeFileSync(transcript, JSON.stringify(event) + '\n', 'utf8');
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK], { encoding: 'utf8' }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code: err ? (err.code ?? 1) : 0, stderr: stderr || '' });
    });
    child.stdin.end(JSON.stringify({ transcript_path: transcript }));
  });
}

test('契約: 逃げ道の表にある「スクショを貼ってください」で止めない', async () => {
  const { code } = await runHook(readFixture('false-positive-fallback-table.md'));
  assert.equal(code, 0);
});

test('契約: 引用した依頼文（検証結果の表）で止めない', async () => {
  const { code } = await runHook(readFixture('false-positive-quoted-example.md'));
  assert.equal(code, 0);
});

test('契約: 情報なしの実行依頼は exit 2 で止める', async () => {
  const { code, stderr } = await runHook('リモートPCでもう一度実行してください。');
  assert.equal(code, 2);
  assert.match(stderr, /HANDOFF-INFO-GUARD/);
});

test('契約: 違反メッセージは引っかかった文そのものを出す', async () => {
  const { stderr } = await runHook('リモートPCでもう一度実行してください。');
  assert.match(stderr, /該当箇所:\s*\n\s*リモートPCでもう一度実行してください。/);
});

test('契約: 依頼と同じ場所に URL があれば止めない', async () => {
  const { code } = await runHook('次を開いてください。 https://example.com/x');
  assert.equal(code, 0);
});
