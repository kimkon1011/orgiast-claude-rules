function _fleetJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// 既存列は動かさず、機械の自己申告列だけを右端へ補う。配列だけで計画できるようにして冪等性を検証可能にする。
function fleetPlanHeaders(headers) {
  const planned = headers.slice();
  FLEET_OPTIONAL_HEADERS_.forEach(function(key) {
    if (fleetFindHeaderIndex(planned, FLEET_HEADERS_[key]) < 0) planned.push(FLEET_HEADERS_[key]);
  });
  return planned;
}

function _fleetEnsureIdentityHeaders_(sheet) {
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  const planned = fleetPlanHeaders(headers);
  if (planned.length > headers.length) {
    sheet.getRange(1, lastColumn + 1, 1, planned.length - headers.length).setValues([planned.slice(headers.length)]);
  }
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

  // 新列追加前のシートも発見対象にする。発見後、書き込みロック内で不足列を補う。
  const requiredHeaders = Object.keys(FLEET_HEADERS_).filter(function(key) {
    return FLEET_OPTIONAL_HEADERS_.indexOf(key) < 0;
  }).map(function(key) { return FLEET_HEADERS_[key]; });
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
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (error) {
    return _fleetJson_({ ok: false, status: 400, error: 'invalid_json' });
  }
  const expected = PropertiesService.getScriptProperties().getProperty('FLEET_TOKEN');
  if (!expected || payload.token !== expected) return _fleetJson_({ ok: false, status: 401, error: 'unauthorized' });
  const labelRequiredKinds = { extensions: true, 'cloud-login': true };
  if (labelRequiredKinds[payload.kind] && (typeof payload.label !== 'string' || payload.label.trim() === '')) {
    return _fleetJson_({ ok: false, status: 400, error: 'label_required' });
  }

  // 未知 kind は従来どおり通常点検として扱い、既存クライアントの挙動を変えない。
  const handlers = {
    'pc-spec': upsertPcInventory,
    'extensions-describe': describeExtensionAudit,
    extensions: replaceExtensionAudit,
    liveness: upsertFleetLiveness,
    'cloud-login': replaceCloudLogins,
    'cloud-project': upsertCloudProjects,
    'cloud-contract': upsertCloudContracts,
    'cloud-describe': describeCloudLedger
  };
  try {
    const handler = handlers[payload.kind] || upsertFleetStatus;
    return _fleetJson_(handler(payload));
  } catch (error) {
    return _fleetJson_({ ok: false, status: 500, error: error.message });
  }
}

function doGet(e) {
  const expected = PropertiesService.getScriptProperties().getProperty('FLEET_TOKEN');
  const token = e && e.parameter ? e.parameter.token : '';
  if (!expected || token !== expected) return _fleetJson_({ ok: false, status: 401, error: 'unauthorized' });
  try {
    const sheet = _fleetSheet_();
    const lastColumn = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    const columns = fleetResolveColumns(headers);
    const values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getDisplayValues() : [];
    const rows = values.map(function(row) {
      return {
        pcName: row[columns.selfPc] || '',
        label: row[columns.hostname] || '',
        reportedAt: row[columns.reportedAt] || '',
        note: row[columns.consistency] || '',
        interactionLoop: columns.interactionLoop >= 0 ? (row[columns.interactionLoop] || '') : '',
        interactionSelftest: columns.interactionSelftest >= 0 ? (row[columns.interactionSelftest] || '') : ''
      };
    });
    return _fleetJson_({ ok: true, rows: rows, count: rows.length });
  } catch (error) {
    return _fleetJson_({ ok: false, status: 500, error: error.message });
  }
}

function upsertFleetStatus(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const sheet = _fleetSheet_();
    // 新列の追加失敗は既存の点検書き込みを止めない。fleetPlanUpsert は不足した新列を無視できる。
    try { _fleetEnsureIdentityHeaders_(sheet); } catch (error) { /* 従来列のみで継続 */ }
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
