#!/usr/bin/env node
// ブース提案書のパース（3案）を ChatGPT 系の画像モデル（OpenRouter 経由 openai/gpt-5.4-image-2）で作る。
// 使い方: node tools/booth-perse-gen.mjs --brief <共通ブリーフ.txt> --plans <プラン定義.json> --out <出力フォルダ> [--ref <ロゴ等の画像> ...]
//   プラン定義.json = [{"id":"ume","label":"シンプル","add":"PLAN \"SIMPLE\": ..."}, {...}, {...}]（3件）
//   各プランの画像は <出力フォルダ>/perse-<id>.png に保存し、結果を <出力フォルダ>/perse-result.json に書く
// 鍵は ~/.claude/openrouter.env の OPENROUTER_API_KEY（既存配布物）。1枚あたり約 0.15 ドル（2026-10 実測）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const USAGE = '使い方: node tools/booth-perse-gen.mjs --brief <brief.txt> --plans <plans.json> --out <dir> [--only <plan-id>] [--base <寸法どおりの下絵.png>] [--ref <image> ...] [--blender-out <dir>] [--max-height <m>（会場の装飾高さ上限・既定3.6）] [--model <OpenRouter model>]';
const DEFAULT_MODEL = 'openai/gpt-5.4-image-2';
const DEFAULT_MAX_HEIGHT = 3.6;
const BLENDER_PERSP_FILES = ['persp_front_left.png', 'persp_front_right.png'];

function findBlenderRefs(dir) {
  // 段階 2 の Blender 出力ディレクトリからパース画像を参照画像として自動追加
  try {
    const exists = (f) => { try { return (readFileSync(f).length > 0 && true); } catch { return false; } };
    return BLENDER_PERSP_FILES.filter((f) => exists(path.join(dir, f))).map((f) => path.join(dir, f));
  } catch { return []; }
}

export function parseArgs(argv) {
  const opts = { refs: [], maxHeight: DEFAULT_MAX_HEIGHT, model: DEFAULT_MODEL };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--brief') { opts.brief = v; i += 1; }
    else if (a === '--plans') { opts.plans = v; i += 1; }
    else if (a === '--out') { opts.out = v; i += 1; }
    else if (a === '--only') { opts.only = v; i += 1; }
    else if (a === '--base') { opts.base = v; i += 1; }
    else if (a === '--ref') { opts.refs.push(v); i += 1; }
    else if (a === '--blender-out') { opts.blenderOut = v; i += 1; }
    else if (a === '--max-height') { opts.maxHeight = Number(v); i += 1; }
    else if (a === '--model') { opts.model = v; i += 1; }
    else throw new Error(`unknown option: ${a}\n${USAGE}`);
  }
  for (const k of ['brief', 'plans', 'out']) if (!opts[k]) throw new Error(`--${k} is required\n${USAGE}`);
  if (!(opts.maxHeight > 0)) throw new Error(`--max-height は数値（m）で指定する\n${USAGE}`);
  if (!opts.model) throw new Error(`--model は空にできません\n${USAGE}`);
  return opts;
}

// 高さと明るさは提案の柱なので、ブリーフに書き忘れても全案へ必ず足す（kim 2026-10-27・サポリス案が2.7mで低かった）。
export function heightLightClause(maxHeight = DEFAULT_MAX_HEIGHT) {
  return `MANDATORY HEIGHT & LIGHT (applies to this plan, overrides any taller height above): this is a SINGLE-STOREY exhibition stand. Its overall structure/truss height is about ${maxHeight} m and MUST NOT exceed ${maxHeight} m. It must look like a normal single-level booth within a ${maxHeight} m decoration limit - NEVER a double-height, two-storey or 5-6 m tall hall structure. Keep headers and the top logo sign low, around ${maxHeight} m. The booth must also look BRIGHT - noticeably brighter than the neighbouring booths (spotlights and/or backlit light boxes), graphics evenly lit, no dark corners.

MANDATORY HUMAN SCALE: show multiple people about 1.7 m tall in the foreground as explicit scale references. The highest point of the booth (top edge of any truss or upper logo sign) must be only about twice a person's height (${maxHeight} m) and never higher. The clear space from the people's heads to the ceiling truss should be about one person's height.

MANDATORY PROPORTIONS: the booth footprint is 6 m wide by 6 m deep. Its 6 m width is about 1.7 times its ${maxHeight} m height. From the front, the overall silhouette must look distinctly wider than tall, never vertically elongated.

MANDATORY HALL SCALE: the exhibition hall ceiling is more than 10 m high and must appear far above the booth. Adjacent exhibition booths are only about 2.7-3.6 m high, similar in height to this booth. Preserve a large visible vertical gap between every booth and the hall ceiling.`;
}

