// 生存判定は既存行では許可された3列だけ、明示された行追加では F列と3列だけを計画する。
function fleetPlanLiveness(headers, rows, payload) {
  var columns = fleetResolveColumns(headers);
  var allowed = [columns.livenessState, columns.livenessReason, columns.livenessCheckedAt];
  if (allowed.some(function(column) { return column < 0; })) throw new Error('liveness headers not found');
  var items = payload && Array.isArray(payload.items) ? payload.items : [];
  var checkedAt = String(payload && payload.checkedAt || '');
  var updates = [];
  var unmatched = [];
  var appended = [];
  items.forEach(function(item) {
    try {
      var names = item && Array.isArray(item.names) ? item.names.map(function(name) { return String(name == null ? '' : name).trim(); }).filter(Boolean) : [];
      var indexes = [];
      rows.forEach(function(row, rowIndex) {
        var hostnameMatch = names.some(function(name) { return row[columns.hostname] === name; });
        var selfPcMatch = !row[columns.hostname] && names.some(function(name) { return row[columns.selfPc] === name; });
        if (hostnameMatch || selfPcMatch) indexes.push(rowIndex);
      });
      if (!indexes.length) {
        var label = names[0] || '(名称未設定)';
        if (!payload.appendUnmatched) { unmatched.push(label); return; }
        var appendedValues = {};
        appendedValues[columns.hostname] = names[0] || '';
        appendedValues[columns.livenessState] = item.state == null ? '' : item.state;
        appendedValues[columns.livenessReason] = item.reason == null ? '' : item.reason;
        appendedValues[columns.livenessCheckedAt] = checkedAt;
        appended.push({ rowIndex: rows.length + appended.length, label: names[0] || '', values: appendedValues });
        return;
      }
      indexes.forEach(function(index) {
        var values = {};
        values[columns.livenessState] = item.state == null ? '' : item.state;
        values[columns.livenessReason] = item.reason == null ? '' : item.reason;
        values[columns.livenessCheckedAt] = checkedAt;
        updates.push({ rowIndex: index, values: values });
      });
    } catch (error) {
      unmatched.push(item && item.names && item.names[0] ? String(item.names[0]) : '(名称未設定)');
    }
  });
  return { updates: updates, unmatched: unmatched, appended: appended };
}
