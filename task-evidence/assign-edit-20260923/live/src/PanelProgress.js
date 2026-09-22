const _PANEL_PROGRESS_SHEET = '_パネル進捗';
const _PANEL_PROGRESS_HEADERS = ['caseId', 'eventLabel', 'featureKey', 'done', 'source', 'updatedAt', 'updatedBy'];

function PanelProgress_mergeEntry(existing, incoming) {
  if (existing && existing.source === 'manual' && incoming && incoming.source === 'auto') return existing;
  return incoming;
}

function PanelProgress_countByPhase(features, progressMap) {
  var result = {};
  (features || []).forEach(function (feature) {
    if (!result[feature.phase]) result[feature.phase] = { done: 0, total: 0 };
    result[feature.phase].total++;
    if (progressMap && progressMap[feature.key] && progressMap[feature.key].done === true) result[feature.phase].done++;
  });
  return result;
}

function _PanelProgress_sheet() {
  var ms = SpreadsheetApp.openById(_PANEL_MASTER_SS);
  var sheet = ms.getSheetByName(_PANEL_PROGRESS_SHEET);
  if (!sheet) sheet = ms.insertSheet(_PANEL_PROGRESS_SHEET);
  sheet.getRange(1, 1, 1, _PANEL_PROGRESS_HEADERS.length).setValues([_PANEL_PROGRESS_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function PanelProgress_load(caseId) {
  var sheet = _PanelProgress_sheet();
  if (sheet.getLastRow() < 2) return {};
  var wanted = String(caseId || '');
  var result = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues().forEach(function (row) {
    if (String(row[0]) !== wanted) return;
    result[String(row[2])] = { done: row[3] === true, source: String(row[4] || ''), updatedAt: row[5], updatedBy: String(row[6] || '') };
  });
  return result;
}

function PanelProgress_upsert(caseId, eventLabel, featureKey, done, source, user) {
  caseId = String(caseId || ''); featureKey = String(featureKey || '');
  if (!caseId || !featureKey) return { skipped: true };
  var sheet = _PanelProgress_sheet();
  var rows = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  var index = -1;
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === caseId && String(rows[i][2]) === featureKey) { index = i; break; }
  var existing = index < 0 ? null : { done: rows[index][3] === true, source: String(rows[index][4] || ''), updatedAt: rows[index][5], updatedBy: String(rows[index][6] || '') };
  var incoming = { done: done === true, source: String(source || ''), updatedAt: new Date(), updatedBy: String(user || '') };
  var merged = PanelProgress_mergeEntry(existing, incoming);
  if (merged === existing) return { kept: true, entry: existing };
  var values = [[caseId, String(eventLabel || ''), featureKey, merged.done, merged.source, merged.updatedAt, merged.updatedBy]];
  if (index < 0) sheet.getRange(sheet.getLastRow() + 1, 1, 1, 7).setValues(values);
  else sheet.getRange(index + 2, 1, 1, 7).setValues(values);
  return { updated: true, entry: merged };
}

function PanelProgress_applyManual(caseId, eventLabel, featureKey, done, user) {
  // bound 側の onEdit は案件を eventLabel でしか特定できず caseId が空になるため、ここで案件解決する。
  if (!caseId) {
    try {
      caseId = _JobQueue_resolveCase(
        eventLabel,
        _JobQueue_loadResolution(SpreadsheetApp.openById(_PANEL_MASTER_SS))
      ).caseId;
    } catch (err) {
      console.warn('PanelProgress_applyManual: caseId の解決に失敗しました', eventLabel, err);
    }
    if (!caseId) return { skipped: true, reason: 'caseId が解決できない: ' + eventLabel };
  }
  return PanelProgress_upsert(caseId, eventLabel, featureKey, done === true || String(done).toUpperCase() === 'TRUE', 'manual', user);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PanelProgress_mergeEntry: PanelProgress_mergeEntry, PanelProgress_countByPhase: PanelProgress_countByPhase };
}
