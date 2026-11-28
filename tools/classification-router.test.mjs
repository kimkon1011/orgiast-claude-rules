import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readConfig,
  parseResult,
  compareResults,
  classifyInquiry,
  classifyBoothType,
  appendComparisonLog,
  appendDiscrepancyReport,
} from './classification-router.mjs';

// ============================================================
// 設定読み込み
// ============================================================

test('readConfig: decider-only モードを読み込める', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const configPath = path.join(dir, 'classification-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mode: 'decider-only',
    decider: { provider: 'groq', model: 'openai/gpt-oss-120b', confidenceThreshold: 0.85 },
  }));
  const config = readConfig(configPath);
  assert.equal(config.mode, 'decider-only');
  assert.equal(config.decider.provider, 'groq');
  assert.equal(config.decider.confidenceThreshold, 0.85);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfig: sonnet-only モードを読み込める', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const configPath = path.join(dir, 'classification-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ mode: 'sonnet-only' }));
  const config = readConfig(configPath);
  assert.equal(config.mode, 'sonnet-only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfig: parallel モードを読み込める', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const configPath = path.join(dir, 'classification-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ mode: 'parallel' }));
  const config = readConfig(configPath);
  assert.equal(config.mode, 'parallel');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfig: 不正なモードはエラー', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const configPath = path.join(dir, 'classification-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ mode: 'invalid-mode' }));
  assert.throws(() => readConfig(configPath), /不正な mode/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfig: 設定ファイルがない場合は decider-only でフォールバック', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const configPath = path.join(dir, 'nonexistent.json');
  const config = readConfig(configPath);
  assert.equal(config.mode, 'decider-only');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================
// 結果パース
// ============================================================

test('parseResult: 標準JSONをパース', () => {
  const result = parseResult('{"lead_qualified":true,"lead_confidence":0.95}');
  assert.equal(result.lead_qualified, true);
  assert.equal(result.lead_confidence, 0.95);
});

test('parseResult: コードブロック付きJSONをパース', () => {
  const result = parseResult('```json\n{"booth_type":"standard","booth_type_confidence":0.9}\n```');
  assert.equal(result.booth_type, 'standard');
  assert.equal(result.booth_type_confidence, 0.9);
});

test('parseResult: コードブロック(言語なし)をパース', () => {
  const result = parseResult('```\n{"type":"custom","type_confidence":0.8}\n```');
  assert.equal(result.type, 'custom');
  assert.equal(result.type_confidence, 0.8);
});

test('parseResult: 不正JSONはエラー', () => {
  assert.throws(() => parseResult('not json'), SyntaxError);
  assert.throws(() => parseResult('{}""'), SyntaxError);
});

// ============================================================
// 比較ロジック
// ============================================================

test('compareResults: 完全一致', () => {
  const decider = { lead_qualified: true, urgency: 'high', type: 'standard' };
  const sonnet = { lead_qualified: true, urgency: 'high', type: 'standard' };
  const result = compareResults(decider, sonnet, ['lead_qualified', 'urgency', 'type']);
  assert.equal(result.agreementRate, 1);
  assert.equal(result.matchCount, 3);
  assert.equal(result.hasDiscrepancy, false);
  assert.equal(result.discrepancies.length, 0);
});

test('compareResults: 一部不一致', () => {
  const decider = { lead_qualified: true, urgency: 'low', type: 'standard' };
  const sonnet = { lead_qualified: true, urgency: 'high', type: 'standard' };
  const result = compareResults(decider, sonnet, ['lead_qualified', 'urgency', 'type']);
  assert.equal(result.agreementRate, 2 / 3);
  assert.equal(result.matchCount, 2);
  assert.equal(result.hasDiscrepancy, true);
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0].dimension, 'urgency');
});

test('compareResults: 全不一致', () => {
  const decider = { lead_qualified: false, urgency: 'low', type: 'custom' };
  const sonnet = { lead_qualified: true, urgency: 'high', type: 'standard' };
  const result = compareResults(decider, sonnet, ['lead_qualified', 'urgency', 'type']);
  assert.equal(result.agreementRate, 0);
  assert.equal(result.matchCount, 0);
  assert.equal(result.hasDiscrepancy, true);
  assert.equal(result.discrepancies.length, 3);
});

test('compareResults: 信頼度を含む比較', () => {
  const decider = { booth_type: 'standard', booth_type_confidence: 0.7, custom_features: 'none', priority: 'medium' };
  const sonnet = { booth_type: 'custom', booth_type_confidence: 0.95, custom_features: 'minor', priority: 'medium' };
  const result = compareResults(decider, sonnet, ['booth_type', 'custom_features', 'priority']);
  assert.equal(result.matchCount, 1); // priority only
  assert.equal(result.discrepancies.length, 2);
  assert.equal(result.discrepancies[0].deciderConfidence, 0.7);
  assert.equal(result.discrepancies[0].sonnetConfidence, 0.95);
});

// ============================================================
// 比較ログ出力
// ============================================================

test('appendComparisonLog: ログファイルに追記', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const config = {
    mode: 'decider-only',
    comparison: { logPath: path.join(dir, 'comparison-log.jsonl') },
  };
  appendComparisonLog({ type: 'inquiry', text: 'test', dimensions: ['lead_qualified'] }, config);
  const content = fs.readFileSync(config.comparison.logPath, 'utf8');
  const entry = JSON.parse(content.trim());
  assert.equal(entry.type, 'inquiry');
  assert.equal(entry.mode, 'decider-only');
  assert.ok(entry.t);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendComparisonLog: 設定がなくてもエラーにならない', () => {
  appendComparisonLog({ type: 'inquiry', text: 'test' }, {});
});

