const COVER_LETTER_SHEET_NAME = 'Claude_送付文';
const COVER_LETTER_HEADERS = ['作成日時', '種別', '件名', '本文', '添付ファイル名', 'ファイルURL'];

function _CoverLetter_classifyType(text, files) {
  var value = String(text || '');
  if (/請求|インボイス|お支払/.test(value) || (files || []).some(function (f) { return /請求/.test(f.name); })) return '請求送付';
  if (/見積|お見積/.test(value) || (files || []).some(function (f) { return /見積/.test(f.name); })) return '見積送付';
  return 'その他';
}

function _CoverLetter_recentFiles(folder) {
  var it = folder.getFiles(), files = [];
  while (it.hasNext()) {
    var f = it.next(), name = f.getName(), type = f.getMimeType();
    if (!/(見積|請求)/.test(name)) continue;
    if (type !== MimeType.GOOGLE_SHEETS && type !== MimeType.PDF) continue;
    files.push({ name: name, url: f.getUrl(), updated: f.getLastUpdated().getTime(), type: type });
  }
  files.sort(function (a, b) { return b.updated - a.updated; });
  var chosen = {}, out = [];
  files.forEach(function (file) {
    var key = (/請求/.test(file.name) ? '請求' : '見積') + '|' + file.type;
    if (!chosen[key]) { chosen[key] = true; out.push(file); }
  });
  return out;
}

function _CoverLetter_writeLinks(range, files, emptyMessage) {
  if (!files.length) { range.setValue(emptyMessage).setWrap(true); return; }
  var text = files.map(function (f) { return f.name; }).join('\n');
  var builder = SpreadsheetApp.newRichTextValue().setText(text), offset = 0;
  files.forEach(function (f) { builder.setLinkUrl(offset, offset + f.name.length, f.url); offset += f.name.length + 1; });
  range.setRichTextValue(builder.build()).setWrap(true);
}

function Phase_CoverLetter_generate(caseId, pastedText) {
  if (pastedText === undefined) { var panel = _PanelInput_currentSheet(); pastedText = panel ? PanelInput_read(panel) : ''; }
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  var zissi = _Zissi_open(c), folder = DriveApp.getFolderById(c.projectFolderId || c.folderId);
  var files = _CoverLetter_recentFiles(folder), type = _CoverLetter_classifyType(pastedText, files);
  var res = ClaudeClient_call({ cachedContext: [Case_loadClientContext(c)], userMessage: [
    '見積書または請求書を送るための件名と本文を、丁寧なビジネス日本語で作成。JSONのみ {"subject":"","body":""}。',
    '宛名は「' + c.clientName + ' ご担当者様」、締めは「株式会社オージャスト」。',
    '種別: ' + type,
    '添付候補: ' + (files.length ? files.map(function (f) { return f.name; }).join(', ') : 'まだなし'),
    String(pastedText || '').trim() ? '【貼付欄の指示】\n' + String(pastedText).trim().slice(0, 12000) : ''
  ].join('\n'), maxTokens: 2500 });
  var data = _Phase1_parseJson(res.text);
  var sheet = zissi.getSheetByName(COVER_LETTER_SHEET_NAME);
  if (!sheet) { sheet = zissi.insertSheet(COVER_LETTER_SHEET_NAME); sheet.getRange(1, 1, 1, 6).setValues([COVER_LETTER_HEADERS]).setFontWeight('bold').setBackground('#fff3e0'); }
  else if (sheet.getLastRow() < 1) sheet.getRange(1, 1, 1, 6).setValues([COVER_LETTER_HEADERS]);
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, 5).setValues([[new Date(), type, data.subject || '', data.body || '', files.length ? files.map(function (f) { return f.name; }).join('\n') : '添付する見積書/請求書がまだありません']]).setWrap(true);
  _CoverLetter_writeLinks(sheet.getRange(2, 6), files, '添付する見積書/請求書がまだありません');
  sheet.setColumnWidth(3, 300); sheet.setColumnWidth(4, 520); sheet.setColumnWidth(5, 280); sheet.setColumnWidth(6, 360); sheet.setFrozenRows(1);
  var url = PanelLinks_sheetUrl(zissi, sheet);
  try { MasterWriteBack_recordArtifact(caseId, '送付文', data.subject || type, url); } catch (e) {}
  return { ok: true, coverLetterSheetUrl: url, rows: 1 };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { _CoverLetter_classifyType: _CoverLetter_classifyType };
