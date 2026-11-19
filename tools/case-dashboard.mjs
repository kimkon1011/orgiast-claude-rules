#!/usr/bin/env node
/**
 * 案件一覧スプレッドシート → 静的HTMLダッシュボード
 *
 * X-0032: 列名と型だけをAIに渡し、行データ（お客様名・金額等）は渡さない試作。
 *
 * 使い方:
 *   node tools/case-dashboard.mjs --schema-only        # 列名+推定型をJSONで表示
 *   node tools/case-dashboard.mjs --out report.html    # HTMLダッシュボード生成
 *
 * 環境変数:
 *   CASE_SHEET_ID    - 案件一覧スプレッドシートのID（既定値は既知のID）
 */

import fs from 'node:fs';
import path from 'node:path';
import { createSheetsClient } from './lib/sheets-dwd.mjs';

// ── 定数 ──────────────────────────────────────────────────────────
const SHEET_ID = process.env.CASE_SHEET_ID || '14RC6og1ma_I3LGHwCVwswKArgHwCOPxWlPB3g8adaYY';
const TAB_NAME = '案件一覧';
const TAB_RANGE = `'${TAB_NAME}'!A:ZZ`;

// ── 型推定 ────────────────────────────────────────────────────────
/** 列の値集合から推定型を返す */
function inferType(values, columnName = '') {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'string';

  // 日付文字列パターン
  const datePattern = /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/;
  const dateLike = nonEmpty.filter(v => datePattern.test(String(v).trim()));
  if (dateLike.length >= nonEmpty.length * 0.7) return 'date';

  // 日付シリアル値パターン（列名に「日」「日付」「date」を含み、値が20000〜80000の数値）
  if (matchColumn(columnName, ['日', '日付', 'date'])) {
    const serialLike = nonEmpty.filter(v => typeof v === 'number' && v >= 20000 && v <= 80000);
    if (serialLike.length >= nonEmpty.length * 0.7) return 'date';
  }

  // 数値（カンマや円記号を含む可能性）
  const numPattern = /^-?[¥$]?\d[\d,]*\.?\d*$/;
  const numLike = nonEmpty.filter(v => numPattern.test(String(v).trim()));
  if (numLike.length >= nonEmpty.length * 0.7) return 'number';

  // 選択肢（ユニーク値が少ない）
  const unique = new Set(nonEmpty.map(v => String(v).trim()));
  if (unique.size <= 12 && unique.size < nonEmpty.length * 0.3) return 'choice';

  return 'string';
}

/** 選択肢の値一覧（choice型のときのみ意味を持つ） */
function choiceValues(values) {
  const uniq = [...new Set(values.filter(v => v !== '' && v !== null && v !== undefined).map(v => String(v).trim()))];
  return uniq.sort();
}

/** 特定の列名パターンにマッチするか */
function matchColumn(name, patterns) {
  const n = name.normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
  return patterns.some(p => n.includes(p));
}

/** Google Sheets シリアル値 → YYYY-MM-DD 文字列 */
function serialToDate(serial) {
  if (typeof serial !== 'number' || serial < 20000 || serial > 80000) return String(serial);
  // 1899-12-30 を起点 0 とする
  const date = new Date(Date.UTC(1899, 11, 30 + Math.floor(serial)));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── HTML 生成 ──────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function escapeJs(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/</g, '\\x3C');
}

/** 列情報からHTMLのJSON埋め込み用に安全な文字列へ */
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003C').replace(/>/g, '\\u003E');
}

/** 列インデックスをアルファベット（A, B, ..., Z, AA, AB, ...）に */
function colIndex(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + n % 26) + s;
  return s;
}

