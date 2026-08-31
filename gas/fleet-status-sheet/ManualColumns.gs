function ensureManualColumns() {
  var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID');
  if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
  var book = SpreadsheetApp.openById(id);
  var tabs = {};
  book.getSheets().forEach(function(sheet) {
    var name = sheet.getName();
    if (name === '目次' || name.indexOf('【移行済】') === 0 || sheet.getLastColumn() === 0) return;
    var lastColumn = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    var additions = manualPlanColumns(headers);
    // 追加先がグリッドの右端を超えると getRange が落ちる。足りない分だけ列を増やしてから書く。
    if (additions.length) {
      var shortage = lastColumn + additions.length - sheet.getMaxColumns();
      if (shortage > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), shortage);
      sheet.getRange(1, lastColumn + 1, 1, additions.length).setValues([additions]);
    }
    tabs[name] = additions;
  });
  return { ok: true, tabs: tabs };
}
