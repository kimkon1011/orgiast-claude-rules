var PANEL_INPUT_TITLE_PREFIX = '📝 お客様の文章・口頭メモをここに貼る';

function PanelInput_findSection(panelSheet) {
  var lastRow = panelSheet ? panelSheet.getLastRow() : 0;
  if (lastRow < 6) return -1;
  var values = panelSheet.getRange(6, 1, lastRow - 5, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').indexOf(PANEL_INPUT_TITLE_PREFIX) === 0) return i + 6;
  }
  return -1;
}

function PanelInput_read(panelSheet) {
  var row = PanelInput_findSection(panelSheet);
  return row < 0 ? '' : String(panelSheet.getRange(row + 1, 3).getValue() || '').trim();
}

function _PanelInput_currentSheet() {
  return SpreadsheetApp.openById(_PANEL_MASTER_SS).getSheetByName(_JobQueue_currentPanel());
}

function _debug_panelInputSection(caseId) {
  var master = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var sheet = master.getSheets().filter(function (candidate) {
    try { return _Panel_isMarker(String(candidate.getRange('G1').getValue())) && String(candidate.getRange('G4').getValue() || '') === String(caseId || ''); }
    catch (e) { return false; }
  })[0] || null;
  if (!sheet) return { error: '実行パネルが見つかりません', caseId: String(caseId || '') };
  return { sheetName: sheet.getName(), gid: sheet.getSheetId(), inputRow: PanelInput_findSection(sheet), currentText: PanelInput_read(sheet), meetingRow: _MeetingLink_findSection(sheet) };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { PanelInput_findSection: PanelInput_findSection, PANEL_INPUT_TITLE_PREFIX: PANEL_INPUT_TITLE_PREFIX };
