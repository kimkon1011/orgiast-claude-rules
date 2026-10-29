// asset_id の命名規則（build-library.py の base_id() と同じ規則。差異は build-library.mjs が検査する）。
//   kind=length : <slug>_L<最長辺>            例 truss300_silver_L2400
//   kind=panel  : <slug>_<W>x<D>              例 stage_panel_1000x1000
//   kind=box    : <slug>_<W>x<D>x<H>          例 logo_box_500x900x820
// 寸法は mm。step（既定 10mm）の倍数へ四捨五入する（半端は切り上げ。Python の banker's rounding は使わない）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SOURCES_PATH = fileURLToPath(new URL('./stl-sources.json', import.meta.url));

export function roundTo(value, step = 10) {
  return Math.floor(value / step + 0.5) * step;
}

export function assetBaseId(slug, kind, dims, step = 10) {
  if (!/^[a-z0-9_]+$/.test(slug)) throw new Error(`slug は英小文字・数字・_ のみ: ${slug}`);
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error(`dims は [W,D,H] の非負数 3 要素: ${JSON.stringify(dims)}`);
  }
  const [w, d, h] = dims.map((v) => roundTo(v, step));
  if (kind === 'length') return `${slug}_L${Math.max(w, d, h)}`;
  if (kind === 'panel') return `${slug}_${w}x${d}`;
  if (kind === 'box') return `${slug}_${w}x${d}x${h}`;
  throw new Error(`未知の kind: ${kind}`);
}

export function loadSources(file = SOURCES_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