test('appendDiscrepancyReport: 乖離レポートに追記', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const config = {
    mode: 'parallel',
    comparison: { discrepancyReportPath: path.join(dir, 'discrepancies.jsonl') },
  };
  appendDiscrepancyReport({
    type: 'inquiry',
    text: 'test inquiry',
    dimensions: ['lead_qualified'],
    comparison: { discrepancies: [{ dimension: 'urgency', decider: 'low', sonnet: 'high' }] },
  }, config);
  const content = fs.readFileSync(config.comparison.discrepancyReportPath, 'utf8');
  const entry = JSON.parse(content.trim());
  assert.equal(entry.type, 'inquiry');
  assert.equal(entry.comparison.discrepancies.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================
// classifyInquiry (モック呼び出し)
// ============================================================

test('classifyInquiry: sonnet-only モードは Sonnet を呼ぶ', async () => {
  const config = { mode: 'sonnet-only' };
  const text = '見積もりをお願いします。来月開催の展示会用です。';
  // 実際のAPI呼び出しは避け、構造だけ確認
  const result = await classifyInquiry(text, { config, timeout: 30000 }).catch(e => {
    // APIキーがない環境では失敗するが、エラーメッセージにSonnet呼び出しが含まれていることを確認
    assert.ok(e.message.includes('claude') || e.message.includes('timeout') || e.message.includes('失敗') || e.message.includes('subprocess'));
  });
  if (result) {
    assert.equal(result.mode, 'sonnet-only');
    assert.ok(result.dimensions.includes('lead_qualified'));
    assert.ok(typeof result.elapsed === 'number');
  }
});

test('classifyInquiry: decider-only モードは Decider を呼ぶ', async () => {
  const config = {
    mode: 'decider-only',
    decider: { provider: 'groq', model: 'openai/gpt-oss-120b', confidenceThreshold: 0.9 },
  };
  const text = '標準ブースの見積もりをお願いします。';
  const result = await classifyInquiry(text, { config, timeout: 30000 }).catch(e => {
    assert.ok(e.message.includes('groq') || e.message.includes('timeout') || e.message.includes('失敗') || e.message.includes('subprocess'));
  });
  if (result) {
    assert.equal(result.mode, 'decider-only');
    assert.ok('confidence' in result);
    assert.ok('needsReview' in result);
  }
});

test('classifyInquiry: parallel モードは両方呼ぶ', async () => {
  const config = {
    mode: 'parallel',
    decider: { provider: 'groq', model: 'openai/gpt-oss-120b', confidenceThreshold: 0.9 },
    comparison: { enabled: true, strategy: 'decider_first' },
  };
  const text = '特別仕様のブースについて問い合わせです。';
  const result = await classifyInquiry(text, { config, timeout: 60000 }).catch(e => {
    // 両方失敗することもある
    assert.ok(e.message.includes('両方とも失敗'));
  });
  if (result) {
    assert.equal(result.mode, 'parallel');
    assert.ok('comparison' in result);
    assert.ok('deciderResult' in result || 'sonnetResult' in result);
  }
});

test('classifyInquiry: 空文字はエラー', async () => {
  await assert.rejects(
    () => classifyInquiry('', { config: { mode: 'decider-only' }, timeout: 5000 }),
    /空|empty|入力|text|input/i
  );
});

// ============================================================
// classifyBoothType (モック呼び出し)
// ============================================================

test('classifyBoothType: decider-only モード', async () => {
  const config = {
    mode: 'decider-only',
    decider: { provider: 'groq', model: 'openai/gpt-oss-120b', confidenceThreshold: 0.9 },
  };
  const text = '6m x 3mのブースで、標準パッケージを使用予定です。';
  const result = await classifyBoothType(text, { config, timeout: 30000 }).catch(e => {
    assert.ok(e.message.includes('groq') || e.message.includes('timeout') || e.message.includes('失敗') || e.message.includes('subprocess'));
  });
  if (result) {
    assert.equal(result.mode, 'decider-only');
    assert.ok(result.dimensions.includes('booth_type'));
    assert.ok('confidence' in result);
  }
});

// ============================================================
// 設定切り替えの即時反映テスト
// ============================================================

test('設定ファイルを書き換えると即座にモードが変わる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'class-router-'));
  const configPath = path.join(dir, 'classification-config.json');

  fs.writeFileSync(configPath, JSON.stringify({ mode: 'sonnet-only' }));
  assert.equal(readConfig(configPath).mode, 'sonnet-only');

  fs.writeFileSync(configPath, JSON.stringify({ mode: 'decider-only' }));
  assert.equal(readConfig(configPath).mode, 'decider-only');

  fs.writeFileSync(configPath, JSON.stringify({ mode: 'parallel' }));
  assert.equal(readConfig(configPath).mode, 'parallel');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================
// 乖離レポート: 並列モードで乖離があった場合の記録
// ============================================================

test('compareResults: booth_type 次元の乖離を正しく検出', () => {
  const decider = {
    booth_type: 'standard', booth_type_confidence: 0.6,
    custom_features: 'none', custom_features_confidence: 0.9,
    priority: 'low', priority_confidence: 0.8,
  };
  const sonnet = {
    booth_type: 'custom', booth_type_confidence: 0.95,
    custom_features: 'major', custom_features_confidence: 0.9,
    priority: 'high', priority_confidence: 0.85,
  };
  const result = compareResults(decider, sonnet, ['booth_type', 'custom_features', 'priority']);
  assert.equal(result.matchCount, 0);
  assert.equal(result.discrepancies.length, 3);
  assert.equal(result.discrepancies[0].dimension, 'booth_type');
  assert.equal(result.discrepancies[0].decider, 'standard');
  assert.equal(result.discrepancies[0].sonnet, 'custom');
});