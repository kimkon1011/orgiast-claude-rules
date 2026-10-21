function upsertPlanUsage(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) throw new Error('SHEET_ID is not configured');
    const spreadsheet = SpreadsheetApp.openById(id);
    let sheet = spreadsheet.getSheetByName('Claude上限');
    if (!sheet) {
      // NOW() and the displayed reset dates must use the same time zone as reportedAt.
      // 報告ごとに書き換えると毎回スプレッドシート設定へ書き込むため、タブ作成時の1回だけ。
      if (spreadsheet.getSpreadsheetTimeZone() !== 'Asia/Tokyo') spreadsheet.setSpreadsheetTimeZone('Asia/Tokyo');
      spreadsheet.setRecalculationInterval(SpreadsheetApp.RecalculationInterval.HOUR);
      sheet = spreadsheet.insertSheet('Claude上限');
      sheet.getRange(1, 1, 1, PLAN_USAGE_HEADERS_.length).setValues([PLAN_USAGE_HEADERS_]);
      sheet.setFrozenRows(1);
      const ranges = [sheet.getRange('B2:B'), sheet.getRange('D2:D')];
      sheet.setConditionalFormatRules([
        SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0.2).setBackground('#f4cccc').setRanges(ranges).build(),
        SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0.5).setBackground('#fff2cc').setRanges(ranges).build()
      ]);
    }
    // タブ作成直後に失敗すると見出しが空のまま残る（2026-10-21 実測）。毎回自己修復する。
    if (sheet.getRange(1, 1).getDisplayValue() !== PLAN_USAGE_HEADERS_[0]) {
      sheet.getRange(1, 1, 1, PLAN_USAGE_HEADERS_.length).setValues([PLAN_USAGE_HEADERS_]);
      sheet.setFrozenRows(1);
    }
    // §2.11 方式B: 見る人が使う画面（このタブ）に共通の不具合・要望フォームを置く。
    const feedbackCell = sheet.getRange(1, PLAN_USAGE_HEADERS_.length + 1);
    if (!feedbackCell.getFormula()) feedbackCell.setFormula('=HYPERLINK("' + PLAN_USAGE_FEEDBACK_URL_ + '","不具合・要望")');
    const count = Math.max(0, sheet.getLastRow() - 1);
    const rows = count ? sheet.getRange(2, 1, count, PLAN_USAGE_HEADERS_.length).getValues() : [];
    const plan = planUsageUpsert(rows, payload);
    if (plan.action === 'ignored') return { ok: true, action: 'ignored' };
    const target = plan.rowIndex + 2;
    if (target > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), target - sheet.getMaxRows());
    // Treat client text as literals, never as spreadsheet formulas.
    const values = plan.row.map(function(value, i) { return (i === 0 || i >= 5 && i <= 8) && typeof value === 'string' && value.charAt(0) === '=' ? "'" + value : value; });
    sheet.getRange(target, 8).setNumberFormat('@');
    sheet.getRange(target, 1, 1, PLAN_USAGE_HEADERS_.length).setValues([values]);
    const rowCount = Math.max(count, plan.rowIndex + 1);
    sheet.getRange(2, 2, rowCount, 1).setNumberFormat('0%');
    sheet.getRange(2, 4, rowCount, 1).setNumberFormat('0%');
    sheet.getRange(2, 3, rowCount, 1).setNumberFormat('M/d HH:mm');
    sheet.getRange(2, 5, rowCount, 1).setNumberFormat('M/d HH:mm');
    sheet.getRange(2, 12, rowCount, 2).setNumberFormat('yyyy-MM-dd HH:mm');
    SpreadsheetApp.flush();
    sheet.getRange(2, 1, rowCount, PLAN_USAGE_HEADERS_.length).sort({ column: 4, ascending: true });
    // Restore row-local references after sorting, including on older Sheets runtimes.
    const formulas = [];
    for (let i = 0; i < rowCount; i++) formulas.push(planUsageFormulas(i + 2));
    sheet.getRange(2, 2, rowCount, 4).setFormulas(formulas);
    return { ok: true, action: plan.action };
  } finally {
    lock.releaseLock();
  }
}
