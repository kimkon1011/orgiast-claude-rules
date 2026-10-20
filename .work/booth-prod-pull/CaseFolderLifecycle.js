/** PJ フォルダは approach → won → archived の前方だけ移動する。 */
const CASE_FOLDER_APPROACH_ID = '0B4U7jwDkjHb_b2lsa1lFLUZZTkE';
const CASE_FOLDER_PROJECT_ROOT_ID = '0B4U7jwDkjHb_NkNnVXVwYW5vbUE';
const CASE_FOLDER_CLIENT_ARCHIVE_ID = '0B4U7jwDkjHb_Z2Itbm96SW9nTWc';

/** masterInfo: { label, remain, done, unnecessary }。欠損カウントは完了扱いしない。 */
function CaseFolderLifecycle_stageOf(c, masterInfo) {
  if (!c || !c.masterSsId || !c.masterCol || !masterInfo) return 'approach';
  const label = String(masterInfo.label == null ? '' : masterInfo.label)
    .normalize('NFKC').trim().replace(/^【|】$/g, '').trim();
  if (label === '失注') return 'lost';
  const counts = [masterInfo.remain, masterInfo.done, masterInfo.unnecessary];
  const valid = counts.every(function (v) {
    return v !== null && v !== undefined && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0;
  });
  if (label === '完了' && valid && Number(counts[0]) === 0 && Number(counts[1]) + Number(counts[2]) > 0) return 'archived';
  return ['受注', '初動', '第1フェーズ', '第2フェーズ', '第3フェーズ', '第4フェーズ', '本番前', '本番', 'アフター', 'ここまでは本番後一週間を目処に', '完了'].indexOf(label) >= 0 ? 'won' : 'approach';
}

function CaseFolderLifecycle_sync(caseId, opts) {
  opts = opts || {};
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const result = { caseId: caseId, stage: 'approach', moved: false, parentId: null, reason: '' };
  function skip(reason) { result.reason = reason; result.skipped = reason; return result; }
  if (!c.projectFolderId) return skip('no project folder');
  let info = null;
  if (c.masterSsId && c.masterCol) {
    if (!Number.isInteger(Number(c.masterCol)) || Number(c.masterCol) < 1) throw new Error('invalid masterCol: ' + c.masterCol);
    const task = SpreadsheetApp.openById(c.masterSsId).getSheetByName('task');
    if (!task) throw new Error('master task シートがありません: ' + c.masterSsId);
    const col = Number(c.masterCol);
    const counts = task.getRange(11, col, 1, 3).getValues()[0];
    info = { label: task.getRange(8, col).getValue(), remain: counts[0], done: counts[1], unnecessary: counts[2] };
  }
  result.stage = CaseFolderLifecycle_stageOf(c, info);
  if (result.stage === 'lost') return skip('lost');
  const folder = DriveApp.getFolderById(c.projectFolderId);
  const parents = folder.getParents();
  if (!parents.hasNext()) return skip('unknown parent');
  const parent = parents.next();
  result.parentId = parent.getId();
  // 複数親からの moveTo は意図しない親を外す可能性があるため保留。
  if (parents.hasNext()) return skip('multiple parents');
  let rank = -1;
  if (result.parentId === CASE_FOLDER_APPROACH_ID) rank = 0;
  else if (result.parentId === CASE_FOLDER_PROJECT_ROOT_ID) rank = 1;
  else if (result.parentId === CASE_FOLDER_CLIENT_ARCHIVE_ID) rank = 2;
  else {
    const grandparents = parent.getParents();
    while (grandparents.hasNext()) {
      if (grandparents.next().getId() === CASE_FOLDER_CLIENT_ARCHIVE_ID) rank = 2;
    }
  }
  if (rank < 0) return skip('unknown parent');
  const targetRank = { approach: 0, won: 1, archived: 2 }[result.stage];
  if (targetRank < rank) return skip('no backward move');
  if (targetRank === rank) return skip('already at stage');
  let target;
  if (result.stage === 'archived') {
    const clientName = String(c.clientName || '').trim();
    if (!clientName) return skip('no client name');
    const archive = DriveApp.getFolderById(CASE_FOLDER_CLIENT_ARCHIVE_ID);
    const matches = archive.getFoldersByName(clientName);
    target = matches.hasNext() ? matches.next() : null;
    if (matches.hasNext()) return skip('ambiguous client folder');
    if (!target && opts.dryRun) {
      result.targetParentId = null;
      result.targetClientName = clientName;
      result.targetArchiveId = CASE_FOLDER_CLIENT_ARCHIVE_ID;
    } else if (!target) target = archive.createFolder(clientName);
  } else {
    target = DriveApp.getFolderById(result.stage === 'won' ? CASE_FOLDER_PROJECT_ROOT_ID : CASE_FOLDER_APPROACH_ID);
  }
  if (target) result.targetParentId = target.getId();
  if (opts.dryRun) {
    result.wouldMove = true;
    return skip('dry run');
  }
  folder.moveTo(target);
  result.moved = true;
  result.parentId = target.getId();
  result.reason = 'moved forward';
  return result;
}

/** updated は正常に判定した案件数、moved は実移動数。results に全案件の結果を保持。 */
function CaseFolderLifecycle_syncAll(opts) {
  const summary = { updated: 0, moved: 0, skipped: 0, errors: [], results: [] };
  CaseList_listAll().forEach(function (c) {
    try {
      const result = CaseFolderLifecycle_sync(c.caseId, opts || {});
      summary.results.push(result);
      summary.updated++;
      if (result.moved) summary.moved++;
      else summary.skipped++;
    } catch (e) {
      const error = { caseId: c.caseId, moved: false, reason: String(e.message || e) };
      summary.errors.push(error);
      summary.results.push(error);
    }
  });
  return summary;
}

/** L列が空の時だけ作成。保存失敗後の再試行も同名フォルダを再利用する。 */
function CaseFolderLifecycle_ensureProjectFolder(c) {
  if (c.projectFolderId) return DriveApp.getFolderById(c.projectFolderId);
  const approach = DriveApp.getFolderById(CASE_FOLDER_APPROACH_ID);
  const name = c.caseId + '_' + c.clientName + '_' + c.caseName;
  const matches = approach.getFoldersByName(name);
  const folder = matches.hasNext() ? matches.next() : approach.createFolder(name);
  if (matches.hasNext()) throw new Error('同名のPJフォルダが複数あります: ' + name);
  CaseList_setZissiInfo(c.caseId, c.zissiId || '', folder.getId());
  c.projectFolderId = folder.getId();
  return folder;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CASE_FOLDER_APPROACH_ID, CASE_FOLDER_PROJECT_ROOT_ID, CASE_FOLDER_CLIENT_ARCHIVE_ID,
    CaseFolderLifecycle_stageOf, CaseFolderLifecycle_sync, CaseFolderLifecycle_syncAll, CaseFolderLifecycle_ensureProjectFolder };
}
