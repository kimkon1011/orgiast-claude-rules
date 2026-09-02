function _taskLedgerWithLock_(work) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

function _taskLedgerRead_() {
  var sheet = _taskSheetEnsureTab_();
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  return {
    sheet: sheet,
    headers: sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0],
    rows: lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues() : []
  };
}

function _taskLedgerApplyUpdates_(sheet, headers, rowIndex, updates) {
  updates.forEach(function(update) {
    sheet.getRange(rowIndex + 2, taskLedgerColumn(headers, update.column, true) + 1).setValue(update.value);
  });
}

function upsertTask(args) {
  return _taskLedgerWithLock_(function() {
    var data = _taskLedgerRead_();
    var plan = taskLedgerPlanUpsert(data.headers, data.rows, args, new Date().toISOString());
    if (plan.action === 'insert') {
      data.sheet.appendRow(plan.row);
    } else {
      data.sheet.getRange(plan.rowIndex + 2, 1, 1, plan.row.length).setValues([plan.row]);
    }
    return { ok: true, action: plan.action, row: plan.rowIndex + 2 };
  });
}

function claimTask(args) {
  return _taskLedgerWithLock_(function() {
    var data = _taskLedgerRead_();
    var plan = taskLedgerPlanClaim(data.headers, data.rows, args, new Date().toISOString());
    if (!plan.ok) return { ok: false, status: 409, error: plan.error, owner: plan.owner };
    _taskLedgerApplyUpdates_(data.sheet, data.headers, plan.rowIndex, plan.updates);
    return { ok: true, row: plan.rowIndex + 2 };
  });
}

function doneTask(args) {
  return _taskLedgerWithLock_(function() {
    var data = _taskLedgerRead_();
    var plan = taskLedgerPlanDone(data.headers, data.rows, args, new Date().toISOString());
    if (!plan.ok) return { ok: false, status: 404, error: plan.error };
    _taskLedgerApplyUpdates_(data.sheet, data.headers, plan.rowIndex, plan.updates);
    return { ok: true, row: plan.rowIndex + 2 };
  });
}

function listTasks(args) {
  var data = _taskLedgerRead_();
  var rows = data.rows.map(function(row) {
    var object = {};
    data.headers.forEach(function(header, index) { object[header] = row[index]; });
    return object;
  });
  rows = taskLedgerFilterRows(rows, args);
  return { ok: true, rows: rows, count: rows.length };
}
