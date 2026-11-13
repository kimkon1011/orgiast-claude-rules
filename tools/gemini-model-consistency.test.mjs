// gemini の既定モデル名は 11 ファイルに散らばっている（llm-ask / codex-do / batch-* / eval-* 等）。
// 2026-11-02 の gemini-3.7-flash 503 障害では、1 つのモデル名を直すのに 11 ファイルを手で書き換えた。
// 書き漏らすと「一部のツールだけ死んだモデルを叩き続ける」状態になるので、既定値の drift をここで止める。
// 障害時はこのテストが落ちる＝変更漏れの検出器として使う（テストは既定値を 1 つに保つことだけを検査する）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MODEL_RE = /gemini-\d[\d.]*-flash/g;

function defaultsBySource() {
  const found = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.mjs') && !file.endsWith('.json')) continue;
    if (file.endsWith('.test.mjs')) continue; // テスト内の文字列は fixture・履歴で、既定値ではない
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const hit of src.matchAll(MODEL_RE)) found.push({ file, model: hit[0] });
  }
  return found;
}

test('gemini の既定モデルは全ツールで 1 つに揃っている', () => {
  const found = defaultsBySource();
  assert.ok(found.length >= 10, `gemini 既定値の検出数が想定より少ない: ${found.length}`);
  const models = [...new Set(found.map((f) => f.model))];
  assert.equal(
    models.length, 1,
    `gemini 既定モデルが分裂している: ${models.map((m) => `${m} (${found.filter((f) => f.model === m).map((f) => f.file).join(', ')})`).join(' / ')}`,
  );
});

test('既定モデル名は gemini-<major>.<minor>-flash 形式', () => {
  for (const { file, model } of defaultsBySource()) {
    assert.match(model, /^gemini-\d+\.\d+-flash$/, `${file}: ${model}`);
  }
});
