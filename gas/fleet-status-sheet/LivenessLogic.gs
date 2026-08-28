// 生存判定は許可された3列だけを計画する。行追加や人間の記入列の更新は行わない。
function fleetPlanLiveness(headers, rows, payload) {
  var columns = fleetResolveColumns(headers);
  var allowed = [columns.livenessState, columns.livenessReason, columns.livenessCheckedAt];
  if (allowed.some(function(column) { return column < 0; })) throw new Error('liveness headers not found');
  var items = payload && Array.isArray(payload.items) ? payload.items : [];
  var checkedAt = String(payload && payload.checkedAt || '');
  var updates = [];
  var unmatched = [];
  var used = {};
  items.forEach(function(item) {
    try {
      var names = item && Array.isArray(item.names) ? item.names.map(function(name) { return String(name == null ? '' : name).trim(); }).filter(Boolean) : [];
      var index = -1;
      for (var i = 0; i < names.length && index < 0; i += 1) {
        index = rows.findIndex(function(row, rowIndex) { return !used[rowIndex] && row[columns.hostname] === names[i]; });
      }
      for (var j = 0; j < names.length && index < 0; j += 1) {
        index = rows.findIndex(function(row, rowIndex) { return !used[rowIndex] && row[columns.selfPc] === names[j] && !row[columns.hostname]; });
      }
      if (index < 0) { unmatched.push(names[0] || '(名称未設定)'); return; }
      used[index] = true;
      var values = {};
      values[columns.livenessState] = item.state == null ? '' : item.state;
      values[columns.livenessReason] = item.reason == null ? '' : item.reason;
      values[columns.livenessCheckedAt] = checkedAt;
      updates.push({ rowIndex: index, values: values });
    } catch (error) {
      unmatched.push(item && item.names && item.names[0] ? String(item.names[0]) : '(名称未設定)');
    }
  });
  return { updates: updates, unmatched: unmatched };
}
