/**
 * 案件一覧シートの CRUD と進捗管理。
 *
 * 列構成 (A〜N):
 *   A 案件ID  B クライアント名  C 案件名  D 出展期間(開始)  E 出展期間(終了)
 *   F ブースサイズ  G 現在フェーズ  H 確認事項数(未回答)  I Drive フォルダID  J 最終更新日時
 *   K 実施計画書ID  L legacy プロジェクトフォルダID
 *   M masterSsId (取り込み元 SS ID, 例: タスク進捗管理表)  N masterCol (元 SS 内の案件列番号)
 */

const CASE_LIST_SHEET_NAME = '案件一覧';
const CASE_LIST_HEADERS = [
  '案件ID', 'クライアント名', '案件名', '出展期間(開始)', '出展期間(終了)',
  'ブースサイズ', '現在フェーズ', '確認事項数', 'Drive フォルダID', '最終更新日時',
  '実施計画書ID', 'プロジェクトフォルダID', 'master SS ID', 'master col'
];
const CASE_COL_ZISSI_ID = 11;       // K列
const CASE_COL_PROJECT_FOLDER = 12; // L列
const CASE_COL_MASTER_SS = 13;      // M列
const CASE_COL_MASTER_COL = 14;     // N列
const APP_ROOT_FOLDER_ID = '1Yt1E9En7K8tMVONET32KgHkMWR4jWT8t'; // Downloads/ブース制作アプリ in Drive

function CaseList_init() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CASE_LIST_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(CASE_LIST_HEADERS);
    sheet.getRange(1, 1, 1, CASE_LIST_HEADERS.length)
      .setFontWeight('bold').setBackground('#cfe2f3');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, CASE_LIST_HEADERS.length, 130);
    sheet.setColumnWidth(3, 200); // 案件名
    sheet.setColumnWidth(9, 280); // Drive フォルダID
  } else {
    // 既存シートのヘッダーが古い列数なら拡張
    const currentCols = sheet.getLastColumn();
    if (currentCols < CASE_LIST_HEADERS.length) {
      const missing = CASE_LIST_HEADERS.slice(currentCols);
      sheet.getRange(1, currentCols + 1, 1, missing.length).setValues([missing])
        .setFontWeight('bold').setBackground('#cfe2f3');
    }
  }
  SpreadsheetApp.getUi().alert('案件一覧シートを初期化しました。');
}

/**
 * 既存シートのヘッダーを最新スキーマに拡張（UI なしで実行可）。
 */
function CaseList_ensureSchema() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) throw new Error('案件一覧シートが存在しません');
  const currentCols = sheet.getLastColumn();
  if (currentCols < CASE_LIST_HEADERS.length) {
    const missing = CASE_LIST_HEADERS.slice(currentCols);
    sheet.getRange(1, currentCols + 1, 1, missing.length).setValues([missing])
      .setFontWeight('bold').setBackground('#cfe2f3');
    return { extended: true, added: missing };
  }
  return { extended: false };
}

function CaseList_create(payload) {
  // payload: { clientName, caseName, startDate, endDate, boothSize }
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) {
    CaseList_init();
    sheet = ss.getSheetByName(CASE_LIST_SHEET_NAME);
  }
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const caseId = _CaseList_nextId(sheet);
    const existing = _CaseList_findByCaseId(sheet, caseId);
    if (existing) return existing;
    const folder = _CaseList_createCaseFolder(caseId, payload.clientName, payload.caseName);
    const now = new Date();
    sheet.appendRow([
      caseId,
      payload.clientName,
      payload.caseName,
      payload.startDate || '',
      payload.endDate || '',
      payload.boothSize || '',
      1,        // 現在フェーズ
      0,        // 確認事項数
      folder.getId(),
      now
    ]);
    return { caseId: caseId, folderId: folder.getId(), folderUrl: folder.getUrl() };
  } finally {
    lock.releaseLock();
  }
}