export function buildPrompt(common, plan, maxHeight = DEFAULT_MAX_HEIGHT) {
  return `${common}\n${plan.add}\n${heightLightClause(maxHeight)}\n
MANDATORY BASE-IMAGE FIDELITY: The FIRST reference image is a dimensionally accurate 3D underlay. Preserve its composition, camera position and perspective, booth outer envelope, truss top edge, all four column positions, wall position, and every person's size and position EXACTLY. Paint in materials, lighting and brand treatment only. Do NOT make the booth envelope, canopy, columns, signs, or infinity feature taller or larger than the underlay. Keep the three open sides open.

MANDATORY TEXT: Do not draw Japanese text or Japanese signs. The only readable text allowed anywhere is "GridBeyond". No invented words, numbers, prices, or pseudo-lettering.\n`;
}

export function loadKey(home = homedir()) {
  const env = Object.fromEntries(readFileSync(path.join(home, '.claude', 'openrouter.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^(?:export\s+)?([A-Z_0-9]+)\s*=\s*"?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY が ~/.claude/openrouter.env にありません');
  return key;
}

const mime = (p) => (p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
const imagePart = (p) => ({ type: 'image_url', image_url: { url: `data:${mime(p)};base64,${readFileSync(p).toString('base64')}` } });

async function generate({ key, text, refs, out, model }) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, modalities: ['image', 'text'], image_config: { aspect_ratio: '16:9' },
      messages: [{ role: 'user', content: [{ type: 'text', text }, ...refs.map(imagePart)] }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`画像が返らなかった: ${JSON.stringify(j).slice(0, 300)}`);
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  return { model: j.model, cost: j.usage?.cost ?? null };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.blenderOut) {
    const blenderRefs = findBlenderRefs(opts.blenderOut);
    if (blenderRefs.length > 0) {
      opts.refs.push(...blenderRefs);
      console.error(`[blender-out] ${blenderRefs.length} 件のパース画像を参照画像として追加: ${blenderRefs.join(', ')}`);
    } else {
      console.error('[blender-out] 段階2のパース画像が見つかりませんでした（--blender-out は無視して続行）');
    }
  }
  let plans = JSON.parse(readFileSync(opts.plans, 'utf8'));
  if (!Array.isArray(plans) || plans.length !== 3) throw new Error('プラン定義は3件（梅・竹・松に当たる3案）にする');
  if (opts.only) {
    plans = plans.filter((plan) => plan.id === opts.only);
    if (plans.length !== 1) throw new Error(`--only に一致するプランがありません: ${opts.only}`);
  }
  const common = readFileSync(opts.brief, 'utf8');
  if (opts.base) opts.refs.unshift(opts.base);
  const key = loadKey();
  mkdirSync(opts.out, { recursive: true });
  const results = await Promise.all(plans.map(async (p) => {
    const out = path.join(opts.out, `perse-${p.id}.png`);
    try {
      const r = await generate({ key, text: buildPrompt(common, p, opts.maxHeight), refs: opts.refs, out, model: opts.model });
      return { id: p.id, label: p.label, out, ok: true, ...r };
    } catch (e) {
      return { id: p.id, label: p.label, out, ok: false, error: String(e.message || e) };
    }
  }));
  writeFileSync(path.join(opts.out, 'perse-result.json'), JSON.stringify(results, null, 2));
  for (const r of results) console.log(r.ok ? `saved ${r.out} cost ${r.cost}` : `FAILED ${r.id}: ${r.error}`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

if (isEntry(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
