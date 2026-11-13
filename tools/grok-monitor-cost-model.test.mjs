// grok-monitor-cost-model.test.mjs — X-0020 監視頻度最適化のテスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// テスト用に必要な関数だけ import
// （モジュールとして export してない場合の回避策として
//  子プロセス経由でも検証できるようにしておく）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, 'grok-monitor-cost-model.mjs');

/**
 * CLI を実行して結果を取得するヘルパー
 */
async function runTool(...args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath || process.argv[0], [TOOL, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
    proc.on('exit', (code) => {
      resolve({ code, stdout: out, stderr: err });
    });
    proc.on('error', reject);
  });
}

describe('grok-monitor-cost-model', () => {
  // === CLI 基本動作 ===

  it('--list でシナリオ一覧を表示する', async () => {
    const result = await runTool('--list');
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('basic'));
    assert.ok(result.stdout.includes('tiered'));
    assert.ok(result.stdout.includes('timed-tiered'));
    assert.ok(result.stdout.includes('aggressive'));
    assert.ok(result.stdout.includes('event-emergency'));
  });

  it('デフォルト実行で全シナリオの結果を表示する', async () => {
    const result = await runTool();
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('改善前基準'));
    assert.ok(result.stdout.includes('総コスト削減'));
  });

  it('--scenario で特定シナリオのみ表示する', async () => {
    const result = await runTool('--scenario', 'basic');
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('基本'));
    assert.ok(result.stdout.includes('総コスト削減'));
  });

  it('--scenario に存在しないシナリオを指定するとエラー', async () => {
    const result = await runTool('--scenario', 'nonexistent');
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes('見つかりません'));
  });

  it('--json でJSON出力する', async () => {
    const result = await runTool('--json');
    assert.equal(result.code, 0);
    // JSONとしてパース可能
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.length > 0);
    assert.ok(parsed[0].label);
    assert.ok(parsed[0].baseline);
    assert.ok(parsed[0].improved);
    assert.ok(parsed[0].savings);
  });

  it('--scenario basic --json で特定シナリオのJSON出力', async () => {
    const result = await runTool('--scenario', 'basic', '--json');
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].label, 'basic');
  });

  // === 計算ロジックの検証 ===

  it('basic シナリオの削減率が約93%である', async () => {
    const result = await runTool('--scenario', 'basic', '--json');
    const parsed = JSON.parse(result.stdout);
    const scenario = parsed[0];

    // basic: 1分→15分 = 1440→96回 = 93.3%削減
    assert.ok(scenario.savings.checkReductionPct >= 92);
    assert.ok(scenario.savings.checkReductionPct <= 95);
  });

  it('timed-tiered シナリオでAI分析が大幅削減される', async () => {
    const result = await runTool('--scenario', 'timed-tiered', '--json');
    const parsed = JSON.parse(result.stdout);
    const scenario = parsed[0];

    // AI分析が変化時のみなので大幅削減
    assert.ok(scenario.savings.aiReductionPct >= 80);
    // 総コスト削減率も高い
    assert.ok(scenario.savings.totalSavingsPct >= 80);
  });

  it('aggressive シナリオが最も高い削減率を示す', async () => {
    const result = await runTool('--scenario', 'aggressive', '--json');
    const parsed = JSON.parse(result.stdout);
    const scenario = parsed[0];

    assert.ok(scenario.savings.checkReductionPct >= 90);
    assert.ok(scenario.savings.totalSavingsPct >= 85);
  });

  it('各シナリオの改善後コストが改善前より低い', async () => {
    const result = await runTool('--json');
    const parsed = JSON.parse(result.stdout);

    for (const scenario of parsed) {
      assert.ok(
        scenario.improved.dailyCost <= scenario.baseline.dailyCost,
        `${scenario.label}: 改善後コスト(${scenario.improved.dailyCost})が改善前(${scenario.baseline.dailyCost})より低いこと`
      );
    }
  });

  it('改善後チェック数は0以上である', async () => {
    const result = await runTool('--json');
    const parsed = JSON.parse(result.stdout);

    for (const scenario of parsed) {
      assert.ok(scenario.improved.checksPerDay > 0, `${scenario.label}: チェック数が正数`);
      assert.ok(scenario.improved.aiCallsPerDay > 0, `${scenario.label}: AI分析数が正数`);
    }
  });

  // === エッジケース ===
  it('--help 相当の未知オプションはエラーにならない（無視される）', async () => {
    const result = await runTool('--unknown-option');
    assert.equal(result.code, 0);
  });

  it('空の引数で実行可能', async () => {
    const result = await runTool();
    assert.equal(result.code, 0);
  });
});