function CaseList_getActive() {
  // 現在カーソルが乗っている行から案件IDを取得。取れなければ最新案件にフォールバック。
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) return null;
  const row = sheet.getActiveCell().getRow();
  if (row >= 2) {
    const cell = sheet.getRange(row, 1).getValue();
    if (cell) {
      const found = CaseList_getById(cell);
      if (found) return found;
    }
  }
  // Fallback: 最終行（最新案件）
  if (sheet.getLastRow() >= 2) {
    return CaseList_getById(sheet.getRange(sheet.getLastRow(), 1).getValue());
  }
  return null;
}

function CaseList_getById(caseId) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  const needle = String(caseId || '').trim();
  for (let i = 1; i < data.length; i++) {
    const cellId = String(data[i][0] || '').trim();
    if (cellId === needle) {
      return {
        rowIndex: i + 1,
        caseId: cellId,
        clientName: String(data[i][1] || ''),
        caseName: String(data[i][2] || ''),
        startDate: data[i][3] instanceof Date ? Utilities.formatDate(data[i][3], 'Asia/Tokyo', 'yyyy/MM/dd') : String(data[i][3] || ''),
        endDate: data[i][4] instanceof Date ? Utilities.formatDate(data[i][4], 'Asia/Tokyo', 'yyyy/MM/dd') : String(data[i][4] || ''),
        boothSize: String(data[i][5] || ''),
        phase: Number(data[i][6]) || 1,
        unresolvedCount: Number(data[i][7]) || 0,
        folderId: String(data[i][8] || ''),
        updatedAt: data[i][9] instanceof Date ? Utilities.formatDate(data[i][9], 'Asia/Tokyo', 'yyyy/MM/dd HH:mm') : String(data[i][9] || ''),
        zissiId: String(data[i][10] || ''),
        projectFolderId: String(data[i][11] || ''),
        masterSsId: String(data[i][12] || ''),
        masterCol: Number(data[i][13]) || 0
      };
    }
  }
  return null;
}

function CaseList_listAll() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][0] || '').trim();
    if (!id) continue;
    out.push({
      caseId: id,
      clientName: String(data[i][1] || ''),
      caseName: String(data[i][2] || ''),
      endDate: data[i][4] instanceof Date ? Utilities.formatDate(data[i][4], 'Asia/Tokyo', 'yyyy/MM/dd') : String(data[i][4] || ''),
      phase: Number(data[i][6]) || 1
    });
  }
  return out;
}

/**
 * 既存の実施計画書 URL から案件一覧へ取り込む。
 * @param {string} urlOrId 実施計画書 Sheet の URL または ID
 * @param {object} [override] 自動抽出を上書きする値 { clientName, caseName, startDate, endDate, boothSize, phase }
 * @return {object} { caseId, rowIndex, zissiId, zissiUrl, projectFolderId, extracted, used }
 */
