/**
 * 箇条書きテキストから関係パターンを検出するモジュール
 *
 * X-0065: 5パターン（DeckBolt）の信号語スコアリングによる判定
 *
 * Patterns:
 *   - steps: プロセスフロー（順序のある手順）
 *   - options: 比較（対比・選択肢）
 *   - levels: 階層（包含・分類）
 *   - loops: 循環（フィードバック・反復）
 *   - dates: タイムライン（時系列）
 */

// パターン優先順位（同点時のタイブレーク）
const PRIORITY_ORDER = ['dates', 'levels', 'steps', 'loops', 'options'];

/** 信号語辞書: 各パターンのトリガー単語 */
const SIGNAL_WORDS = {
  steps: {
    ja: ['まず', '次に', 'その後', '最後に', 'ステップ', '手順', '段階', 'フェーズ', '順に'],
    en: ['first', 'then', 'next', 'finally', 'step', 'phase', 'stage', 'sequence'],
  },
  options: {
    ja: ['一方', '対して', 'または', 'あるいは', '代わりに', '比較', 'vs', '選択肢', '別の'],
    en: ['vs', 'instead', 'but', 'compared', 'alternative', 'option', 'however', 'whereas'],
  },
  levels: {
    ja: ['含む', '構成', '分類', '上位', '下位', '親', '子', '種類', '部品', '要素'],
    en: ['includes', 'consists', 'contains', 'category', 'parent', 'child', 'sub', 'type', 'kind'],
  },
  loops: {
    ja: ['繰り返す', '再び', 'フィードバック', 'サイクル', '循環', 'ループ', '反復', '回帰'],
    en: ['repeat', 'again', 'feedback', 'cycle', 'loop', 'iterat', 'circular', 'recur'],
  },
  dates: {
    ja: [
      /Q[1-4]/i, /第[1-4]四半期/, /202[0-9]年/, /〜月/, /\d月/,
      /フェーズ\s*\d/, /年目/, /ヶ月目|か月目/, /年度/,
    ],
    en: [
      /Q[1-4]/i, /20[2-9]\d/, /phase\s*\d/i, /quarter/i,
      /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i,
    ],
  },
};

/**
 * 1文または1箇条書き項目からパターンごとのスコアを計算
 * @param {string} text
 * @returns {Record<string, number>}
 */
function scoreText(text) {
  if (!text || typeof text !== 'string') {
    const empty = {};
    for (const key of Object.keys(SIGNAL_WORDS)) empty[key] = 0;
    return empty;
  }

  const normalized = text.normalize('NFKC').toLowerCase();
  const scores = {};

  for (const [pattern, dict] of Object.entries(SIGNAL_WORDS)) {
    let count = 0;

    // 文字列の信号語
    if (dict.ja) {
      for (const word of dict.ja) {
        if (word instanceof RegExp) {
          const matches = normalized.match(word);
          if (matches) count += matches.length;
        } else if (normalized.includes(word)) {
          count += 1;
        }
      }
    }
    if (dict.en) {
      for (const word of dict.en) {
        if (word instanceof RegExp) {
          const matches = normalized.match(word);
          if (matches) count += matches.length;
        } else if (normalized.includes(word)) {
          count += 1;
        }
      }
    }

    scores[pattern] = count;
  }

  return scores;
}

/**
 * 箇条書き配列から最適パターンを検出
 * @param {string[]} bullets - 各箇条書き項目のテキスト
 * @returns {{ pattern: string, confidence: number, scores: Record<string, number> }}
 */
export function detectPattern(bullets) {
  if (!bullets || bullets.length === 0) {
    return { pattern: 'steps', confidence: 0, scores: {} };
  }

  // 全項目のスコアを合算
  const total = {};
  for (const key of Object.keys(SIGNAL_WORDS)) total[key] = 0;

  for (const bullet of bullets) {
    const s = scoreText(bullet);
    for (const key of Object.keys(s)) total[key] += s[key];
  }

  // スコアが1以上で最大のパターン（タイブレークは PRIORITY_ORDER）
  const naturalMax = Math.max(...Object.values(total), 0);

  // 箇条書きの数もパターン判定に使う: 3つ以上あればプロセス・タイムラインの可能性
  // ただし自然スコアが0の場合はボーナスだけでパターンを決定しない
  if (bullets.length >= 3 && naturalMax > 0) {
    total.steps += 0.5;
    total.dates += 0.5;
  }

  // 再計算
  const finalMaxScore = Math.max(...Object.values(total), 0);

  // 自然スコアが0ならデフォルトで steps
  if (naturalMax === 0) {
    return { pattern: 'steps', confidence: 0, scores: total };
  }

  // 最大スコアのパターンを確定（タイブレークは PRIORITY_ORDER）
  const candidates = Object.entries(total)
    .filter(([, score]) => score === finalMaxScore)
    .map(([pattern]) => pattern);

  const chosen = candidates.length > 0
    ? candidates.sort((a, b) => PRIORITY_ORDER.indexOf(a) - PRIORITY_ORDER.indexOf(b))[0]
    : 'steps';

  // 信頼度: スコアが低い場合は低信頼度
  const bulletCount = bullets.length;
  const confidence = Math.min(1, finalMaxScore / Math.max(1, bulletCount));

  return {
    pattern: chosen,
    confidence,
    scores: total,
  };
}

/**
 * パターン名の表示用ラベル
 */
export const PATTERN_LABELS = {
  steps: 'プロセス',
  options: '比較',
  levels: '階層',
  loops: '循環',
  dates: 'タイムライン',
};

/**
 * 信号語辞書（テスト・拡張用に公開）
 */
export { SIGNAL_WORDS, scoreText };