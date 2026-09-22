var PANEL_PENDING_TITLE = '⏳ 依頼したけれど、まだ終わっていないこと';
var PANEL_PENDING_MARKER = '__PENDING__';
var PANEL_PENDING_MAX = 25;
// 1カテゴリの表示上限。実測(C0038)で期限切れの提出書類が50件あり、
// 期限切れ優先だけで並べると上位25件が全部それで埋まって購買・要確認が1件も見えなくなった。
var PANEL_PENDING_MAX_PER_CATEGORY = 6;

function PanelPending_categoryRank(category) {
  var order = ['要人手', '要確認', '購買部で手配中', '購買部へ未送信', 'AI実行待ち', 'AI実行中', '残タスク'];
  var rank = order.indexOf(String(category || ''));
  return rank < 0 ? order.length : rank;
}

/**
 * カテゴリごとに上限を設けて表示分を選ぶ。
 * 期限切れ優先の素の並びだけだと、件数の多い1カテゴリが枠を全部食って
 * 他のカテゴリ(購買・要確認)が画面から消えるため、まず各カテゴリに枠を配ってから
 * 余った枠を全体の優先順で埋める。
 */
function PanelPending_select(items, max, maxPerCategory) {
  max = Number(max) || PANEL_PENDING_MAX;
  maxPerCategory = Number(maxPerCategory) || PANEL_PENDING_MAX_PER_CATEGORY;
  var sorted = PanelPending_sort(items);
  if (sorted.length <= max) return { items: sorted, hidden: 0, hiddenByCategory: '' };
  var perCategory = {}, picked = [], pickedSet = [];
  sorted.forEach(function (item) {
    var key = String(item.category || '');
    if ((perCategory[key] || 0) >= maxPerCategory || picked.length >= max) return;
    perCategory[key] = (perCategory[key] || 0) + 1;
    picked.push(item);
    pickedSet.push(item);
  });
  sorted.forEach(function (item) {
    if (picked.length >= max || pickedSet.indexOf(item) >= 0) return;
    picked.push(item);
    pickedSet.push(item);
  });
  picked = PanelPending_sort(picked);
  var hiddenCounts = {};
  sorted.forEach(function (item) {
    if (pickedSet.indexOf(item) >= 0) return;
    var key = String(item.category || '');
    hiddenCounts[key] = (hiddenCounts[key] || 0) + 1;
  });
  var summary = Object.keys(hiddenCounts).sort(function (a, b) {
    return PanelPending_categoryRank(a) - PanelPending_categoryRank(b);
  }).map(function (key) { return key + ' ' + hiddenCounts[key] + '件'; }).join(' / ');
  return { items: picked, hidden: sorted.length - picked.length, hiddenByCategory: summary };
}

function PanelPending_sort(items) {
  return (items || []).slice().sort(function (a, b) {
    if (Boolean(a.overdue) !== Boolean(b.overdue)) return a.overdue ? -1 : 1;
    var categoryDiff = PanelPending_categoryRank(a.category) - PanelPending_categoryRank(b.category);
    if (categoryDiff) return categoryDiff;
    return Number(a.sortKey == null ? Infinity : a.sortKey) - Number(b.sortKey == null ? Infinity : b.sortKey);
  });
}

function _PanelPending_date(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  var text = String(value || '').trim(), match = /^(?:(\d{4})[\/-])?(\d{1,2})[\/-](\d{1,2})/.exec(text);
  if (!match) return null;
  var now = new Date(), date = new Date(Number(match[1] || now.getFullYear()), Number(match[2]) - 1, Number(match[3]));
  return isNaN(date.getTime()) ? null : date;
}

function _PanelPending_format(value, pattern) {
  var date = _PanelPending_date(value);
  return date ? Utilities.formatDate(date, 'Asia/Tokyo', pattern) : String(value || '').trim();
}

/**
 * シートURLに行アンカーを足す。
 * gid だけのURLで開くと Sheets が「前回そのシートを見ていた位置」を復元するので、
 * 該当タスクではなく無関係な空行に着地する (2026-09-03 実際に「開くと空っぽ」と報告された)。
 */
function _PanelPending_rowUrl(sheetUrl, rowIndex) {
  var url = String(sheetUrl || '');
  var row = Number(rowIndex);
  if (!url || !(row > 0)) return url;
  return url + (url.indexOf('#') >= 0 ? '&' : '#') + 'range=A' + row;
}

function _PanelPending_panelForCase(ms, caseId) {
  var current = _JobQueue_currentPanel();
  var direct = current ? ms.getSheetByName(current) : null;
  try {
    if (direct && String(direct.getRange('G4').getValue() || '') === String(caseId || '')) return direct;
  } catch (e) {}
  return ms.getSheets().filter(function (sheet) {
    try { return _Panel_isMarker(String(sheet.getRange('G1').getValue())) && String(sheet.getRange('G4').getValue() || '') === String(caseId || ''); }
    catch (e) { return false; }
  })[0] || null;
}

