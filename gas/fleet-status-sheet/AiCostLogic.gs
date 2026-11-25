var AI_COST_SUMMARY_HEADERS_ = ['年月','サービス','課金形態','freee計上額(円)','実測利用額(円)','差額(円)','状態','支払い元(名義)','根拠','備考','更新日時(JST)'];
var AI_COST_PENDING_HEADERS_ = ['年月','サービス','金額(円)','支払い元(名義)','摘要(案)','勘定科目','税区分','登録済み','検出日'];

function _aiCostAllowed_(pending) {
  return pending
    ? {'年月':'month','サービス':'service','金額(円)':'amount','支払い元(名義)':'payerName','摘要(案)':'description','検出日':'detectedAt'}
    : {'年月':'month','サービス':'service','課金形態':'billing','freee計上額(円)':'freeeJpy','実測利用額(円)':'localJpy','差額(円)':'difference','状態':'state','支払い元(名義)':'payerName','根拠':'evidence','更新日時(JST)':'updatedAt'};
}
function _aiCostKey_(month, service) { return JSON.stringify([String(month), String(service)]); }
function _aiCostItems_(payload) {
  if (!payload || !Array.isArray(payload.rows)) throw new Error('rows_required');
  var seen = {};
  payload.rows.forEach(function(item) {
    if (!item || !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.month) || !String(item.service || '').trim()) throw new Error('invalid_key');
    var key = _aiCostKey_(item.month, item.service);
    if (seen[key]) throw new Error('duplicate_key');
    seen[key] = true;
  });
  return payload.rows;
}
function _aiCostChanges_(headers, row, item, allowed, force) {
  var changes = [];
  Object.keys(allowed).forEach(function(header) {
    var field = allowed[header];
    if (!Object.prototype.hasOwnProperty.call(item, field)) return;
    var value = item[field];
    // 明示的な null は未知の金額を空にする。省略された値には触らない。
    if (value === undefined) return;
    var col = cloudColumn(headers, header, true);
    if (header === '更新日時(JST)' || header === '検出日' || force === true || !cloudNonEmpty(row[col])) {
      changes.push({ columnIndex: col + 1, value: value === null ? '' : value });
    }
  });
  return changes;
}
function aiCostPlanSummaryUpsert(headers, rows, payload) {
  var items = _aiCostItems_(payload), allowed = _aiCostAllowed_(false);
  var monthCol = cloudColumn(headers, '年月', true), serviceCol = cloudColumn(headers, 'サービス', true);
  var updates = [], appendRows = [];
  items.forEach(function(item) {
    var index = rows.findIndex(function(row) { return _aiCostKey_(row[monthCol], row[serviceCol]) === _aiCostKey_(item.month, item.service); });
    var output = index < 0 ? headers.map(function() { return ''; }) : rows[index];
    _aiCostChanges_(headers, output, item, allowed, payload.force).forEach(function(change) {
      if (index < 0) output[change.columnIndex - 1] = change.value;
      else updates.push({ rowNumber: index + 2, columnIndex: change.columnIndex, value: change.value });
    });
    if (index < 0) appendRows.push(output);
  });
  return { updates: updates, appendRows: appendRows };
}
function aiCostPlanPendingReplace(headers, rows, payload) {
  var items = _aiCostItems_(payload), allowed = _aiCostAllowed_(true);
  if (!Array.isArray(payload.months) || payload.months.some(function(month) { return !/^\d{4}-(0[1-9]|1[0-2])$/.test(month); })) throw new Error('months_required');
  var monthCol = cloudColumn(headers, '年月', true), serviceCol = cloudColumn(headers, 'サービス', true);
  cloudColumn(headers, '登録済み', true);
  var deleteRowNumbers = [], appendRows = [], updates = [], previous = {}, kept = {};
  rows.forEach(function(row, index) {
    if (payload.months.indexOf(String(row[monthCol])) < 0) return;
    var key = _aiCostKey_(row[monthCol], row[serviceCol]);
    // 経理の記入がある行はその場に残す。許可列以外の値を再書き込みもしない。
    var human = headers.some(function(header, col) { return !allowed[header] && cloudNonEmpty(row[col]); });
    if (human) kept[key] = { row: row, rowNumber: index + 2 };
    else { deleteRowNumbers.push(index + 2); previous[key] = row; }
  });
  items.forEach(function(item) {
    if (payload.months.indexOf(item.month) < 0) throw new Error('row_outside_months');
    var key = _aiCostKey_(item.month, item.service), retained = kept[key];
    if (retained) {
      _aiCostChanges_(headers, retained.row, item, allowed, payload.force).forEach(function(change) {
        updates.push({ rowNumber: retained.rowNumber, columnIndex: change.columnIndex, value: change.value });
      });
      return;
    }
    var output = headers.map(function(header, col) { return allowed[header] && previous[key] ? previous[key][col] : ''; });
    _aiCostChanges_(headers, output, item, allowed, payload.force).forEach(function(change) { output[change.columnIndex - 1] = change.value; });
    appendRows.push(output);
  });
  // _cloudApply_ は削除を先に行うため、保持行の更新位置を補正する。
  updates.forEach(function(update) { var original = update.rowNumber; update.rowNumber -= deleteRowNumbers.filter(function(n) { return n < original; }).length; });
  return { deleteRowNumbers: deleteRowNumbers, updates: updates, appendRows: appendRows };
}
