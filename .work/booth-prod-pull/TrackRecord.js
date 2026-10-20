/**
 * 実績リスト: 報告書生成後の案件情報を集約する。
 * 同一案件は更新し、公表可否・備考は保持する。
 * 公表が許可された実績のみ、社内情報を除いた JSON として出力する。
 */
const TRACK_RECORD_SHEET_NAME = '実績リスト';

function TrackRecord_ensureSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TRACK_RECORD_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TRACK_RECORD_SHEET_NAME);
    sheet.getRange(1, 1, 1, 9).setValues([
      ['記録日時', '案件ID', '案件名', 'クライアント', '出展期間', 'ブースサイズ', '報告書URL', '公表OK', '備考']
    ]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _TrackRecord_fmtDate(value) {
  if (!(value instanceof Date)) return String(value);
  return String(value.getFullYear()).padStart(4, '0') + '/' +
    String(value.getMonth() + 1).padStart(2, '0') + '/' +
    String(value.getDate()).padStart(2, '0');
}

function TrackRecord_appendFromCase(caseId, reportUrl) {
  const c = CaseList_getById(caseId);
  if (!c) return { ok: false, error: '案件が見つかりません: ' + caseId };
  const sheet = TrackRecord_ensureSheet();
  const rows = sheet.getDataRange().getValues();
  const values = [new Date(), c.caseId, c.caseName, c.clientName,
    _TrackRecord_fmtDate(c.startDate) + ' 〜 ' + _TrackRecord_fmtDate(c.endDate),
    c.boothSize, reportUrl || ''];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1]).trim() === String(c.caseId).trim()) {
      // H/I 列は書き込まず、公表可否・備考（数式を含む）を保持する。
      sheet.getRange(i + 1, 1, 1, 7).setValues([values]);
      return { ok: true, caseId: c.caseId, updated: true };
    }
  }
  sheet.appendRow(values.concat(['', '']));
  return { ok: true, caseId: c.caseId, appended: true };
}

function TrackRecord_hookPostReport(caseId, reportUrl) {
  try {
    return TrackRecord_appendFromCase(caseId, reportUrl);
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    console.log('TrackRecord_hookPostReport: ' + error);
    return { ok: false, error: error };
  }
}

function TrackRecord_backfillAll() {
  const cases = CaseList_listAll();
  const rows = TrackRecord_ensureSheet().getDataRange().getValues();
  const existing = new Set(rows.slice(1).map(function (row) { return String(row[1]).trim(); }));
  let appended = 0;
  cases.forEach(function (c) {
    const id = String(c.caseId).trim();
    if (existing.has(id)) return;
    const result = TrackRecord_appendFromCase(c.caseId, '');
    if (result.ok) {
      existing.add(id);
      if (result.appended) appended++;
    }
  });
  return { ok: true, appended: appended, total: cases.length };
}

function TrackRecord_exportJson() {
  const rows = TrackRecord_ensureSheet().getDataRange().getValues();
  const items = rows.slice(1).filter(function (row) {
    // 「FALSE」などの非空文字列を誤って公表許可として扱わない。
    return /^(true|1|ok|〇|○)$/i.test(String(row[7]).trim());
  }).map(function (row) {
    return { caseName: row[2], clientName: row[3], period: row[4], boothSize: row[5], reportUrl: row[6] };
  });
  return JSON.stringify({ exportedAt: new Date().toISOString(), items: items }, null, 2);
}
