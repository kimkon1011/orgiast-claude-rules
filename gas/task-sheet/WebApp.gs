function _taskJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (error) {
    return _taskJson_({ ok: false, status: 400, error: 'invalid_json' });
  }
  const expected = PropertiesService.getScriptProperties().getProperty('TASK_SHEET_TOKEN');
  if (!expected || payload.token !== expected) return _taskJson_({ ok: false, status: 401, error: 'unauthorized' });
  try {
    if (payload.kind === 'ping') return _taskJson_({ ok: true, pong: true, at: new Date().toISOString() });
    if (payload.kind === 'upsertTask' || !payload.kind) return _taskJson_(upsertTask(payload));
    return _taskJson_({ ok: false, status: 400, error: 'unknown_kind' });
  } catch (error) {
    return _taskJson_({ ok: false, status: 500, error: error.message });
  }
}

function doGet(e) {
  const expected = PropertiesService.getScriptProperties().getProperty('TASK_SHEET_TOKEN');
  const token = e && e.parameter ? e.parameter.token : '';
  if (!expected || token !== expected) return _taskJson_({ ok: false, status: 401, error: 'unauthorized' });
  try {
    return _taskJson_(listTasks({ taskId: e.parameter && e.parameter.taskId }));
  } catch (error) {
    return _taskJson_({ ok: false, status: 500, error: error.message });
  }
}

function upsertTask(args) {
  const taskId = args && typeof args.taskId === 'string' ? args.taskId.trim() : '';
  if (!taskId) throw new Error('taskId is required');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const sheet = _taskSheetEnsureTab_();
    const lastRow = sheet.getLastRow();
    const ids = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().map(function(r) { return r[0]; }) : [];
    let rowIndex = ids.indexOf(taskId);
    const now = new Date().toISOString();
    const row = [
      taskId,
      args.起票元 || '',
      args.件名 || '',
      args.依頼元 || '',
      args.担当PC || '',
      args.状態 || '未着手',
      args.次アクション || '',
      args.成果物リンク || '',
      args.期限 || '',
      now,
      args.備考 || ''
    ];
    if (rowIndex < 0) {
      sheet.appendRow(row);
      rowIndex = sheet.getLastRow() - 2;
    } else {
      sheet.getRange(rowIndex + 2, 1, 1, row.length).setValues([row]);
    }
    return { ok: true, action: rowIndex < 0 ? 'insert' : 'update', row: rowIndex + 2 };
  } finally {
    lock.releaseLock();
  }
}

function listTasks(args) {
  const sheet = _taskSheetEnsureTab_();
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues() : [];
  let rows = values.map(function(row) {
    const obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
  if (args && args.taskId) rows = rows.filter(function(r) { return r.taskId === args.taskId; });
  return { ok: true, rows: rows, count: rows.length };
}
