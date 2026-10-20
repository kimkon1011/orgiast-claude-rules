var _MEETING_LINK_MASTER_SS = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
var _MEETING_LINK_PANEL = '🚀実行パネル';
var _MEETING_LINK_TITLE_PREFIX = '📎 議事録の日時か件名';

function _MeetingLink_findSection(p) {
  var lastRow = p.getLastRow();
  if (lastRow < 6) return -1;
  var colA = p.getRange(1, 1, lastRow, 1).getValues();
  for (var r = 6; r <= lastRow; r++) {
    if (String(colA[r - 1][0] || '').indexOf(_MEETING_LINK_TITLE_PREFIX) === 0) return r;
  }
  return -1;
}

/**
 * 日時/件名を引数で渡して紐付ける。パネルの📎入力欄に人が手入力する代わりに使う。
 * 既存の Meeting_linkTranscript の挙動は変えず、入力欄に値を置いてから委譲するだけ。
 */
function Meeting_linkTranscriptWithQuery(caseId, query) {
  var ms = SpreadsheetApp.openById(_MEETING_LINK_MASTER_SS);
  var p = ms.getSheetByName(_JobQueue_currentPanel());
  if (!p) throw new Error('実行パネルが見つかりません');
  var sectionRow = _MeetingLink_findSection(p);
  if (sectionRow < 0) throw new Error('議事録入力欄が見つかりません (Panel_rebuild を実行してください)');
  var cell = p.getRange(sectionRow + 1, 3);
  var before = String(cell.getValue() || '');
  cell.setValue(String(query || ''));
  SpreadsheetApp.flush();
  try {
    return Meeting_linkTranscript(caseId);
  } finally {
    // 紐付け成功時は Meeting_linkTranscript 側が clearContent 済み。失敗時のみ元に戻す。
    if (String(cell.getValue() || '') === String(query || '')) cell.setValue(before);
    SpreadsheetApp.flush();
  }
}

function Meeting_linkTranscript(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var ms = SpreadsheetApp.openById(_MEETING_LINK_MASTER_SS);
  var p = ms.getSheetByName(_JobQueue_currentPanel());
  if (!p) throw new Error('実行パネルが見つかりません');
  var sectionRow = _MeetingLink_findSection(p);
  if (sectionRow < 0) throw new Error('議事録入力欄が見つかりません (Panel_rebuild を実行してください)');
  var queryCell = p.getRange(sectionRow + 1, 3); // ラベル=B列、入力=C列 (Panel_rebuild と一致必須)
  var query = String(queryCell.getValue() || '').trim();

  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SALES_CONTEXT_URL');
  var token = props.getProperty('SALES_CONTEXT_TOKEN');
  if (!url || url.indexOf('http') !== 0) url = SALES_CTX_URL_DEFAULT;
  if (!token || token.indexOf('__') === 0) token = SALES_CTX_TOKEN_DEFAULT;
  if (!url || !token) throw new Error('営業アプリの接続設定がありません');
  var originMatch = String(url).match(/^(https?:\/\/[^/]+)/i);
  if (!originMatch) throw new Error('営業アプリURLが不正です');

  var response = UrlFetchApp.fetch(originMatch[1] + '/api/external/link-transcript', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      token: token,
      caseId: c.caseId,
      clientName: c.clientName || '',
      query: query
    }),
    muteHttpExceptions: true
  });
  var body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (e) {
    throw new Error('営業アプリから不正な応答が返りました (HTTP ' + response.getResponseCode() + ')');
  }
  if (!body || !body.ok) throw new Error((body && body.error) || '議事録の紐付けに失敗しました');

  if (body.linked) {
    Case_refreshClientContext(caseId);
    queryCell.clearContent();
    var transcript = body.transcript || {};
    return {
      panelStatus: '✅ 紐付け完了: ' + String(transcript.label || '') + ' ' + String(transcript.subject || '') +
        ' → この案件の議事録として次の生成から反映されます'
    };
  }

  var candidates = body.candidates || [];
  if (candidates.length > 0) {
    var list = candidates.map(function (item) {
      return String(item.label || '') + ' ' + String(item.subject || '');
    }).join(' | ');
    return {
      panelStatus: ('⚠ 候補が複数: ' + list + ' → 📎欄に日時(例 8/17 16:00)を入れて再実行').slice(0, 400)
    };
  }
  return {
    panelStatus: '⚠ 未紐付けの議事録が見つかりません(自動紐付け済みか、まだ取り込まれていません。取り込みは毎晩実行)'
  };
}