function generateHtml({ headers, types, choiceMap, rows }) {
  // スキップ列（空見出し／#REF!）を除去
  const skipMask = headers.map(h => h === '' || h.startsWith('#REF!'));
  if (skipMask.some(Boolean)) {
    const oldToNew = {};
    let newIdx = 0;
    for (let i = 0; i < headers.length; i++) {
      if (!skipMask[i]) oldToNew[i] = newIdx++;
    }
    headers = headers.filter((_, i) => !skipMask[i]);
    types = types.filter((_, i) => !skipMask[i]);
    choiceMap = Object.fromEntries(
      Object.entries(choiceMap).map(([k, v]) => [oldToNew[Number(k)], v])
    );
    rows = rows.map(r => r.filter((_, i) => !skipMask[i]));
  }

  // 日付シリアル値を YYYY-MM-DD に変換
  const dateIndices = headers.map((h, i) => types[i] === 'date' ? i : -1).filter(i => i >= 0);
  if (dateIndices.length > 0) {
    rows = rows.map(r => {
      const row = [...r];
      for (const di of dateIndices) {
        if (typeof row[di] === 'number' && row[di] >= 20000 && row[di] <= 80000) {
          row[di] = serialToDate(row[di]);
        }
      }
      return row;
    });
  }
  const statusIdx = headers.findIndex((_, i) =>
    matchColumn(headers[i], ['状態', 'フェーズ', 'ステータス', 'ステイタス', 'phase', 'status'])
  );
  const statusChoices = statusIdx >= 0 ? choiceValues(rows.map(r => r[statusIdx] ?? '')) : [];

  // 担当者列の検出
  const personIdx = headers.findIndex((_, i) =>
    matchColumn(headers[i], ['担当者', '担当', 'person', '担当者名', '担当スタッフ'])
  );

  // 日付列名→値の一覧を作る
  const dateColumnNames = dateIndices.map(i => headers[i]);

  // データ行のJSON
  const dataJson = safeJson(rows);

  // CSS
  const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6fa;color:#333;padding:20px}
h1{font-size:24px;margin-bottom:8px;color:#1a1a2e}
.subtitle{color:#666;font-size:14px;margin-bottom:24px}
.dashboard{max-width:1400px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:24px}
.card{background:#fff;border-radius:8px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h3{font-size:13px;color:#666;margin-bottom:4px}
.card .count{font-size:28px;font-weight:700;color:#1a1a2e}
.card .count.empty{color:#999}
.section{background:#fff;border-radius:8px;padding:16px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.section h2{font-size:16px;margin-bottom:12px;color:#1a1a2e;border-bottom:2px solid #e8e8e8;padding-bottom:8px}
.section .empty{color:#999;font-style:italic;padding:8px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f2f5;text-align:left;padding:8px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;position:relative;border-bottom:1px solid #ddd}
th:hover{background:#e4e7ec}
th .arrow{font-size:10px;margin-left:4px;color:#999}
td{padding:6px 8px;border-bottom:1px solid #eee;max-width:300px;overflow:hidden;text-overflow:ellipsis}
tr:hover td{background:#fafbfc}
.filter-row{margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px}
.filter-row input,.filter-row select{padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px}
.filter-row input{flex:1;min-width:120px}
.filter-row select{min-width:100px}
.person-bar{margin:4px 0;display:flex;align-items:center;gap:8px}
.person-bar .name{min-width:100px;font-size:13px}
.person-bar .bar-bg{flex:1;height:20px;background:#e8e8e8;border-radius:4px;overflow:hidden}
.person-bar .bar-fill{height:100%;background:#4a6cf7;border-radius:4px;transition:width .3s}
.person-bar .count-num{min-width:40px;font-size:12px;color:#666;text-align:right}
@media(prefers-color-scheme:dark){body{background:#1a1a2e;color:#e0e0e0}.section,.card{background:#2d2d44;box-shadow:0 1px 3px rgba(0,0,0,.3)}h1{color:#e0e0e0}
th{background:#3d3d54;color:#ddd;border-bottom:1px solid #555}td{border-bottom:1px solid #3d3d54;color:#ccc}
tr:hover td{background:#35354c}.section h2{color:#e0e0e0;border-bottom-color:#444}.card h3{color:#aaa}
.card .count{color:#e0e0e0}.filter-row input,.filter-row select{background:#3d3d54;color:#ddd;border-color:#555}
.person-bar .bar-bg{background:#3d3d54}.person-bar .bar-fill{background:#6b8cff}.subtitle{color:#aaa}}
`.trim();

  // JS
  const headersJson = safeJson(headers);

  const js = `
const DATA = ${dataJson};
const HEADERS = ${headersJson};
const STATUS_IDX = ${statusIdx};
const PERSON_IDX = ${personIdx};
const DATE_IDXS = ${safeJson(dateIndices)};

let filteredData = [...DATA];
let sortCol = -1, sortAsc = true;

function renderCards() {
  const el = document.getElementById('status-cards');
  if (STATUS_IDX < 0) { el.innerHTML = '<p class="empty">状態列がありません</p>'; return; }
  const counts = {};
  for (const r of filteredData) {
    const v = (r[STATUS_IDX] || '').trim() || '(未設定)';
    counts[v] = (counts[v] || 0) + 1;
  }
  el.innerHTML = Object.entries(counts).map(([k, v]) =>
    '<div class="card"><h3>' + esc(k) + '</h3><div class="count">' + v + '</div></div>'
  ).join('');
}

function renderPersonChart() {
  const el = document.getElementById('person-chart');
  if (PERSON_IDX < 0) { el.innerHTML = '<p class="empty">担当者列がありません</p>'; return; }
  const counts = {};
  for (const r of filteredData) {
    const v = (r[PERSON_IDX] || '').trim() || '(未設定)';
    if (!v) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.innerHTML = '<p class="empty">データがありません</p>'; return; }
  const max = entries[0][1];
  el.innerHTML = entries.map(([k, v]) =>
    '<div class="person-bar"><span class="name">' + esc(k) + '</span>' +
    '<div class="bar-bg"><div class="bar-fill" style="width:' + (v / max * 100) + '%"></div></div>' +
    '<span class="count-num">' + v + '</span></div>'
  ).join('');
}

function renderSchedule() {
  const el = document.getElementById('schedule');
  if (!DATE_IDXS.length) { el.innerHTML = '<p class="empty">日付列がありません</p>'; return; }
  const now = new Date();
  const thisMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const nextMonth = now.getMonth() === 11
    ? (now.getFullYear() + 1) + '-01'
    : now.getFullYear() + '-' + String(now.getMonth() + 2).padStart(2, '0');
  const schedules = [];
  for (const r of filteredData) {
    for (const di of DATE_IDXS) {
      const v = (r[di] || '').trim();
      if (!v) continue;
      const d = v.replace(/\\//g, '-');
      if (d.startsWith(thisMonth) || d.startsWith(nextMonth)) {
        schedules.push({ date: d, dateCol: HEADERS[di], row: r });
      }
    }
  }
  schedules.sort((a, b) => a.date.localeCompare(b.date) || a.dateCol.localeCompare(b.dateCol));
  if (!schedules.length) { el.innerHTML = '<p class="empty">今月〜来月の予定はありません</p>'; return; }
  const rows = schedules.map(s =>
    '<tr><td>' + esc(s.date) + '</td><td>' + esc(s.dateCol) + '</td>' +
    HEADERS.map((h, i) => '<td>' + esc(s.row[i] || '') + '</td>').join('') + '</tr>'
  ).join('');
  el.innerHTML = '<table><thead><tr><th>日付</th><th>列</th>' +
    HEADERS.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderTable() {
  const el = document.getElementById('table-body');
  let data = [...filteredData];
  if (sortCol >= 0) {
    data.sort((a, b) => {
      const va = (a[sortCol] || ''), vb = (b[sortCol] || '');
      const cmp = va.localeCompare(vb, 'ja', { numeric: true });
      return sortAsc ? cmp : -cmp;
    });
  }
  el.innerHTML = data.map(r =>
    '<tr>' + r.map((c, i) => '<td>' + esc(c) + '</td>').join('') + '</tr>'
  ).join('');
}

function applyFilter() {
  const filters = {};
  for (const [col, el] of Object.entries(filterEls)) {
    const val = el.value.trim();
    if (val) filters[col] = val;
  }
  filteredData = DATA.filter(r => {
    for (const [col, val] of Object.entries(filters)) {
      const cell = String(r[col] || '');
      if (HEADERS[col] && HEADERS[col] !== val && cell !== val && !cell.toLowerCase().includes(val.toLowerCase())) return false;
    }
    return true;
  });
  renderCards();
  renderPersonChart();
  renderSchedule();
  renderTable();
}

function sortBy(col) {
  if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
  renderTable();
}

const filterEls = {};
let filterRowHtml = '';
function initFilters() {
  filterRowHtml = HEADERS.map((h, i) => {
    const isChoice = ${safeJson(choiceMap)};
    const choices = isChoice[i] || null;
    if (choices && choices.length <= 20) {
      filterEls[i] = { value: '' };
      return '<label>' + esc(h) +
        '<select onchange="filterVal(' + i + ',this.value)">' +
        '<option value="">すべて</option>' +
        choices.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('') +
        '</select></label>';
    }
    if (i > 5) return '';
    filterEls[i] = { value: '' };
    return '<input type="text" placeholder="' + esc(h) + '" oninput="filterVal(' + i + ',this.value)">';
  }).filter(Boolean).join('');
  document.getElementById('filter-row').innerHTML = filterRowHtml;
}
function filterVal(col, val) {
  filterEls[col].value = val;
  applyFilter();
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

renderCards();
renderPersonChart();
renderSchedule();
initFilters();
renderTable();
`.trim();

  // ── セクション有無の判定 ──
  const hasStatus = statusIdx >= 0;
  const hasPerson = personIdx >= 0;
  const hasDate  = dateIndices.length > 0;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>案件ダッシュボード</title>
<style>${css}</style>
</head>
<body>
<div class="dashboard">
<h1>案件ダッシュボード</h1>
<p class="subtitle">${escapeHtml(TAB_NAME)} · ${rows.length}件</p>

${hasStatus ? `<div class="section"><h2>状態別件数</h2><div class="cards" id="status-cards"></div></div>` : ''}

${hasPerson ? `<div class="section"><h2>担当者別件数</h2><div id="person-chart"></div></div>` : ''}

${hasDate ? `<div class="section"><h2>今月〜来月の予定</h2><div id="schedule"></div></div>` : ''}

<div class="section">
<h2>全件一覧</h2>
<div class="filter-row" id="filter-row"></div>
<table>
<thead><tr>${headers.map((h, i) => `<th onclick="sortBy(${i})">${escapeHtml(h)}<span class="arrow" id="sort-${i}"></span></th>`).join('')}</tr></thead>
<tbody id="table-body"></tbody>
</table>
</div>
</div>
<script>${js}</script>
</body>
</html>`;
}

// ── スキーマ出力 ─────────────────────────────────────────────────────
/** 列情報から `--schema-only` 出力用のスキーマ配列を生成 */
function buildSchema(headers, types, choiceMap) {
  return headers.map((name, i) => {
    const col = {
      index: i,
      col: colIndex(i),
      name,
      type: types[i],
    };
    if (name === '' || name.startsWith('#REF!')) {
      col.skipped = true;
    }
    if (types[i] === 'choice') {
      col.distinct = choiceMap[i]?.length || 0;
    }
    return col;
  });
}

// ── メイン ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const schemaOnly = args.includes('--schema-only');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 && outIdx + 1 < args.length ? args[outIdx + 1] : null;

  if (!schemaOnly && !outPath) {
    console.error('使い方: node tools/case-dashboard.mjs --schema-only | --out <path.html>');
    process.exit(1);
  }

  const client = createSheetsClient();
  let values;
  try {
    values = await client.get(SHEET_ID, TAB_RANGE);
  } catch (err) {
    console.error(`シート読み取り失敗: ${err.message}`);
    process.exit(1);
  }

  if (!values.length) {
    console.error('シートが空です');
    process.exit(1);
  }

  // ヘッダ行を探す（「案件ID」または「ｺｰﾄﾞ」を含む行をヘッダとみなす）
  const headerIdx = values.findIndex(row =>
    row.some(v => {
      const n = String(v ?? '').normalize('NFKC').replace(/[\s　]/g, '');
      return n === '案件id' || n === 'コード' || n === 'ｺｰﾄﾞ';
    }) && row.some(v => {
      const n = String(v ?? '').normalize('NFKC').replace(/[\s　]/g, '');
      return n === '案件名';
    })
  );

  if (headerIdx < 0) {
    console.error('ヘッダ行が見つかりません（案件ID/コード + 案件名 が必要）');
    process.exit(1);
  }

  const headers = values[headerIdx].map(v => String(v ?? '').trim());
  const dataRows = values.slice(headerIdx + 1).filter(r => r.some(v => v !== '' && v !== null && v !== undefined));

  // 列ごとに値を収集して型推定
  const colValues = headers.map((_, i) => dataRows.map(r => r[i] ?? ''));
  const types = colValues.map((vals, i) => inferType(vals, headers[i]));
  const choiceMap = {};
  headers.forEach((h, i) => {
    if (types[i] === 'choice') {
      choiceMap[i] = choiceValues(colValues[i]);
    }
  });

  if (schemaOnly) {
    const schema = buildSchema(headers, types, choiceMap);
    const info = {
      sheetId: SHEET_ID,
      tab: TAB_NAME,
      headerRow: headerIdx,
      columns: schema,
      totalRows: dataRows.length,
    };
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  // HTML生成
  const html = generateHtml({ headers, types, choiceMap, rows: dataRows });
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`ダッシュボードを書き出しました: ${path.resolve(outPath)}`);
}

// ── CLI ────────────────────────────────────────────────────────────
const isMain = process.argv[1] && (process.argv[1] === import.meta.filename || path.resolve(process.argv[1]) === import.meta.filename);
if (isMain) main().catch(err => { console.error(err.message); process.exit(1); });

export { inferType, choiceValues, matchColumn, serialToDate, buildSchema, generateHtml, SHEET_ID, TAB_NAME };