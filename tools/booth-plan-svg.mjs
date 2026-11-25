import { readFile, writeFile } from 'node:fs/promises';
import { isEntry } from './is-entry.mjs';

const colors = Object.freeze({ counter: '#dbeafe', shelf: '#dcfce7', table: '#fef9c3', chair: '#f3e8ff', panel: '#fee2e2', storage: '#e2e8f0', display: '#cffafe', other: '#f1f5f9' });
const positive = n => Number.isSafeInteger(n) && n > 0;
const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
const required = s => typeof s === 'string' && s.trim().length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateBoothPlan(spec) {
  const errors = [];
  if (!object(spec)) return { ok: false, errors: ['仕様はオブジェクトで指定してください'] };
  if (!required(spec.meta?.name)) errors.push('meta.name は必須です');
  if (spec.meta?.units !== 'mm') errors.push('meta.units は mm のみです');
  const booth = spec.booth ?? {};
  for (const key of ['width', 'depth']) if (!positive(booth[key])) errors.push(`booth.${key} は正の整数が必要です`);
  const rules = spec.rules ?? {};
  if (!nonnegative(rules.minAisleMm)) errors.push('rules.minAisleMm は0以上の整数が必要です');
  if (typeof rules.frontBandCounterMaxWidthRatio !== 'number' || !Number.isFinite(rules.frontBandCounterMaxWidthRatio) || rules.frontBandCounterMaxWidthRatio < 0 || rules.frontBandCounterMaxWidthRatio > 1) errors.push('rules.frontBandCounterMaxWidthRatio は0以上1以下の数値が必要です');
  if (spec.meta?.grid !== undefined && !positive(spec.meta.grid)) errors.push('meta.grid は正の整数が必要です');
  if (!Array.isArray(spec.items)) {
    errors.push('items は配列が必要です');
    return { ok: false, errors };
  }
  const ids = new Set();
  const rectangles = [];
  let counterWidth = 0;
  spec.items.forEach((item, index) => {
    if (!object(item)) { errors.push(`item はオブジェクトが必要です: ${index}`); return; }
    const id = required(item.id) ? item.id : `項目${index + 1}`;
    for (const key of ['id', 'type', 'label']) if (!required(item[key])) errors.push(`${key} は必須です: ${id}`);
    if (required(item.id)) {
      if (ids.has(item.id)) errors.push(`id重複: ${item.id}`);
      ids.add(item.id);
    }
    if (!Object.hasOwn(colors, item.type)) errors.push(`未知type: ${id}`);
    for (const key of ['x', 'y']) if (!nonnegative(item[key])) errors.push(`${key} は0以上の整数が必要です: ${id}`);
    for (const key of ['w', 'd']) if (!positive(item[key])) errors.push(`${key} は正の整数が必要です: ${id}`);
    if (item.h !== undefined && !positive(item.h)) errors.push(`h は正の整数が必要です: ${id}`);
    if (![item.x, item.y].every(nonnegative) || ![item.w, item.d].every(positive)) return;
    if (item.x + item.w > booth.width || item.y + item.d > booth.depth) errors.push(`範囲外: ${id}`);
    for (const prev of rectangles) {
      if (item.x < prev.x + prev.w && prev.x < item.x + item.w && item.y < prev.y + prev.d && prev.y < item.y + item.d) errors.push(`重なり: ${prev.id} x ${id}`);
    }
    rectangles.push({ ...item, id });
    if (item.y < rules.minAisleMm) {
      if (item.type !== 'counter') errors.push(`前面動線侵入: ${id}`);
      else counterWidth += item.w;
    }
  });
  if (counterWidth > booth.width * rules.frontBandCounterMaxWidthRatio) errors.push('前面開口不足');
  return { ok: errors.length === 0, errors };
}

const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function renderBoothPlanSvg(spec) {
  const result = validateBoothPlan(spec);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const { width, depth, openSides } = spec.booth;
  const frontOpen = Array.isArray(openSides) && openSides.includes('front');
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-600 -600 ${width + 1200} ${depth + 2800}" font-family="sans-serif">`, '<g stroke="#e2e8f0" stroke-width="4">'];
  if (spec.meta.grid) {
    for (let x = spec.meta.grid; x < width; x += spec.meta.grid) lines.push(`<path d="M ${x} 0 V ${depth}"/>`);
    for (let y = spec.meta.grid; y < depth; y += spec.meta.grid) lines.push(`<path d="M 0 ${y} H ${width}"/>`);
  }
  lines.push('</g>', `<path d="M 0 0 V ${depth} H ${width} V 0" fill="none" stroke="black" stroke-width="16"/>`, `<path d="M 0 0 H ${width}" stroke="black" stroke-width="16"${frontOpen ? ' stroke-dasharray="100 60"' : ''}/>`);
  if (frontOpen) lines.push(`<text x="${width / 2}" y="-180" text-anchor="middle" font-size="140">OPEN</text>`);
  for (const item of spec.items) {
    const cx = item.x + item.w / 2;
    const cy = item.y + item.d / 2;
    lines.push(`<g><rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.d}" fill="${colors[item.type]}" stroke="black" stroke-width="8"/>`, `<text x="${cx}" y="${cy - 80}" text-anchor="middle" font-size="120">${escapeXml(item.label)}</text>`, `<text x="${cx}" y="${cy + 45}" text-anchor="middle" font-size="90">${item.w}×${item.d}</text>`, `<text x="${cx}" y="${cy + 140}" text-anchor="middle" font-size="70" fill="#64748b">${escapeXml(item.id)}</text></g>`);
  }
  const legend = [spec.meta.name, `縮尺: ${spec.meta.scale ?? ''}`, `面積: ${(width * depth / 1e6).toFixed(2)} m²`, ...(spec.meta.date !== undefined ? [`日付: ${spec.meta.date}`] : []), `item数: ${spec.items.length}`];
  lines.push(`<g transform="translate(0 ${depth + 600})"><rect width="${width}" height="1600" fill="#f8fafc"/>`);
  legend.forEach((text, i) => lines.push(`<text x="100" y="${240 + i * 260}" font-size="140">${escapeXml(text)}</text>`));
  lines.push('</g>', '</svg>');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  try {
    let specPath, outPath, check = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--help') { process.stdout.write('使い方: node tools/booth-plan-svg.mjs --spec <path|-> [--out <path>] [--check]\n'); return 0; }
      if (arg === '--check') { check = true; continue; }
      if ((arg === '--spec' || arg === '--out') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        if (arg === '--spec') specPath = argv[++i]; else outPath = argv[++i];
      } else throw new Error(`引数が不正です: ${arg}`);
    }
    if (!specPath) throw new Error('--spec が必要です');
    let raw;
    try {
      if (specPath === '-') {
        process.stdin.setEncoding('utf8');
        raw = '';
        for await (const chunk of process.stdin) raw += chunk;
      } else raw = await readFile(specPath, 'utf8');
    } catch { throw new Error(`仕様ファイルを読み込めません: ${specPath}`); }
    let spec;
    try { spec = JSON.parse(raw); } catch { throw new Error('JSON構文エラー: 仕様JSONを解析できません'); }
    const result = validateBoothPlan(spec);
    if (!result.ok) { result.errors.forEach(error => process.stderr.write(`${error}\n`)); return 1; }
    if (!check) {
      const svg = renderBoothPlanSvg(spec);
      if (outPath) {
        try { await writeFile(outPath, svg, 'utf8'); } catch { throw new Error(`SVGファイルを書き込めません: ${outPath}`); }
      } else process.stdout.write(svg);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
