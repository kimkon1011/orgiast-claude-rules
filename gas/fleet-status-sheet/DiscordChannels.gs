function _discordEnsureHeaders_(sheet) {
  var lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) {
    sheet.getRange(1, 1, 1, DISCORD_CHANNEL_HEADERS_.length).setValues([DISCORD_CHANNEL_HEADERS_]);
    return DISCORD_CHANNEL_HEADERS_.slice();
  }
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var missing = DISCORD_CHANNEL_HEADERS_.filter(function(name) { return fleetFindHeaderIndex(headers, name) < 0; });
  if (missing.length) {
    // グリッドの右端を超える追加は getRange が落ちる。足りない分だけ列を増やしてから書く。
    var shortage = lastColumn + missing.length - sheet.getMaxColumns();
    if (shortage > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), shortage);
    sheet.getRange(1, lastColumn + 1, 1, missing.length).setValues([missing]);
  }
  return headers.concat(missing);
}

function upsertDiscordChannels(payload) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID');
    if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
    var book = SpreadsheetApp.openById(id);
    var sheet = book.getSheetByName(DISCORD_TAB_NAME_) || book.insertSheet(DISCORD_TAB_NAME_);
    var headers = _discordEnsureHeaders_(sheet);
    // 日付列は Sheets が Date へ自動変換するため getValues() だと毎回「差分あり」になり
    // 430行を毎晩書き直してしまう。表示値で比較し、列自体もテキスト形式に固定する。
    var checkedAtColumn = fleetFindHeaderIndex(headers, '最終確認日(JST)');
    if (checkedAtColumn >= 0) {
      sheet.getRange(2, checkedAtColumn + 1, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('@');
    }
    var lastRow = sheet.getLastRow();
    var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues() : [];
    var plan = discordPlanChannels(headers, rows, payload || {});
    _cloudApply_(sheet, plan);
    return { ok: true, updated: plan.updates.length, appended: plan.appendRows.length, missing: plan.missing };
  } finally { lock.releaseLock(); }
}

function describeDiscordChannels() {
  var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID');
  if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
  var sheet = SpreadsheetApp.openById(id).getSheetByName(DISCORD_TAB_NAME_);
  if (!sheet) return { ok: true, tab: DISCORD_TAB_NAME_, exists: false, headers: [], rowCount: 0, rows: [] };
  var lastColumn = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  var headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  var idColumn = cloudColumn(headers, 'チャンネルID', true);
  var nameColumn = cloudColumn(headers, 'チャンネル名', true);
  var count = Math.max(0, lastRow - 1);
  var values = count ? sheet.getRange(2, 1, Math.min(5, count), lastColumn).getDisplayValues() : [];
  return { ok: true, tab: DISCORD_TAB_NAME_, exists: true, headers: headers, rowCount: count, rows: values.map(function(row) { return { id: row[idColumn], name: row[nameColumn] }; }) };
}
