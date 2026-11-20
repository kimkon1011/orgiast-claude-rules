/**
 * 案件管理シートとの入出力を管理する。
 *
 * 想定するシート構成:
 * - 「広告テキスト」タブ: A列=テキストID, B列=広告テキスト, C列〜E列=解析結果（感情スコア・ターゲット層・改善案）
 * - 解析済みフラグ: B列が空でなく、かつC〜E列のいずれかが空なら未解析
 *
 * シートIDは Script Properties の SHEET_ID に保存する。
 */

var SHEET_TAB_NAME_ = '広告テキスト';

/**
 * シートの設定を検証する。
 * @return {Object} { configured: boolean, sheetId: string|null, tabFound: boolean }
 */
function describeSheetConfig() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) return { configured: false, sheetId: null, tabFound: false };
  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName(SHEET_TAB_NAME_);
    return { configured: true, sheetId: sheetId, tabFound: !!sheet };
  } catch (e) {
    return { configured: true, sheetId: sheetId, tabFound: false, error: e.message };
  }
}

/**
 * シートIDを設定する。
 * @param {Object|string} args - { sheetId: string } または文字列
 */
function setSheetId(args) {
  var id = (args && typeof args.sheetId === 'string') ? args.sheetId
    : (typeof args === 'string' ? args : '');
  if (!id || id.length < 10) throw new Error('Invalid sheet ID');
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', id);
  return { ok: true, sheetId: id };
}

/**
 * 未解析の広告テキスト行を取得する。
 * @return {Array<{row: number, adId: string, text: string}>}
 */
function getUnanalyzedAds() {
  var sheet = _getTabOrThrow_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var range = sheet.getRange(1, 1, lastRow, 5); // A〜E列
  var values = range.getDisplayValues();
  var results = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var adId = String(row[0] || '');
    var text = String(row[1] || '').trim();
    var sentiment = String(row[2] || '').trim();
    var target = String(row[3] || '').trim();
    var improvement = String(row[4] || '').trim();

    // テキストが空ならスキップ
    if (!text) continue;
    // 既に全項目が埋まっている（解析済み）ならスキップ
    if (sentiment && target && improvement) continue;

    results.push({
      row: i + 1,
      adId: adId,
      text: text
    });
  }
  return results;
}

/**
 * 解析結果をシートに書き込み、read-back で検証する。
 * @param {number} row - 行番号（1始まり）
 * @param {Object} result - { sentiment, target, improvement }
 * @return {Object} { ok: boolean, row: number, written: string[] }
 */
function writeAnalysisResult(row, result) {
  var sheet = _getTabOrThrow_();
  var values = [[
    String(result.sentiment || ''),
    String(result.target || ''),
    String(result.improvement || '')
  ]];
  var range = sheet.getRange(row, 3, 1, 3);
  range.setValues(values);
  SpreadsheetApp.flush();

  // read-back verify — gas.md §3 必須
  var readBack = sheet.getRange(row, 3, 1, 3).getDisplayValues()[0];
  var written = [];
  for (var i = 0; i < 3; i++) {
    if (readBack[i] !== values[0][i]) {
      // 再試行: setValues で強制再設定
      range.setValues(values);
      SpreadsheetApp.flush();
      readBack = sheet.getRange(row, 3, 1, 3).getDisplayValues()[0];
      if (readBack[i] !== values[0][i]) {
        throw new Error('Read-back verify failed at row ' + row + ' col ' + (i + 3)
          + ': wrote "' + values[0][i] + '" but read "' + readBack[i] + '"');
      }
    }
    written.push(readBack[i]);
  }
  return { ok: true, row: row, written: written };
}

/**
 * 全行の解析状態サマリを返す。
 * @return {Object} { total, analyzed, pending }
 */
function summarizeAnalysisStatus() {
  var sheet = _getTabOrThrow_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { total: 0, analyzed: 0, pending: 0 };
  var values = sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues();
  var total = 0, analyzed = 0, pending = 0;
  values.forEach(function (row) {
    var text = String(row[1] || '').trim();
    if (!text) return;
    total++;
    var sentiment = String(row[2] || '').trim();
    var target = String(row[3] || '').trim();
    var improvement = String(row[4] || '').trim();
    if (sentiment && target && improvement) {
      analyzed++;
    } else {
      pending++;
    }
  });
  return { total: total, analyzed: analyzed, pending: pending };
}

function _getTabOrThrow_() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) throw new Error('SHEET_ID is not configured. Run setSheetId first.');
  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ss.getSheetByName(SHEET_TAB_NAME_);
  if (!sheet) throw new Error('Tab "' + SHEET_TAB_NAME_ + '" not found in sheet ' + sheetId);
  return sheet;
}