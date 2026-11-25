function upsertFleetLiveness(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    var sheet = _fleetSheet_();
    _fleetEnsureIdentityHeaders_(sheet);
    var lastColumn = sheet.getLastColumn();
    var lastRow = sheet.getLastRow();
    var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues() : [];
    var plan = fleetPlanLiveness(headers, rows, payload || {});
    var written = [];
    var updated = 0;
    var failures = [];
    // 純ロジックが壊れても3列以外へ書けないよう、実書き込み側にも許可リストを置く。
    var allowed = {};
    ['livenessState', 'livenessReason', 'livenessCheckedAt'].forEach(function(key) { allowed[fleetFindHeaderIndex(headers, FLEET_HEADERS_[key])] = true; });
    plan.updates.forEach(function(update) {
      try {
        Object.keys(update.values).forEach(function(column) {
          var index = Number(column);
          if (!allowed[index]) throw new Error('non-allowlisted liveness column: ' + headers[index]);
          sheet.getRange(update.rowIndex + 2, index + 1).setValue(update.values[column]);
          if (written.indexOf(headers[index]) < 0) written.push(headers[index]);
        });
        updated += 1;
      } catch (error) { failures.push({ row: update.rowIndex + 2, error: error.message }); }
    });
    var appended = [];
    var appendAllowed = {};
    ['hostname', 'livenessState', 'livenessReason', 'livenessCheckedAt'].forEach(function(key) { appendAllowed[fleetFindHeaderIndex(headers, FLEET_HEADERS_[key])] = true; });
    plan.appended.forEach(function(append) {
      try {
        Object.keys(append.values).forEach(function(column) {
          var index = Number(column);
          if (!appendAllowed[index]) throw new Error('non-allowlisted appended column: ' + headers[index]);
          sheet.getRange(append.rowIndex + 2, index + 1).setValue(append.values[column]);
          if (written.indexOf(headers[index]) < 0) written.push(headers[index]);
        });
        appended.push({ rowIndex: append.rowIndex + 2, label: append.label });
      } catch (error) { failures.push({ row: append.rowIndex + 2, error: error.message }); }
    });
    return { ok: true, updated: updated, unmatched: plan.unmatched, appended: appended, written: written, failures: failures };
  } finally { lock.releaseLock(); }
}

// 診断用: 行ごとの D列/F列と稼働状態3列だけを返す。
// シート全文(拡張機能タブ等)を読むと巨大になるため、必要な列だけに絞る。
function describeFleetLiveness() {
  var sheet = _fleetSheet_();
  var lastColumn = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var columns = fleetResolveColumns(headers);
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues() : [];
  var pick = function (row, key) { var i = columns[key]; return i >= 0 ? row[i] : ''; };
  return {
    headerCount: lastColumn,
    livenessColumns: { state: columns.livenessState, reason: columns.livenessReason, checkedAt: columns.livenessCheckedAt },
    rows: rows.map(function (row, index) {
      return { row: index + 2, selfPc: pick(row, 'selfPc'), label: pick(row, 'hostname'), state: pick(row, 'livenessState'), checkedAt: pick(row, 'livenessCheckedAt') };
    })
  };
}
