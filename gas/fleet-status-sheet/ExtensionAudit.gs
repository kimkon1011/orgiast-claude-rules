const EXT_SHEET_NAME_ = '拡張機能監査';
const EXT_HEADERS_ = {
  label: 'PC名/ホスト名', browser: 'ブラウザ', profile: 'プロファイル', account: 'Googleアカウント', name: '拡張機能名', id: '拡張ID', version: 'バージョン', enabled: '有効', risk: 'リスク', builtin: '標準同梱', broadHost: '全サイト権限', keyPerms: '主要権限', reportedAt: '最終報告(JST)'
};

function extPlanReplace(headers, rows, payload) {
  const label = typeof payload.label === 'string' ? payload.label.trim() : '';
  if (!label) throw new Error('label_required');
  const columns = {};
  Object.keys(EXT_HEADERS_).forEach(function(key) {
    const index = fleetFindHeaderIndex(headers, EXT_HEADERS_[key]);
    if (index < 0) throw new Error('required header not found: ' + EXT_HEADERS_[key]);
    columns[key] = index;
  });
  const labelColumn = columns.label;
  const deleteRowNumbers = [];
  rows.forEach(function(row, index) { if (String(row[labelColumn]) === label) deleteRowNumbers.push(index + 2); });
  const appendRows = (Array.isArray(payload.rows) ? payload.rows : []).map(function(row) {
    const values = {
      label: label, browser: row.browser || '', profile: row.profile || '', account: row.account || '', name: row.name || '', id: row.id || '', version: row.version || '',
      enabled: row.enabled === true ? '有効' : row.enabled === false ? '無効' : '判定不能', risk: row.risk || '', builtin: row.builtin ? 'はい' : 'いいえ', broadHost: row.broadHost ? 'あり' : 'なし', keyPerms: Array.isArray(row.keyPerms) ? row.keyPerms.join(', ') : '', reportedAt: payload.reportedAt || ''
    };
    const output = headers.map(function() { return ''; });
    Object.keys(columns).forEach(function(key) { output[columns[key]] = values[key]; });
    return output;
  });
  return { deleteRowNumbers: deleteRowNumbers, appendRows: appendRows };
}

function extSummarize(headers, rows) {
  const labelColumn = fleetFindHeaderIndex(headers, EXT_HEADERS_.label);
  if (labelColumn < 0) throw new Error('required header not found: ' + EXT_HEADERS_.label);
  const riskColumn = fleetFindHeaderIndex(headers, EXT_HEADERS_.risk);
  const reportedAtColumn = fleetFindHeaderIndex(headers, EXT_HEADERS_.reportedAt);
  const byLabel = {};
  let totalRows = 0;
  rows.forEach(function(row) {
    const label = String(row[labelColumn] == null ? '' : row[labelColumn]).trim();
    if (!label) return;
    if (!byLabel[label]) byLabel[label] = { rows: 0, high: 0, reportedAt: '' };
    const summary = byLabel[label];
    summary.rows += 1;
    totalRows += 1;
    if (riskColumn >= 0 && String(row[riskColumn]).toLowerCase() === 'high') summary.high += 1;
    const reportedAt = reportedAtColumn >= 0 ? String(row[reportedAtColumn] == null ? '' : row[reportedAtColumn]) : '';
    if (reportedAt > summary.reportedAt) summary.reportedAt = reportedAt;
  });
  return { pcCount: Object.keys(byLabel).length, totalRows: totalRows, byLabel: byLabel };
}

function describeExtensionAudit() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not configured');
  const spreadsheet = SpreadsheetApp.openById(id);
  const sheet = spreadsheet.getSheetByName(EXT_SHEET_NAME_);
  if (!sheet) return { ok: true, tab: EXT_SHEET_NAME_, exists: false, pcCount: 0, totalRows: 0, byLabel: {} };
  const lastColumn = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  const headers = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues() : [];
  const summary = extSummarize(headers, rows);
  return { ok: true, tab: EXT_SHEET_NAME_, exists: true, pcCount: summary.pcCount, totalRows: summary.totalRows, byLabel: summary.byLabel };
}

function replaceExtensionAudit(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const properties = PropertiesService.getScriptProperties();
    const id = properties.getProperty('SHEET_ID');
    if (!id) throw new Error('SHEET_ID is not configured');
    const spreadsheet = SpreadsheetApp.openById(id);
    let sheet = spreadsheet.getSheetByName(EXT_SHEET_NAME_);
    if (!sheet) { sheet = spreadsheet.insertSheet(EXT_SHEET_NAME_); sheet.getRange(1, 1, 1, Object.keys(EXT_HEADERS_).length).setValues([Object.keys(EXT_HEADERS_).map(function(k) { return EXT_HEADERS_[k]; })]); }
    const lastColumn = sheet.getLastColumn(); const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues() : [];
    const plan = extPlanReplace(headers, rows, payload);
    plan.deleteRowNumbers.slice().sort(function(a, b) { return b - a; }).forEach(function(rowNumber) { sheet.deleteRow(rowNumber); });
    if (plan.appendRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, plan.appendRows.length, headers.length).setValues(plan.appendRows);
    return { ok: true, deleted: plan.deleteRowNumbers.length, appended: plan.appendRows.length };
  } finally { lock.releaseLock(); }
}
