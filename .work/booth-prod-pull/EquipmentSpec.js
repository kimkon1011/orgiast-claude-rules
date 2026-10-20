const EQUIPMENT_INVENTORY_SS_ID = '1QCW86DIri6nryqheFKw8Cr6e9Ce0YRV6FvFFW0zqBnc';
const EQUIPMENT_INVENTORY_SHEET = '備品在庫管理表';
const EQUIPMENT_INVENTORY_CACHE_KEY = 'EquipmentSpec_inventory_v1';
const EQUIPMENT_INVENTORY_CACHE_TTL_SEC = 21600;

function _EquipmentSpec_normalize(s) {
  return String(s || '').normalize('NFKC').replace(/[\u3000\s]+/g, ' ').trim();
}

function _EquipmentSpec_toMm(value, unit) {
  value = Number(value);
  unit = String(unit || 'mm').toLowerCase();
  if (!(value > 0)) return null;
  if (unit === 'mm') return value;
  if (unit === 'cm') return value * 10;
  if (unit === 'm') return value * 1000;
  return null;
}

/** スライド本文から寸法と数量を抽出する純関数。 */
function EquipmentSpec_parseSlideText(bodyText) {
  const originalLines = String(bodyText || '').split(/\r?\n/);
  const lines = originalLines.map(_EquipmentSpec_normalize);
  const dims = [], counts = [];
  const dimensionUnit = /(?:^|[^a-z])(mm|cm|m)(?:\b|$)/i;
  lines.forEach(function (line, i) {
    if (!line) return;
    const raw = originalLines[i];
    const unitMatch = line.match(dimensionUnit);
    const unit = unitMatch ? unitMatch[1].toLowerCase() : 'mm';
    let found = false;
    // W/D/H ラベル付き（順不同、2軸可）。
    const labelled = {};
    const labelRe = /([WHD])\s*([0-9]+(?:\.[0-9]+)?)(?:\s*(mm|cm|m))?/gi;
    let lm;
    while ((lm = labelRe.exec(line))) {
      const mm = _EquipmentSpec_toMm(lm[2], lm[3] || unit);
      if (mm != null) labelled[lm[1].toLowerCase()] = mm;
    }
    if (Object.keys(labelled).length >= 2) {
      dims.push(Object.assign({ raw: raw }, labelled)); found = true;
    }
    // 直径900×H720mm
    const diameter = line.match(/直径\s*([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*H\s*([0-9]+(?:\.[0-9]+)?)\s*(mm|cm|m)/i);
    if (!found && diameter) {
      dims.push({ w: _EquipmentSpec_toMm(diameter[1], diameter[3]), h: _EquipmentSpec_toMm(diameter[2], diameter[3]), raw: raw });
      found = true;
    }
    // 990×2700×22 / 注釈が軸値の後に挟まる形式。
    const plain = line.match(/([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)(?:[^0-9x×|]{0,30})\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (!found && plain && (unitMatch || /幅.*高さ|奥行|厚み/.test(lines[Math.max(0, i - 1)] || ''))) {
      const factorUnit = unitMatch ? unit : 'mm';
      dims.push({ w: _EquipmentSpec_toMm(plain[1], factorUnit), h: _EquipmentSpec_toMm(plain[2], factorUnit), d: _EquipmentSpec_toMm(plain[3], factorUnit), raw: raw });
    }

    const countRe = /([^\s:：|×x]{1,40})\s*(?:[:：]\s*)?(?:部分)?\s*[×x]\s*([0-9]+)\s*(枚|台|個|本|脚|セット)/g;
    let cm;
    while ((cm = countRe.exec(line))) counts.push({ label: cm[1], qty: Number(cm[2]), unit: cm[3] });
    const genericCount = line.match(/(?:台数|個数)\s*[:：]\s*([^0-9×x\n]*?)\s*(?:[×x]\s*)?([0-9]+)\s*(枚|台|個|本|脚|セット)/);
    if (genericCount && !counts.some(function (c) { return c.qty === Number(genericCount[2]) && c.unit === genericCount[3] && raw.indexOf(c.label) >= 0; })) {
      counts.push({ label: (genericCount[1] || line.split(/[:：]/)[0]).trim(), qty: Number(genericCount[2]), unit: genericCount[3] });
    }
    const tableCount = line.match(/^(.+?)\s*[|｜]\s*([0-9]+)\s*[|｜]\s*(枚|台|個|本|脚|セット)\s*$/);
    if (tableCount) counts.push({ label: tableCount[1].trim(), qty: Number(tableCount[2]), unit: tableCount[3] });
    const bareCount = line.match(/(?:^|\s)[×x]\s*([0-9]+)\s*(枚|台|個|本|脚|セット)/);
    if (bareCount && !counts.some(function (c) { return c.qty === Number(bareCount[1]) && c.unit === bareCount[2]; })) {
      counts.push({ label: line.slice(0, bareCount.index).trim(), qty: Number(bareCount[1]), unit: bareCount[2] });
    }
  });
  return { dims: dims, counts: counts };
}

function EquipmentSpec_matchPartName(inventoryName, partName) {
  function key(v) { return _EquipmentSpec_normalize(v).toLowerCase().replace(/[\s・()（）\[\]【】_-]/g, ''); }
  const a = key(inventoryName), b = key(partName);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0));
}

/** 備品在庫管理表をヘッダ名で解決して読む。失敗時は安全な空結果。 */
function EquipmentSpec_readInventory() {
  const empty = { rows: [], headerRow: 0, resolvedCols: {} };
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(EQUIPMENT_INVENTORY_CACHE_KEY);
    if (cached) {
      const meta = JSON.parse(cached);
      if (meta && meta.chunkCount) {
        let joined = '';
        for (let ci = 0; ci < meta.chunkCount; ci++) {
          const chunk = cache.get(EQUIPMENT_INVENTORY_CACHE_KEY + '_' + ci);
          if (!chunk) { joined = ''; break; }
          joined += chunk;
        }
        if (joined) return JSON.parse(joined);
      } else if (meta && meta.rows) return meta; // 旧単一エントリとの互換
    }
    const sh = SpreadsheetApp.openById(EQUIPMENT_INVENTORY_SS_ID).getSheetByName(EQUIPMENT_INVENTORY_SHEET);
    if (!sh) return empty;
    const values = sh.getDataRange().getDisplayValues();
    const required = ['備品コード', '品名', '倉庫在庫数'];
    let headerIndex = -1, cols = {};
    for (let r = 0; r < Math.min(values.length, 50); r++) {
      const candidate = {};
      values[r].forEach(function (v, c) { const h = _EquipmentSpec_normalize(v); if (h) candidate[h] = c; });
      if (required.every(function (h) { return candidate[h] != null; })) { headerIndex = r; cols = candidate; break; }
    }
    if (headerIndex < 0) return empty;
    const resolved = {};
    ['備品コード', '品名', '倉庫在庫数', '単位', '分類', '倉庫場所', '備考'].forEach(function (h) {
      if (cols[h] != null) resolved[h] = cols[h] + 1;
    });
    const rows = values.slice(headerIndex + 1).map(function (row) {
      return { code: row[cols['備品コード']] || '', name: row[cols['品名']] || '', stock: Number(String(row[cols['倉庫在庫数']] || '').replace(/,/g, '')), unit: cols['単位'] == null ? '' : row[cols['単位']], location: cols['倉庫場所'] == null ? '' : row[cols['倉庫場所']], note: cols['備考'] == null ? '' : row[cols['備考']] };
    }).filter(function (r) { return r.name && Number.isFinite(r.stock); });
    const result = { rows: rows, headerRow: headerIndex + 1, resolvedCols: resolved };
    // 1エントリ上限を避け、6時間キャッシュを分割保存する。
    try {
      const serialized = JSON.stringify(result);
      const chunkSize = 80000;
      const chunkCount = Math.ceil(serialized.length / chunkSize);
      for (let ci = 0; ci < chunkCount; ci++) cache.put(EQUIPMENT_INVENTORY_CACHE_KEY + '_' + ci, serialized.slice(ci * chunkSize, (ci + 1) * chunkSize), EQUIPMENT_INVENTORY_CACHE_TTL_SEC);
      cache.put(EQUIPMENT_INVENTORY_CACHE_KEY, JSON.stringify({ chunkCount: chunkCount }), EQUIPMENT_INVENTORY_CACHE_TTL_SEC);
    } catch (e) {}
    return result;
  } catch (e) { return empty; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  EquipmentSpec_parseSlideText: EquipmentSpec_parseSlideText,
  EquipmentSpec_matchPartName: EquipmentSpec_matchPartName
};
