function _fleetJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function _fleetSheet_() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not configured');
  const spreadsheet = SpreadsheetApp.openById(id);
  const cachedName = properties.getProperty('SHEET_TAB_NAME');
  if (cachedName) {
    const cachedSheet = spreadsheet.getSheetByName(cachedName);
    if (cachedSheet) return cachedSheet;
  }

  const requiredHeaders = Object.keys(FLEET_HEADERS_).map(function(key) { return FLEET_HEADERS_[key]; });
  const sheets = spreadsheet.getSheets();
  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i];
    const lastColumn = sheet.getLastColumn();
    if (lastColumn < requiredHeaders.length) continue;
    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    if (requiredHeaders.every(function(header) { return headers.indexOf(header) >= 0; })) {
      properties.setProperty('SHEET_TAB_NAME', sheet.getName());
      return sheet;
    }
  }
  throw new Error('fleet status tab not found');
}

function doPost(e) {
  let payload;
  try { payload = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (error) { return _fleetJson_({ ok: false, status: 400, error: 'invalid_json' }); }
  const expected = PropertiesService.getScriptProperties().getProperty('FLEET_TOKEN');
  if (!expected || payload.token !== expected) return _fleetJson_({ ok: false, status: 401, error: 'unauthorized' });
  if (payload.kind === 'extensions' && (typeof payload.label !== 'string' || payload.label.trim() === '')) return _fleetJson_({ ok: false, status: 400, error: 'label_required' });
  try { return _fleetJson_(payload.kind === 'extensions' ? replaceExtensionAudit(payload) : upsertFleetStatus(payload)); }
  catch (error) { return _fleetJson_({ ok: false, status: 500, error: error.message }); }
}

function upsertFleetStatus(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const sheet = _fleetSheet_();
    const lastColumn = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues() : [];
    const plan = fleetPlanUpsert(headers, rows, payload);
    const targetRow = plan.rowIndex + 2;

    // 自動列だけを個別に書く。A〜Eは追記行でも一切触らない。
    Object.keys(plan.values).forEach(function(columnIndex) {
      sheet.getRange(targetRow, Number(columnIndex) + 1).setValue(plan.values[columnIndex]);
    });
    return { ok: true, action: plan.action, row: targetRow };
  } finally {
    lock.releaseLock();
  }
}