function PanelPending_collect(caseId) {
  var items = [], errors = [], now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  try {
    var read = TaskLedger_readRows(caseId);
    read.rows.forEach(function (row) {
      if (row.status === '完了' || row.status === '不要' || row.source === 'master工程') return;
      var due = _PanelPending_date(row.due);
      var category = row.status === 'AI実行済(要確認)' ? '要確認' : row.status === '実行中' ? 'AI実行中' : row.status === '要人手' ? '要人手' : '残タスク';
      items.push({ category: category, label: String(row.taskName || ''), detail: [row.source, due ? '期限 ' + _PanelPending_format(due, 'M/d') : ''].filter(function (x) { return x; }).join(' / '), url: _PanelPending_rowUrl(read.sheetUrl, row.rowIndex), overdue: Boolean(due && due < today), sortKey: due ? due.getTime() : Infinity, taskId: String(row.taskId || '') });
    });
  } catch (e) { errors.push('タスク台帳: ' + e); }

  try {
    var zissi = _Procure_openZissi(c), itemSheet = _Procure_itemSheet(zissi), cols = _Procure_findColumns(itemSheet);
    if (cols && cols['品名'] && cols['ステータス']) {
      var lastRow = itemSheet.getLastRow(), lastColumn = itemSheet.getLastColumn();
      var values = lastRow >= 3 ? itemSheet.getRange(3, 1, lastRow - 2, lastColumn).getValues() : [];
      var displays = lastRow >= 3 ? itemSheet.getRange(3, 1, lastRow - 2, lastColumn).getDisplayValues() : [];
      var itemUrl = PanelLinks_sheetUrl(zissi, itemSheet);
      values.forEach(function (row, i) {
        var name = String(displays[i][cols['品名'] - 1] || '').trim();
        if (!name) return;
        var status = String(displays[i][cols['ステータス'] - 1] || '').trim();
        var approved = cols['承認(kim)'] && row[cols['承認(kim)'] - 1] === true;
        var due = cols['必着日'] ? _PanelPending_date(row[cols['必着日'] - 1]) : null;
        var rowUrl = _PanelPending_rowUrl(itemUrl, i + 3);
        if (status === '手配依頼済' && (!cols['荷物問合せ番号'] || !String(displays[i][cols['荷物問合せ番号'] - 1] || '').trim())) {
          var sentAt = cols['手配依頼日時'] ? displays[i][cols['手配依頼日時'] - 1] : '';
          items.push({ category: '購買部で手配中', label: name, detail: [due ? '必着 ' + _PanelPending_format(due, 'M/d') : '', sentAt ? '手配依頼 ' + sentAt : ''].filter(function (x) { return x; }).join(' / '), url: rowUrl, overdue: Boolean(due && due < today), sortKey: due ? due.getTime() : Infinity, taskId: '' });
        } else if (approved && status !== '手配依頼済') {
          items.push({ category: '購買部へ未送信', label: name, detail: '▶「📮 承認済みを購買部へ手配依頼」を押すと送られます', url: rowUrl, overdue: Boolean(due && due < today), sortKey: due ? due.getTime() : Infinity, taskId: '' });
        }
      });
    }
  } catch (e) { errors.push('購買: ' + e); }

  try {
    var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS), panel = _PanelPending_panelForCase(ms, caseId), queue = ms.getSheetByName(_JOBQUEUE_SHEET);
    if (panel && queue && queue.getLastRow() >= 2) {
      var queueValues = queue.getRange(2, 1, queue.getLastRow() - 1, _JOBQUEUE_HEADERS.length).getValues();
      queueValues.forEach(function (row) {
        var status = String(row[10] || '');
        if (String(row[3] || '') !== panel.getName() || (status !== '待機' && status !== '実行中')) return;
        var received = row[1] instanceof Date ? row[1] : new Date(row[1]);
        var time = isNaN(received.getTime()) ? Infinity : received.getTime();
        items.push({ category: 'AI実行待ち', label: String(row[6] || ''), detail: time === Infinity ? '' : '受付 ' + Utilities.formatDate(received, 'Asia/Tokyo', 'M/d HH:mm'), url: '', overdue: time !== Infinity && now.getTime() - time >= 30 * 60 * 1000, sortKey: time, taskId: '' });
      });
    }
  } catch (e) { errors.push('AI実行待ち: ' + e); }

  var total = items.length, selection = PanelPending_select(items);
  if (selection.hidden > 0) {
    var ledgerUrl = '';
    try { ledgerUrl = TaskLedger_readRows(caseId).sheetUrl; } catch (e) {}
    selection.items.push({ category: '残タスク', label: 'ほか ' + selection.hidden + ' 件（台帳を開く）', detail: selection.hiddenByCategory, url: ledgerUrl, overdue: false, sortKey: Infinity, taskId: '' });
  }
  return { items: selection.items, counts: { total: total, displayed: selection.items.length, errors: errors.length }, errors: errors };
}