function CaseList_importFromZissiUrl(urlOrId, override) {
  override = override || {};
  const zissiId = _CaseList_extractSheetId(urlOrId);
  if (!zissiId) throw new Error('Sheet ID を URL から取得できません: ' + urlOrId);

  let zissiSs;
  try {
    zissiSs = SpreadsheetApp.openById(zissiId);
  } catch (e) {
    throw new Error('実施計画書を開けません (ID=' + zissiId + '): ' + e.message);
  }

  // 重複チェック: 既に同 zissiId が登録済みなら早期 return
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) throw new Error('案件一覧シートがありません。先に「案件一覧シートを初期化」を実行してください。');
  const dup = _CaseList_findByZissiId(sheet, zissiId);
  if (dup) {
    return {
      duplicate: true,
      caseId: dup.caseId,
      rowIndex: dup.rowIndex,
      zissiId: zissiId,
      message: '既に案件 ' + dup.caseId + ' で登録済みです。'
    };
  }

  // 自動抽出
  const extracted = _CaseList_extractZissiMetadata(zissiSs);

  // プロジェクトフォルダ = zissi の親フォルダ（最初の1つ）
  let projectFolderId = '';
  try {
    const parents = DriveApp.getFileById(zissiId).getParents();
    if (parents.hasNext()) projectFolderId = parents.next().getId();
  } catch (e) {}

  // 最終値の組み立て（override 優先）
  const clientName = override.clientName || extracted.clientName || '';
  const caseName = override.caseName || extracted.caseName || zissiSs.getName();
  const startDate = override.startDate || extracted.startDate || '';
  const endDate = override.endDate || extracted.endDate || '';
  const boothSize = override.boothSize || '';
  const phase = override.phase || 2; // 実施計画があるなら最低 Phase 2

  if (!clientName || !caseName) {
    throw new Error('クライアント名・案件名のいずれかが取得できません。override で明示してください。' +
      ' (extracted: ' + JSON.stringify(extracted) + ')');
  }

  // 案件 Drive フォルダ作成（成果物書き出し先）
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    // 待機中に同じ実施計画が取り込まれた場合も追加しない。
    const concurrentDup = _CaseList_findByZissiId(sheet, zissiId);
    if (concurrentDup) {
      return {
        duplicate: true,
        caseId: concurrentDup.caseId,
        rowIndex: concurrentDup.rowIndex,
        zissiId: zissiId,
        message: '既に案件 ' + concurrentDup.caseId + ' で登録済みです。'
      };
    }
    const caseId = _CaseList_nextId(sheet);
    const existingCase = _CaseList_findByCaseId(sheet, caseId);
    if (existingCase) {
      return {
        duplicate: true,
        caseId: existingCase.caseId,
        rowIndex: existingCase.rowIndex,
        zissiId: zissiId,
        message: '既に案件 ' + existingCase.caseId + ' で登録済みです。'
      };
    }
    const caseFolder = _CaseList_createCaseFolder(caseId, clientName, caseName);
    const now = new Date();
    sheet.appendRow([
      caseId,
      clientName,
      caseName,
      startDate,
      endDate,
      boothSize,
      phase,
      0,
      caseFolder.getId(),
      now,
      zissiId,
      projectFolderId,
      String(override.masterSsId || ''),
      Number(override.masterCol) || ''
    ]);

    return {
      duplicate: false,
      caseId: caseId,
      rowIndex: sheet.getLastRow(),
      zissiId: zissiId,
      zissiUrl: zissiSs.getUrl(),
      projectFolderId: projectFolderId,
      caseFolderId: caseFolder.getId(),
      caseFolderUrl: caseFolder.getUrl(),
      extracted: extracted,
      used: { clientName: clientName, caseName: caseName, startDate: startDate, endDate: endDate, boothSize: boothSize, phase: phase }
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * UI から呼ばれるプレビュー（DB 書き込みなしで extract のみ）
 */
function _CaseList_previewZissi(urlOrId) {
  const zissiId = _CaseList_extractSheetId(urlOrId);
  if (!zissiId) throw new Error('Sheet ID を URL から取得できません');
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (sheet) {
    const dup = _CaseList_findByZissiId(sheet, zissiId);
    if (dup) return { duplicate: true, caseId: dup.caseId, zissiId: zissiId };
  }
  const zissiSs = SpreadsheetApp.openById(zissiId);
  let projectFolderId = '';
  try {
    const parents = DriveApp.getFileById(zissiId).getParents();
    if (parents.hasNext()) projectFolderId = parents.next().getId();
  } catch (e) {}
  return {
    duplicate: false,
    zissiId: zissiId,
    zissiName: zissiSs.getName(),
    zissiUrl: zissiSs.getUrl(),
    projectFolderId: projectFolderId,
    extracted: _CaseList_extractZissiMetadata(zissiSs)
  };
}

function _CaseList_extractSheetId(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (!s) return '';
  // 既に純 ID の形 (44文字英数記号) ならそのまま
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  // URL なら /d/<id>/ パターンを取り出す
  const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // open?id=<id> パターン
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return '';
}

function _CaseList_findByZissiId(sheet, zissiId) {
  if (!zissiId || sheet.getLastRow() < 2) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][CASE_COL_ZISSI_ID - 1] || '') === zissiId) {
      return { caseId: String(data[i][0] || ''), rowIndex: i + 1 };
    }
  }
  return null;
}

function _CaseList_findByCaseId(sheet, caseId) {
  if (!caseId || sheet.getLastRow() < 2) return null;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  const needle = String(caseId).trim();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === needle) {
      return { duplicate: true, caseId: needle, rowIndex: i + 2 };
    }
  }
  return null;
}

