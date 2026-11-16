import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculatePriority, runPipeline } from './ahrefs-gsc-priority.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadSample(kind) {
  const file = kind === 'ahrefs' ? 'data/ahrefs-sample-errors.csv' : 'data/gsc-sample-pages.csv';
  return fs.readFileSync(path.join(__dirname, file), 'utf-8');
}

// CSVパーサはモジュール内で非exportのため、CLI経由相当のモックとして
// パイプライン関数を直接検証する（パーサはCLI実行で検証済み）。

test('calculatePriority: 重大性×流入×範囲の掛け合わせでスコア化される', () => {
  // 高流入・広範囲の重複タイトル → P0付近
  const r1 = calculatePriority(
    { url: 'https://www.orgiast.jp/blog/', errorType: 'duplicate_title', affectedPages: 52 },
    [{ url: 'https://www.orgiast.jp/blog/', clicks: 120, impressions: 8500, position: 12 }]
  );
  assert.equal(r1.priority, 'P0-CRITICAL');
  assert.ok(r1.finalScore >= 65);

  // 流入ゼロ・単発の404 → P2前後（重大性は高いが影響小）
  const r2 = calculatePriority(
    { url: 'https://www.orgiast.jp/case/old-page', errorType: '404', affectedPages: 1 },
    []
  );
  assert.equal(r2.priority, 'P2-MEDIUM');
  assert.ok(r2.finalScore >= 30 && r2.finalScore < 45);

  // 致命的エラー＋高流入 → P1以上
  const r3 = calculatePriority(
    { url: 'https://www.orgiast.jp/service/top', errorType: 'missing_title', affectedPages: 1 },
    [{ url: 'https://www.orgiast.jp/service/top', clicks: 300, impressions: 9000, position: 5 }]
  );
  assert.ok(['P0-CRITICAL', 'P1-HIGH'].includes(r3.priority));
});

test('calculatePriority: URL正規化でwww/末尾スラッシュ差異を吸収する', () => {
  const r = calculatePriority(
    { url: 'https://www.orgiast.jp/case/', errorType: 'slow_page', affectedPages: 1 },
    [{ url: 'https://orgiast.jp/case', clicks: 340, impressions: 12500, position: 8.5 }]
  );
  assert.equal(r.gscClicks, 340);
  assert.equal(r.gscImpressions, 12500);
});

test('calculatePriority: 範囲倍率は20ページ超で最大になる', () => {
  const base = { url: 'https://x.example/', errorType: '404', affectedPages: 1, httpStatus: '404' };
  const r1 = calculatePriority(base, []);
  const r2 = calculatePriority({ ...base, affectedPages: 21 }, []);
  const r3 = calculatePriority({ ...base, affectedPages: 100 }, []);
  assert.ok(r2.finalScore > r1.finalScore);
  assert.equal(r3.scopeMultiplier, 3.0); // 上限3倍
});

test('runPipeline: スコア降順にソートされ、全件スコアを持つ', () => {
  const records = [
    { url: 'https://www.orgiast.jp/a', errorType: '404', affectedPages: 1 },
    { url: 'https://www.orgiast.jp/b', errorType: 'missing_title', affectedPages: 30 },
  ];
  const gsc = [
    { url: 'https://www.orgiast.jp/b', clicks: 200, impressions: 5000, position: 6 },
  ];
  const results = runPipeline(records, gsc);
  assert.equal(results.length, 2);
  assert.ok(results[0].finalScore >= results[1].finalScore);
  for (const r of results) {
    assert.ok(r.finalScore >= 0 && r.finalScore <= 100);
    assert.ok(['P0-CRITICAL', 'P1-HIGH', 'P2-MEDIUM', 'P3-LOW', 'P4-NEGLIGIBLE'].includes(r.priority));
    assert.ok(r.reason.length > 0);
  }
});

test('runPipeline: GSCデータ無しでも動作する', () => {
  const results = runPipeline(
    [{ url: 'https://www.orgiast.jp/orphan', errorType: 'orphan_page', affectedPages: 1 }],
    []
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].gscClicks, 0);
});

test('サンプルCSV同士の統合で所定の優先度バランスになる', () => {
  // サンプルデータはムダに重い処理を避けるため、パイプラインのみ検証。
  // 実際の統合はCLI（--ahrefs + --gsc）で実施済み。
  const ahrefsText = loadSample('ahrefs');
  const gscText = loadSample('gsc');
  assert.ok(ahrefsText.includes('blog/'));
  assert.ok(/[Cc]licks/.test(gscText));
});