/** 「チェック有り」行のうち H 列に taskId がある行だけ拾う。真偽の取り違え防止で === true のみ通す。 */
function PanelPending_checkedTaskIds(checkValues, taskIdValues) {
  var out = [];
  (checkValues || []).forEach(function (row, i) {
    var checked = Array.isArray(row) ? row[0] : row;
    if (checked !== true) return;
    var rawRow = (taskIdValues || [])[i];
    var rawValue = Array.isArray(rawRow) ? rawRow[0] : rawRow;
    var taskId = String(rawValue == null ? '' : rawValue).trim();
    if (taskId) out.push(taskId);
  });
  return out;
}

function PanelPending_write(panelSheet, caseId) {
  var markers = panelSheet.getRange(1, 7, panelSheet.getMaxRows(), 1).getValues(), markerRow = -1;
  for (var i = 0; i < markers.length; i++) if (String(markers[i][0] || '') === PANEL_PENDING_MARKER) { markerRow = i + 1; break; }
  if (markerRow > 0) panelSheet.deleteRows(markerRow, panelSheet.getMaxRows() - markerRow + 1);
  var collected = PanelPending_collect(caseId), items = collected.items;
  var headerRow = panelSheet.getLastRow() + 2;
  if (panelSheet.getMaxRows() < headerRow + 1 + Math.max(1, items.length)) panelSheet.insertRowsAfter(panelSheet.getMaxRows(), headerRow + 1 + Math.max(1, items.length) - panelSheet.getMaxRows());
  var updated = new Date();
  panelSheet.getRange(headerRow, 1, 1, 6).merge().setValue(PANEL_PENDING_TITLE + '（' + collected.counts.total + '件）　最終更新 ' + Utilities.formatDate(updated, 'Asia/Tokyo', 'M/d HH:mm')).setFontWeight('bold').setBackground('#fff3e0').setFontColor('#e65100');
  panelSheet.getRange(headerRow, 7).setValue(PANEL_PENDING_MARKER);
  panelSheet.getRange(headerRow + 1, 7).setValue(updated);
  panelSheet.getRange(headerRow + 1, 1, 1, 6).merge().setValue('✅ 済 にチェックを入れると、次の更新（最大10分）で台帳が「完了」になり、この一覧から消えます').setFontColor('#616161').setFontSize(9).setFontWeight('normal');
  var dataRow = headerRow + 2;
  if (!items.length) {
    panelSheet.getRange(dataRow, 1, 1, 6).merge().setValue('✅ いま止まっているものはありません');
    return collected;
  }
  var values = items.map(function (item) { return ['', (item.overdue ? '🔴 ' : '') + item.category, item.label, '', item.detail, '']; });
  var backgrounds = items.map(function (item) { var color = item.overdue ? '#ffebee' : null; return [color, color, color, color, color, color]; });
  panelSheet.getRange(dataRow, 1, items.length, 6).setValues(values).setBackgrounds(backgrounds).setWrap(true).setVerticalAlignment('top');
  panelSheet.getRange(dataRow, 8, items.length, 1).setValues(items.map(function (item) { return [item.taskId || '']; }));
  items.forEach(function (item, index) {
    var row = dataRow + index;
    panelSheet.getRange(row, 3, 1, 2).merge();
    if (item.url) PanelLinks_write(panelSheet.getRange(row, 6), '', [{ label: '🔗 開く', url: item.url }]);
  });
  // チェックボックスは taskId のある行だけ、連続区間ごとにまとめて入れる (1行ずつ呼ぶと6分制限に響く)
  var ranges = [], current = null;
  items.forEach(function (item, index) {
    if (!item.taskId) { current = null; return; }
    if (current) { current.count++; return; }
    current = { start: dataRow + index, count: 1 };
    ranges.push(current);
  });
  ranges.forEach(function (range) { panelSheet.getRange(range.start, 1, range.count, 1).insertCheckboxes(); });
  return collected;
}

/**
 * ⏳ ブロックでチェックされた行の台帳タスクを「完了」にする。
 * @return {{applied: number, taskIds: string[], skipped: number, sheetName: string, pendingCount: number}}
 */
