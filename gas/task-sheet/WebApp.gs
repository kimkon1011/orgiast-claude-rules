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
    if (payload.kind === 'claimTask') return _taskJson_(claimTask(payload));
    if (payload.kind === 'doneTask') return _taskJson_(doneTask(payload));
    if (payload.kind === 'upsertJob') return _taskJson_(upsertJob(payload));
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
    return _taskJson_(listTasks({ taskId: e.parameter && e.parameter.taskId, 状態: e.parameter && e.parameter.状態, 担当PC: e.parameter && e.parameter.担当PC }));
  } catch (error) {
    return _taskJson_({ ok: false, status: 500, error: error.message });
  }
}
