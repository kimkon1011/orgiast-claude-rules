export const COLUMN_DEFINITIONS = Object.freeze({
  staff: Object.freeze(['スタッフ', '従業員', '氏名', '従業員名', '名前']),
});

export function normalizeHeader(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, '');
}

export function columnLetterToIndex(letter) {
  const normalized = String(letter ?? '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) return -1;
  let value = 0;
  for (const character of normalized) value = value * 26 + character.charCodeAt(0) - 64;
  return value - 1;
}

export function resolveColumn(headers, logicalName, { columnLetters = {}, definitions = COLUMN_DEFINITIONS } = {}) {
  const candidates = definitions[logicalName] ?? [logicalName];
  const normalizedHeaders = headers.map(normalizeHeader);
  const normalizedCandidates = candidates.map(normalizeHeader);
  const exact = normalizedHeaders.flatMap((header, index) => normalizedCandidates.includes(header) ? [index] : []);
  if (exact.length) {
    if (exact.length > 1) console.warn(`列「${logicalName}」が重複しています。先頭の列を使用します。`);
    return { status: 'found', index: exact[0], method: 'exact' };
  }
  const prefix = normalizedHeaders.findIndex((header) => normalizedCandidates.some((candidate) => header.startsWith(candidate)));
  if (prefix >= 0) return { status: 'found', index: prefix, method: 'prefix' };
  const fallback = columnLetterToIndex(columnLetters[logicalName]);
  if (fallback >= 0 && fallback < headers.length) return { status: 'found', index: fallback, method: 'letter' };
  return { status: 'missing', index: -1, method: null };
}

function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0];
  return firstLine.includes('\t') ? '\t' : ',';
}

export function parseDelimited(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === '') quoted = true;
    else if (character === delimiter) { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (character !== '\r') field += character;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '' || rows.length === 0) rows.push(row);
  return rows;
}

export function importScoreTable(text, { criteria = [], columnLetters = {} } = {}) {
  const rows = parseDelimited(text);
  const headers = rows[0] ?? [];
  const staffColumn = resolveColumn(headers, 'staff', { columnLetters });
  const criterionColumns = criteria.map((criterion) => ({
    criterion,
    resolved: resolveColumn(headers, criterion.id, {
      columnLetters,
      definitions: { [criterion.id]: [criterion.name] },
    }),
  }));
  const missing = [];
  if (staffColumn.status === 'missing') missing.push('staff');
  for (const item of criterionColumns) if (item.resolved.status === 'missing') missing.push(item.criterion.id);
  const entries = [];
  const skipped = [];
  if (staffColumn.status === 'missing') return { headers, entries, skipped, missing };
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const staffName = String(row[staffColumn.index] ?? '').trim();
    if (!staffName) continue;
    for (const { criterion, resolved } of criterionColumns) {
      if (resolved.status === 'missing') continue;
      const raw = String(row[resolved.index] ?? '').trim();
      const score = Number(raw);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        skipped.push({ row: rowIndex + 1, staffName, criterionId: criterion.id, value: raw });
      } else entries.push({ staffName, criterionId: criterion.id, criterionName: criterion.name, score });
    }
  }
  return { headers, entries, skipped, missing };
}
