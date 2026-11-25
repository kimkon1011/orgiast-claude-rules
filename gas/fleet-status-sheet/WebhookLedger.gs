function _webhookEnsureHeaders_(sheet) {
  var lastColumn = sheet.getLastColumn();
  if (!lastColumn) {
    if (sheet.getMaxColumns() < WEBHOOK_HEADERS_.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), WEBHOOK_HEADERS_.length - sheet.getMaxColumns());
    sheet.getRange(1, 1, 1, WEBHOOK_HEADERS_.length).setValues([WEBHOOK_HEADERS_]); return WEBHOOK_HEADERS_.slice();
  }
  var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var missing = WEBHOOK_HEADERS_.filter(function(name) { return fleetFindHeaderIndex(headers, name) < 0; });
  var shortage = lastColumn + missing.length - sheet.getMaxColumns();
  if (shortage > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), shortage);
  if (missing.length) sheet.getRange(1, lastColumn + 1, 1, missing.length).setValues([missing]);
  return headers.concat(missing);
}
// Discord の webhook API はチャンネル名を返さない(channel_id だけ)。
// 台帳の Discordチャンネル タブに名前があるので、そこから埋める(空欄の一覧は読めない)。
function _webhookChannelNames_(book) {
  var map = {};
  var sheet = book.getSheetByName(DISCORD_TAB_NAME_);
  if (!sheet) return map;
  var cols = sheet.getLastColumn(), lastRow = sheet.getLastRow();
  if (!cols || lastRow < 2) return map;
  var headers = sheet.getRange(1, 1, 1, cols).getDisplayValues()[0];
  var idCol = fleetFindHeaderIndex(headers, 'チャンネルID');
  var nameCol = fleetFindHeaderIndex(headers, 'チャンネル名');
  if (idCol < 0 || nameCol < 0) return map;
  sheet.getRange(2, 1, lastRow - 1, cols).getDisplayValues().forEach(function(row) {
    var id = String(row[idCol] || '').trim();
    if (id) map[id] = String(row[nameCol] || '');
  });
  return map;
}

function upsertWebhookLedger(payload) {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) return { ok:false, status:503, error:'busy' };
  try {
    var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID'); if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
    var book = SpreadsheetApp.openById(id), sheet = book.getSheetByName(WEBHOOK_TAB_NAME_) || book.insertSheet(WEBHOOK_TAB_NAME_);
    var headers = _webhookEnsureHeaders_(sheet), dateColumn = cloudColumn(headers, '最終確認日(JST)', true);
    sheet.getRange(2, dateColumn + 1, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('@');
    var lastRow = sheet.getLastRow(), rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues() : [];
    var input = payload || {};
    var channelNames = _webhookChannelNames_(book);
    (Array.isArray(input.webhooks) ? input.webhooks : []).forEach(function(item) {
      if (!item.channelName && item.channelId && channelNames[String(item.channelId)]) item.channelName = channelNames[String(item.channelId)];
    });
    var plan = webhookPlanUpsert(headers, rows, input); _cloudApply_(sheet, plan);
    return { ok:true, updated:plan.updates.length, appended:plan.appendRows.length, missing:plan.missing };
  } finally { lock.releaseLock(); }
}
function lookupWebhooks(payload) {
  var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID'); if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
  var sheet = SpreadsheetApp.openById(id).getSheetByName(WEBHOOK_TAB_NAME_); if (!sheet) return { ok:true, count:0, truncated:false, rows:[], exists:false };
  var cols = sheet.getLastColumn(), lastRow = sheet.getLastRow(), headers = cols ? sheet.getRange(1,1,1,cols).getDisplayValues()[0] : [];
  var rows = lastRow > 1 && cols ? sheet.getRange(2,1,lastRow-1,cols).getDisplayValues() : [], result = webhookMatchRows(headers, rows, payload || {});
  return { ok:true, count:result.count, truncated:result.truncated, rows:result.rows };
}
function describeWebhookLedger() {
  var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID'); if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
  var sheet = SpreadsheetApp.openById(id).getSheetByName(WEBHOOK_TAB_NAME_); if (!sheet) return { ok:true, tab:WEBHOOK_TAB_NAME_, exists:false, headers:[], rowCount:0, rows:[] };
  var cols=sheet.getLastColumn(), lastRow=sheet.getLastRow(), headers=sheet.getRange(1,1,1,cols).getDisplayValues()[0], count=Math.max(0,lastRow-1);
  var values=count?sheet.getRange(2,1,Math.min(5,count),cols).getDisplayValues():[], idCol=cloudColumn(headers,'Webhook ID',true), nameCol=cloudColumn(headers,'Webhook名',true);
  return { ok:true, tab:WEBHOOK_TAB_NAME_, exists:true, headers:headers, rowCount:count, rows:values.map(function(row){return {webhookId:row[idCol],name:row[nameCol]};}) };
}
