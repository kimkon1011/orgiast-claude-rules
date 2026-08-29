import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetFiles = ['llm-ask.mjs', 'batch-enqueue.mjs', 'batch-run.mjs'];

describe('groqのモデルIDがすべてのファイルで一致していること', () => {
  const modelValues = {};

  targetFiles.forEach(file => {
    const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const groqBlockMatch = content.match(/groq:\s*\{([^}]+)\}/);
    assert.ok(groqBlockMatch, `${file} から groq の設定ブロックを抽出できない`);
    const block = groqBlockMatch[1];
    const modelMatch = block.match(/model:\s*'([^']+)'/);
    assert.ok(modelMatch, `${file} から groq の model を抽出できない`);
    modelValues[file] = modelMatch[1];
  });

  it('3ファイルのgroqモデルIDが一致する', () => {
    const values = Object.values(modelValues);
    assert.strictEqual(new Set(values).size, 1, `モデルIDが一致しません: ${JSON.stringify(modelValues)}`);
  });

  it('廃止済みモデルID llama-3.3-70b-versatile が残っていない', () => {
    targetFiles.forEach(file => {
      const content = fs.readFileSync(path.join(__dirname, file), 'utf8');
      assert.ok(!content.includes('llama-3.3-70b-versatile'), `${file} に廃止済みモデルIDが含まれています`);
    });
  });
});