function PanelPending_applyChecked(caseId) {
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS), panel = _PanelPending_panelForCase(ms, caseId);
  if (!panel) throw new Error('案件の実行パネルが見つかりません: ' + caseId);
  var markers = panel.getRange(1, 7, panel.getMaxRows(), 1).getValues(), markerRow = -1;
  for (var i = 0; i < markers.length; i++) if (String(markers[i][0] || '') === PANEL_PENDING_MARKER) { markerRow = i + 1; break; }
  var lastRow = panel.getLastRow();
  var empty = { applied: 0, taskIds: [], skipped: 0, sheetName: panel.getName(), pendingCount: 0 };
  if (markerRow < 0 || lastRow < markerRow) return empty;
  var rowCount = lastRow - markerRow + 1;
  var checkValues = panel.getRange(markerRow, 1, rowCount, 1).getValues();
  var taskIdValues = panel.getRange(markerRow, 8, rowCount, 1).getValues();
  var taskIds = PanelPending_checkedTaskIds(checkValues, taskIdValues);
  if (!taskIds.length) return empty;
  var applied = 0, skipped = 0;
  taskIds.forEach(function (taskId) {
    try { _admin_taskLedgerSetRow(caseId, taskId, { status: '完了' }); applied++; }
    catch (e) { skipped++; }
  });
  var result = PanelPending_write(panel, caseId);
  return { applied: applied, taskIds: taskIds, skipped: skipped, sheetName: panel.getName(), pendingCount: result.counts.total };
}

/**
 * 全パネルの ⏳ チェックを1回の走査で反映する。
 * 案件ごとに PanelPending_applyChecked を呼ぶと、その中の _PanelPending_panelForCase が
 * 毎回全シートの G1/G4 を舐めるので、15案件 x 19パネルで読み取りが爆発して
 * TaskLedger_pollChecked の 6 分予算を食う。パネルは1枚1回だけ読む。
 */
function PanelPending_applyCheckedAll(opts) {
  opts = opts || {};
  var budgetMs = Number(opts.budgetMs) || 60000;
  var startedAt = new Date().getTime();
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var applied = 0, skipped = 0, panels = 0, truncated = false, details = [];
  ms.getSheets().forEach(function (sheet) {
    if (truncated) return;
    if (new Date().getTime() - startedAt > budgetMs) { truncated = true; return; }
    var caseId = '';
    try {
      if (!_Panel_isMarker(String(sheet.getRange('G1').getValue()))) return;
      caseId = String(sheet.getRange('G4').getValue() || '');
    } catch (e) { return; }
    if (!caseId) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 1) return;
    // A(チェック) と G(マーカー) と H(taskId) を1回の getValues でまとめて取る
    var block;
    try { block = sheet.getRange(1, 1, lastRow, 8).getValues(); } catch (e) { return; }
    var markerRow = -1;
    for (var i = 0; i < block.length; i++) if (String(block[i][6] || '') === PANEL_PENDING_MARKER) { markerRow = i + 1; break; }
    if (markerRow < 0) return;
    var slice = block.slice(markerRow - 1);
    var taskIds = PanelPending_checkedTaskIds(
      slice.map(function (row) { return row[0]; }),
      slice.map(function (row) { return row[7]; })
    );
    if (!taskIds.length) return;
    panels++;
    taskIds.forEach(function (taskId) {
      try { _admin_taskLedgerSetRow(caseId, taskId, { status: '完了' }); applied++; }
      catch (e) { skipped++; }
    });
    try { PanelPending_write(sheet, caseId); } catch (e) { console.warn('PanelPending_applyCheckedAll write: ' + caseId + ' / ' + e); }
    details.push({ caseId: caseId, sheetName: sheet.getName(), taskIds: taskIds });
  });
  return { applied: applied, skipped: skipped, panels: panels, truncated: truncated, details: details };
}

function PanelPending_refresh(caseId) {
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS), panel = _PanelPending_panelForCase(ms, caseId);
  if (!panel) throw new Error('案件の実行パネルが見つかりません: ' + caseId);
  var result = PanelPending_write(panel, caseId);
  return { pendingCount: result.counts.total, sheetName: panel.getName(), gid: panel.getSheetId(), sheetUrl: 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + _PANEL_MASTER_SS + '/edit#gid=' + panel.getSheetId() };
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  PanelPending_categoryRank: PanelPending_categoryRank,
  PanelPending_sort: PanelPending_sort,
  PanelPending_select: PanelPending_select,
  PanelPending_checkedTaskIds: PanelPending_checkedTaskIds,
  _PanelPending_rowUrl: _PanelPending_rowUrl,
  PANEL_PENDING_MAX: PANEL_PENDING_MAX,
  PANEL_PENDING_MAX_PER_CATEGORY: PANEL_PENDING_MAX_PER_CATEGORY
};
