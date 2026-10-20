/** 規格材の順不同組合せを列挙し、指定幅への割付候補を返す。 */
function ModuleFit_solve(targetMm, parts, opts) {
  opts = opts || {};
  const maxPieces = Math.max(0, Math.floor(Number(opts.maxPieces == null ? 8 : opts.maxPieces)));
  const topN = Math.max(0, Math.floor(Number(opts.topN == null ? 5 : opts.topN)));
  targetMm = Number(targetMm);
  if (!(targetMm > 0) || !Array.isArray(parts) || !parts.length || !maxPieces) {
    return { exact: [], closest: [] };
  }
  const normalized = parts.map(function (p, index) {
    const stockNumber = p && p.stock != null ? Math.floor(Number(p.stock)) : Infinity;
    return {
      name: String(p && p.name || ''), width: Number(p && p.width),
      stock: Number.isFinite(stockNumber) ? Math.max(0, stockNumber) : Infinity,
      index: index
    };
  }).filter(function (p) { return p.name && p.width > 0 && p.stock > 0; })
    .sort(function (a, b) { return b.width - a.width || a.name.localeCompare(b.name); });
  if (!normalized.length) return { exact: [], closest: [] };

  const all = [];
  const counts = new Array(normalized.length).fill(0);
  function visit(index, used, total) {
    if (index === normalized.length) {
      if (!used) return;
      const pieces = [];
      for (let i = 0; i < normalized.length; i++) if (counts[i]) {
        pieces.push({ name: normalized[i].name, width: normalized[i].width, count: counts[i] });
      }
      all.push({ pieces: pieces, total: total, gap: targetMm - total, pieceCount: used });
      return;
    }
    const part = normalized[index];
    const limit = Math.min(maxPieces - used, part.stock);
    for (let n = 0; n <= limit; n++) {
      counts[index] = n;
      visit(index + 1, used + n, total + n * part.width);
    }
    counts[index] = 0;
  }
  visit(0, 0, 0);
  function kindCount(s) { return s.pieces.length; }
  const exact = all.filter(function (s) { return s.gap === 0; }).sort(function (a, b) {
    return a.pieceCount - b.pieceCount || kindCount(a) - kindCount(b);
  });
  const closest = all.filter(function (s) { return s.gap !== 0; }).sort(function (a, b) {
    // 小間外へのはみ出しを避けるため、足りない側を常に先に提示する。
    const aSide = a.gap > 0 ? 0 : 1;
    const bSide = b.gap > 0 ? 0 : 1;
    return aSide - bSide || Math.abs(a.gap) - Math.abs(b.gap) ||
      a.pieceCount - b.pieceCount || kindCount(a) - kindCount(b);
  }).slice(0, topN);
  return { exact: exact, closest: closest };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { ModuleFit_solve: ModuleFit_solve };
