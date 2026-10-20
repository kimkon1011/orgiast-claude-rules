/** 案件IDから、施工手順書パネルと同じ条件で適用ノウハウを返す。 */
function ConstructionKnowhow_forCase(caseId, extraText) {
  let c = null;
  let caseLoaded = false;
  try {
    if (typeof CaseList_getById === 'function') c = CaseList_getById(caseId);
    caseLoaded = !!c;
  } catch (e) {
    console.warn('施工ノウハウ: 案件読込失敗: ' + String(e && e.message || e));
  }
  if (!c) c = { caseId: caseId };

  const extra = _Phase2_constructionKnowhowExtra(c) + '\n' + (extraText || '');
  const rows = _Phase2_applicableConstructionKnowhow(c, null, extra);
  const entries = rows.map(function (r) {
    return {
      id: r.id,
      status: r.status,
      type: r.type,
      phase: r.phase,
      category: r.category,
      title: r.title,
      body: r.body,
      steps: r.steps,
      condition: r.condition
    };
  });
  const result = {
    caseId: caseId,
    caseLoaded: caseLoaded,
    count: rows.length,
    ids: rows.map(function (r) { return r.id; }),
    entries: entries
  };

  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const markerFolder = _cmdQueue_childFolder(DriveApp.getFolderById(CMD_FOLDER_ID), 'kh_forcase');
  markerFolder
    .createFile('khcase_' + caseId + '_' + rows.length + '_' + stamp + '.txt', JSON.stringify(result), MimeType.PLAIN_TEXT)
    .setDescription(JSON.stringify({ caseId: caseId, count: rows.length, ids: result.ids }));
  return result;
}
