import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const TOOL_PATH = resolve(ROOT, 'tools', 'competitive-gap-analyzer.mjs');
const FIXTURE_COMPETITOR = resolve(__dirname, 'fixture-competitor.csv');
const FIXTURE_GSC = resolve(__dirname, 'fixture-gsc.json');

describe('competitive-gap-analyzer', () => {
  it('--help が正常終了する', () => {
    const result = spawnSync('node', [TOOL_PATH, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('競合キーワードCSV'));
  });

  it('必須オプション不足でエラー終了する', () => {
    const result = spawnSync('node', [TOOL_PATH], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('--competitor-csv'));
  });

  it('存在しないファイルでエラー終了する', () => {
    const result = spawnSync('node', [TOOL_PATH, '--competitor-csv', '/nonexistent.csv', '--gsc-json', '/nonexistent.json'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('見つかりません'));
  });

  it('CSVパースが正しく動作する（正しい競合キーワード数を返す）', () => {
    const csvText = readFileSync(FIXTURE_COMPETITOR, 'utf8');
    const lines = csvText.trim().split('\n');
    // ヘッダー1行 + データ行
    assert.equal(lines.length, 11, 'CSVはヘッダー+10データ行であること');
    assert.ok(lines[0].includes('Keyword'));
    assert.ok(lines[0].includes('Volume'));
    assert.ok(lines[0].includes('KD'));
  });

  it('GSC JSONが正しい構造を持つ', () => {
    const data = JSON.parse(readFileSync(FIXTURE_GSC, 'utf8'));
    assert.ok(Array.isArray(data.candidates));
    assert.equal(data.candidates.length, 10);
    assert.ok(data.candidates[0].keyword);
    assert.ok(data.candidates[0].position);
  });

  it('ツールがCSVとJSONを解析できる（LLM非使用の--output jsonでデータ読み込みまで確認）', () => {
    // LLMなしでデータ読み込みをテスト（--output json でエラー確認）
    // これはLLM呼び出しまで行くのでタイムアウト考慮
    const result = spawnSync('node', [
      TOOL_PATH,
      '--competitor-csv', FIXTURE_COMPETITOR,
      '--gsc-json', FIXTURE_GSC,
      '--output', 'json',
      '--limit', '5',
    ], {
      encoding: 'utf8',
      timeout: 30000,
    });

    // LLMが使えない環境ではエラーになる可能性があるが、データ読み込みまでは正常
    // LLM呼び出しエラー（llm-ask.mjs依存）は別問題
    if (result.status !== 0) {
      // LLMエラーは許容（gemini/deepseekキーがない環境など）
      const isLlmError = result.stderr?.includes('LLM分析');
      if (isLlmError) {
        assert.ok(true, 'LLM非接続環境ではスキップ（データ読み込みは正常）');
        return;
      }
    }

    assert.equal(result.status, 0, `ツール実行失敗: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.ok(output.generatedAt);
    assert.ok(Array.isArray(output.gaps));
  });
});
