function _aiCostTabs_() {
  return {'AI費用サマリ': AI_COST_SUMMARY_HEADERS_, 'freee登録待ち': AI_COST_PENDING_HEADERS_};
}
function _aiCostRead_(name, create) {
  var id = PropertiesService.getScriptProperties().getProperty('CLOUD_LEDGER_SHEET_ID');
  if (!id) throw new Error('CLOUD_LEDGER_SHEET_ID is not configured');
  var book = SpreadsheetApp.openById(id), sheet = book.getSheetByName(name);
  if (!sheet && create) sheet = book.insertSheet(name);
  if (!sheet) return { sheet: null, headers: [], rows: [] };
  if (create) _cloudEnsureHeaders_(sheet, _aiCostTabs_()[name]);
  var columns = sheet.getLastColumn(), lastRow = sheet.getLastRow();
  return {
    sheet: sheet,
    headers: columns && lastRow ? sheet.getRange(1, 1, 1, columns).getDisplayValues()[0] : [],
    rows: lastRow > 1 && columns ? sheet.getRange(2, 1, lastRow - 1, columns).getValues() : []
  };
}
function _aiCostWrite_(name, planner, payload) {
  return _cloudWithLock_(function() {
    // 不正payloadによるタブ作成も避ける。
    planner(_aiCostTabs_()[name], [], payload);
    var data = _aiCostRead_(name, true);
    var plan = planner(data.headers, data.rows, payload);
    _cloudApply_(data.sheet, plan);
    return { ok: true, updated: plan.updates.length, appended: plan.appendRows.length, deleted: (plan.deleteRowNumbers || []).length };
  });
}
function upsertAiCostSummary(payload) { return _aiCostWrite_('AI費用サマリ', aiCostPlanSummaryUpsert, payload); }
function replaceAiCostPending(payload) { return _aiCostWrite_('freee登録待ち', aiCostPlanPendingReplace, payload); }
function describeAiCost() {
  return _cloudWithLock_(function() {
    var result = { ok: true, tabs: {} };
    Object.keys(_aiCostTabs_()).forEach(function(name) {
      // dry-run診断は不足タブの作成・ヘッダ補修も行わない。
      var data = _aiCostRead_(name, false);
      var names = name === 'AI費用サマリ' ? ['年月','サービス','freee計上額(円)','実測利用額(円)','差額(円)'] : ['年月','サービス','金額(円)'];
      var columns = names.map(function(header) { return cloudColumn(data.headers, header, false); });
      result.tabs[name] = { headers: data.headers, rowCount: data.rows.length, columns: names,
        rows: data.rows.map(function(row) { return columns.map(function(col) { return col < 0 ? '' : row[col]; }); }) };
    });
    return result;
  });
}
