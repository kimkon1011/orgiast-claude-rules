const COST_ROLLUP_SHEET_NAME = '💰原価台帳(全案件)';

function _CostRollup_time(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
  var time = new Date(value).getTime();
  return isNaN(time) ? 0 : time;
}

/** Claude_原価粗利 のデータ行を集約用オブジェクトへ変換する。 */
function CostRollup_collectCaseRows(sourceRows, c, sheetUrl) {
  var out = [];
  (sourceRows || []).forEach(function (row) {
    if (String(row[1] || '').indexOf('原価') !== 0) return;
    out.push({ supplier: row[2], item: row[3], spec: row[4], quantity: row[5], unit: row[6], unitPrice: row[7], amount: row[8], category: row[1], confidence: row[10], caseId: c.caseId, clientName: c.clientName || '', caseName: c.caseName || '', updatedAt: row[0], sheetUrl: sheetUrl, updatedTime: _CostRollup_time(row[0]) });
  });
  return out;
}

function CostRollup_sortRows(rows) {
  return (rows || []).slice().sort(function (a, b) {
    return String(a.supplier || '').localeCompare(String(b.supplier || ''), 'ja') ||
      String(a.item || '').localeCompare(String(b.item || ''), 'ja') || b.updatedTime - a.updatedTime;
  });
}

/** 全案件の Claude_原価粗利 から「原価」系の行を集めて1枚に集約する。 */
function CostRollup_rebuild() {
  var ss = SpreadsheetApp.getActive(), sheet = ss.getSheetByName(COST_ROLLUP_SHEET_NAME) || ss.insertSheet(COST_ROLLUP_SHEET_NAME);
  sheet.clear();
  var cases = TaskLedger_activeCaseIds(), collected = [];
  cases.forEach(function (caseId) {
    try {
      var c = CaseList_getById(caseId);
      if (!c || !c.zissiId) return;
      var zissi = SpreadsheetApp.openById(c.zissiId), source = zissi.getSheetByName(COST_PROFIT_SHEET_NAME);
      if (!source || source.getLastRow() < 4) return;
      var sourceRows = source.getRange(4, 1, source.getLastRow() - 3, 13).getValues();
      var sheetUrl = PanelLinks_sheetUrl(zissi, source);
      collected = collected.concat(CostRollup_collectCaseRows(sourceRows, c, sheetUrl));
    } catch (e) { console.warn('CostRollup_rebuild: ' + caseId + ' / ' + e); }
  });
  collected = CostRollup_sortRows(collected);
  var headers = ['仕入先','項目','仕様','単価','数量','単位','金額','区分','信頼度','案件ID','クライアント','案件名','更新日時','原価台帳を開く'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
  if (collected.length) {
    var values = collected.map(function (x) { return [x.supplier,x.item,x.spec,x.unitPrice,x.quantity,x.unit,x.amount,x.category,x.confidence,x.caseId,x.clientName,x.caseName,x.updatedAt,'=HYPERLINK("' + String(x.sheetUrl).replace(/"/g, '""') + '","💰 原価台帳")']; });
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  }
  sheet.setFrozenRows(1);
  [160,180,220,100,80,70,110,110,90,100,160,220,140,120].forEach(function (width, i) { sheet.setColumnWidth(i + 1, width); });
  return { sheetUrl: PanelLinks_sheetUrl(ss, sheet), rows: collected.length, cases: cases.length, panelResult: '原価 ' + collected.length + '件を全案件から集計しました' };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { CostRollup_collectCaseRows: CostRollup_collectCaseRows, CostRollup_sortRows: CostRollup_sortRows };
