/**
 * パターン検出結果から Mermaid 図を生成するモジュール
 *
 * X-0065: 箇条書き → 関係図変換
 */

/**
 * プロセスフロー図の生成
 * @param {string[]} bullets - 箇条書き項目
 * @returns {string} Mermaid code
 */
function genSteps(bullets) {
  const nodes = bullets.map((b, i) => {
    const id = `S${i}`;
    const label = sanitizeLabel(b);
    return `${id}["${label}"]`;
  });
  const links = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    links.push(`${nodes[i]} --> ${nodes[i + 1]}`);
  }
  const all = ['flowchart LR', ...nodes, ...links];
  return all.join('\n  ');
}

/**
 * 比較図の生成
 * @param {string[]} bullets
 * @returns {string} Mermaid code
 */
function genOptions(bullets) {
  // 左半分・右半分に分割（等分、奇数なら左に多く）
  const mid = Math.ceil(bullets.length / 2);
  const left = bullets.slice(0, mid);
  const right = bullets.slice(mid);
  const lines = ['flowchart LR'];
  left.forEach((b, i) => {
    lines.push(`  L${i}["${sanitizeLabel(b)}"]`);
  });
  right.forEach((b, i) => {
    lines.push(`  R${i}["${sanitizeLabel(b)}"]`);
  });
  // 比較の矢印
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    if (left[i] && right[i]) {
      lines.push(`  L${i} -.->|vs| R${i}`);
    }
  }
  return lines.join('\n');
}

/**
 * 階層図の生成
 * @param {string[]} bullets
 * @returns {string} Mermaid code
 */
function genLevels(bullets) {
  const lines = ['flowchart TD'];
  // ルートは全体のタイトルとして最初の項目
  if (bullets.length > 0) {
    const root = bullets[0];
    lines.push(`  Root["${sanitizeLabel(root)}"]`);
    const children = bullets.slice(1);
    children.forEach((b, i) => {
      const id = `C${i}`;
      lines.push(`  ${id}["${sanitizeLabel(b)}"]`);
      lines.push(`  Root --> ${id}`);
    });
  }
  return lines.join('\n');
}

/**
 * 循環図の生成
 * @param {string[]} bullets
 * @returns {string} Mermaid code
 */
function genLoops(bullets) {
  const nodes = bullets.map((b, i) => {
    const id = `L${i}`;
    return `${id}["${sanitizeLabel(b)}"]`;
  });
  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    const next = (i + 1) % nodes.length;
    links.push(`${nodes[i]} -->|${i === nodes.length - 1 ? 'cycle' : ''}| ${nodes[next]}`);
  }
  const all = ['flowchart LR', ...nodes, ...links];
  return all.join('\n  ');
}

/**
 * タイムライン図の生成
 * @param {string[]} bullets
 * @returns {string} Mermaid code
 */
function genDates(bullets) {
  const sections = bullets.map((b) => {
    // 日付部分をタイトル、残りを説明に
    const dateMatch = b.match(
      /(Q[1-4]\s*\d{4}|[1-9]月|第[1-4]四半期|phase\s*\d|フェーズ\s*\d|202[0-9]年)/i,
    );
    if (dateMatch) {
      const title = dateMatch[0];
      const desc = b.replace(dateMatch[0], '').trim();
      return `    section ${title}\n      ${desc || '(no detail)'} :t1`;
    }
    return `    section\n      ${sanitizeLabel(b)} :t1`;
  });
  return `timeline\n${sections.join('\n')}`;
}

/** Mermaidラベル内の特殊文字をエスケープ */
function sanitizeLabel(text) {
  if (!text) return '';
  return text
    .replace(/"/g, "'")
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .replace(/[\n\r]+/g, ' ');
}

/**
 * パターンに応じた Mermaid 図を生成
 * @param {string} pattern - 'steps' | 'options' | 'levels' | 'loops' | 'dates'
 * @param {string[]} bullets - 箇条書き項目
 * @returns {string} Mermaid code
 */
export function generateMermaid(pattern, bullets) {
  if (!bullets || bullets.length === 0) return '';
  const clean = bullets.map((b) => (typeof b === 'string' ? b.trim() : '')).filter(Boolean);
  if (clean.length === 0) return '';

  switch (pattern) {
    case 'steps':
      return genSteps(clean);
    case 'options':
      return genOptions(clean);
    case 'levels':
      return genLevels(clean);
    case 'loops':
      return genLoops(clean);
    case 'dates':
      return genDates(clean);
    default:
      return genSteps(clean);
  }
}