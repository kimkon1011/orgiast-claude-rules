/**
 * X-0065: ppt-to-relation テスト
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPattern, scoreText, PATTERN_LABELS } from './lib/pattern-detect.mjs';
import { generateMermaid } from './lib/mermaid-gen.mjs';

// ============================================================
// パターン検出テスト
// ============================================================

describe('scoreText', () => {
  it('空文字列は全パターン0点', () => {
    const s = scoreText('');
    for (const v of Object.values(s)) assert.equal(v, 0);
  });

  it('null/undefinedは全パターン0点', () => {
    assert.deepEqual(scoreText(null), { steps: 0, options: 0, levels: 0, loops: 0, dates: 0 });
    assert.deepEqual(scoreText(undefined), { steps: 0, options: 0, levels: 0, loops: 0, dates: 0 });
  });

  it('プロセス信号語を検出', () => {
    const s = scoreText('まずAを準備し、次にBを設定する');
    assert.ok(s.steps >= 2);
  });

  it('比較信号語を検出', () => {
    const s = scoreText('オプションA vs オプションB、一方Cは別の方法');
    assert.ok(s.options >= 2);
  });

  it('階層信号語を検出', () => {
    const s = scoreText('システムはA・B・Cの要素から構成される');
    assert.ok(s.levels >= 1);
  });

  it('循環信号語を検出', () => {
    const s = scoreText('PDCAサイクルを繰り返す');
    assert.ok(s.loops >= 2);
  });

  it('タイムライン信号語を検出', () => {
    const s = scoreText('Q1で調査、Q2で実装、2026年に完了');
    assert.ok(s.dates >= 3);
  });

  it('英語信号語も検出', () => {
    const s = scoreText('first prepare A, then setup B, finally deploy');
    assert.ok(s.steps >= 3);
  });
});

describe('detectPattern', () => {
  it('空配列は steps 0信頼度', () => {
    const r = detectPattern([]);
    assert.equal(r.pattern, 'steps');
    assert.equal(r.confidence, 0);
  });

  it('"まず→次に→最後に" はプロセス', () => {
    const r = detectPattern(['まずAを実施', '次にBを確認', '最後にCを完了']);
    assert.equal(r.pattern, 'steps');
  });

  it('"Q1→Q2→Q3" はタイムライン', () => {
    const r = detectPattern(['Q1に調査', 'Q2に設計', 'Q3に実装']);
    assert.equal(r.pattern, 'dates');
  });

  it('"含む→構成" は階層', () => {
    const r = detectPattern(['全体構成', '要素Aを含む', '要素Bを含む']);
    assert.equal(r.pattern, 'levels');
  });

  it('"vs→比較" は比較', () => {
    const r = detectPattern(['従来方式 vs 新方式', 'コスト面で比較優位']);
    assert.equal(r.pattern, 'options');
  });

  it('"繰り返す→サイクル" は循環', () => {
    const r = detectPattern(['計画を立てる', '実行する', '評価する', '改善を繰り返す']);
    assert.equal(r.pattern, 'loops');
  });

  it('パターンがない場合は steps（デフォルト）', () => {
    const r = detectPattern(['項目A', '項目B', '項目C']);
    assert.equal(r.pattern, 'steps');
  });

  it('英語信号語でもパターン検出', () => {
    const r = detectPattern(['first install', 'then configure', 'finally test']);
    assert.equal(r.pattern, 'steps');
  });
});

// ============================================================
// Mermaid生成テスト
// ============================================================

describe('generateMermaid', () => {
  it('空配列は空文字列を返す', () => {
    assert.equal(generateMermaid('steps', []), '');
    assert.equal(generateMermaid('steps', null), '');
    assert.equal(generateMermaid('steps', ['', '  ']), '');
  });

  it('steps: flowchart LR の矢印接続', () => {
    const m = generateMermaid('steps', ['準備', '実行', '確認']);
    assert.ok(m.includes('flowchart LR'));
    assert.ok(m.includes('S0'));
    assert.ok(m.includes('S1'));
    assert.ok(m.includes('S2'));
    assert.ok(m.includes('-->'));
  });

  it('options: 比較レイアウト', () => {
    const m = generateMermaid('options', ['従来法', '新方式', '低コスト', '高品質']);
    assert.ok(m.includes('L0'));
    assert.ok(m.includes('R0'));
    assert.ok(m.includes('-.-'));
  });

  it('levels: ツリー構造', () => {
    const m = generateMermaid('levels', ['全体', '子1', '子2']);
    assert.ok(m.includes('Root'));
    assert.ok(m.includes('C0'));
    assert.ok(m.includes('C1'));
    assert.ok(m.includes('Root --> C'));
  });

  it('loops: 循環矢印', () => {
    const m = generateMermaid('loops', ['計画', '実行', '評価']);
    assert.ok(m.includes('cycle'));
    // 循環: 最後のノードが最初のノードに戻る
    assert.ok(m.includes('L2') && m.includes('L0'));
  });

  it('dates: timeline', () => {
    const m = generateMermaid('dates', ['Q1に調査', 'Q2に実装']);
    assert.ok(m.includes('timeline'));
    assert.ok(m.includes('Q1') || m.includes('Q2'));
  });

  it('特殊文字をエスケープ', () => {
    const m = generateMermaid('steps', ['A < B > C "test"']);
    // 不等号は HTML エンティティに
    assert.ok(m.includes('&lt;'), '左不等号をエスケープ');
    assert.ok(m.includes('&gt;'), '右不等号をエスケープ');
    // 二重引用符は除去され、元の内容は保持
    assert.ok(m.includes('test'), 'テキスト内容は保持');
  });
});

describe('PATTERN_LABELS', () => {
  it('全パターンに日本語ラベルがある', () => {
    for (const p of ['steps', 'options', 'levels', 'loops', 'dates']) {
      assert.ok(typeof PATTERN_LABELS[p] === 'string' && PATTERN_LABELS[p].length > 0);
    }
  });
});