function _CaseList_extractZissiMetadata(zissiSs) {
  // summary シートから D5=社名, D13=案件名, D19=開催日 を読む（無ければ空文字）
  const result = { clientName: '', caseName: '', startDate: '', endDate: '', source: {} };
  const summarySheet = zissiSs.getSheetByName('summary');
  if (summarySheet) {
    const v5 = summarySheet.getRange('D5').getValue();
    const v13 = summarySheet.getRange('D13').getValue();
    const v19 = summarySheet.getRange('D19').getValue();
    if (v5) { result.clientName = String(v5); result.source.clientName = 'summary!D5'; }
    if (v13) { result.caseName = String(v13); result.source.caseName = 'summary!D13'; }
    if (v19) {
      result.startDate = v19 instanceof Date
        ? Utilities.formatDate(v19, 'Asia/Tokyo', 'yyyy/MM/dd')
        : String(v19);
      result.source.startDate = 'summary!D19';
    }
  }
  // 企画!B30 にも開催日が入る運用 → fallback
  if (!result.startDate) {
    const kikaku = zissiSs.getSheetByName('企画');
    if (kikaku) {
      const v = kikaku.getRange('B30').getValue();
      if (v) {
        result.startDate = v instanceof Date
          ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd')
          : String(v);
        result.source.startDate = '企画!B30';
      }
    }
  }
  // sheet 名 から案件名フォールバック (例: "C-0001_案件名_実施計画書")
  if (!result.caseName) {
    const title = zissiSs.getName();
    const m = title.match(/^(?:[A-Za-z0-9_-]+_)?(.+?)(?:_実施計画書)?$/);
    if (m && m[1]) {
      result.caseName = m[1];
      result.source.caseName = 'spreadsheet.title';
    } else {
      result.caseName = title;
      result.source.caseName = 'spreadsheet.title';
    }
  }
  return result;
}

/**
 * 案件1件を案件一覧から削除（行ごと）。case Drive フォルダは残す（手動 trash）。
 */
function CaseList_deleteCase(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  sheet.deleteRow(c.rowIndex);
  return { deleted: true, caseId: caseId, deletedRow: c.rowIndex };
}

function CaseList_setPhase(caseId, phase) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  sheet.getRange(c.rowIndex, 7).setValue(phase);
  sheet.getRange(c.rowIndex, 10).setValue(new Date());
}

function CaseList_setZissiInfo(caseId, zissiId, projectFolderId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (zissiId) sheet.getRange(c.rowIndex, CASE_COL_ZISSI_ID).setValue(zissiId);
  if (projectFolderId) sheet.getRange(c.rowIndex, CASE_COL_PROJECT_FOLDER).setValue(projectFolderId);
  sheet.getRange(c.rowIndex, 10).setValue(new Date());
}

function CaseList_setMasterInfo(caseId, masterSsId, masterCol) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (masterSsId) sheet.getRange(c.rowIndex, CASE_COL_MASTER_SS).setValue(masterSsId);
  if (masterCol) sheet.getRange(c.rowIndex, CASE_COL_MASTER_COL).setValue(masterCol);
  sheet.getRange(c.rowIndex, 10).setValue(new Date());
}

function CaseList_touchUpdatedAt(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) return;
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  sheet.getRange(c.rowIndex, 10).setValue(new Date());
}

// -------- private --------

function _CaseList_nextId(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return 'C0001';
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues().flat();
  const nums = ids.map(id => parseInt(String(id).replace(/^C/, ''), 10) || 0);
  const next = Math.max(0, ...nums) + 1;
  return 'C' + String(next).padStart(4, '0');
}

function _CaseList_createCaseFolder(caseId, clientName, caseName) {
  const root = DriveApp.getFolderById(APP_ROOT_FOLDER_ID);
  let casesParent;
  const it = root.getFoldersByName('案件');
  if (it.hasNext()) casesParent = it.next();
  else casesParent = root.createFolder('案件');
  const folderName = caseId + ' ' + clientName + '_' + caseName;
  return casesParent.createFolder(folderName);
}
