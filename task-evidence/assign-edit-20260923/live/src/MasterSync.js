/**
 * master タスク進捗管理表から、各案件のタスク進捗 (残/済/不要) を読み取り
 * 案件一覧シートに新規列で書き出す。
 *
 * 案件一覧の追加列:
 *   O 残タスク  P 済タスク  Q 不要タスク  R 進捗率(%)  S master同期日時
 */

const _MASTER_SYNC_PROGRESS_HEADERS = ['残タスク', '済タスク', '不要タスク', '進捗率(%)', 'master同期日時'];
const _MASTER_SYNC_BASE_HEADERS = 14; // 案件一覧 K-N まで = 14 列

function MasterSync_pullProgress() {
  const appSs = SpreadsheetApp.getActive();
  const caseSheet = appSs.getSheetByName(CASE_LIST_SHEET_NAME);
  if (!caseSheet) throw new Error('案件一覧シートがありません');

  // ヘッダー拡張（無ければ O-S に追加）
  const currentCols = caseSheet.getLastColumn();
  const fullHeaderCount = _MASTER_SYNC_BASE_HEADERS + _MASTER_SYNC_PROGRESS_HEADERS.length;
  if (currentCols < fullHeaderCount) {
    const missing = _MASTER_SYNC_PROGRESS_HEADERS.slice(Math.max(0, currentCols - _MASTER_SYNC_BASE_HEADERS));
    if (missing.length > 0) {
      caseSheet.getRange(1, currentCols + 1, 1, missing.length).setValues([missing])
        .setFontWeight('bold').setBackground('#cfe2f3');
    }
  }

  const lastRow = caseSheet.getLastRow();
  if (lastRow < 2) return { updated: 0, skipped: 0, totalRows: 0 };

  const data = caseSheet.getDataRange().getValues();
  const masterSsCache = {}; // masterSsId → sheet (lazy open)
  let updated = 0, skipped = 0;
  const now = new Date();

  for (let i = 1; i < data.length; i++) {
    const caseId = String(data[i][0] || '').trim();
    const masterSsId = String(data[i][CASE_COL_MASTER_SS - 1] || '').trim();
    const masterCol = Number(data[i][CASE_COL_MASTER_COL - 1]) || 0;
    if (!caseId || !masterSsId || !masterCol) { skipped++; continue; }

    let masterSheet = masterSsCache[masterSsId];
    if (!masterSheet) {
      try {
        const ss = SpreadsheetApp.openById(masterSsId);
        masterSheet = ss.getSheetByName('task');
        if (!masterSheet) { skipped++; continue; }
        masterSsCache[masterSsId] = masterSheet;
      } catch (e) { skipped++; continue; }
    }
    // master の row 11 = 残/済/不要 (各案件 3列ブロック: masterCol=残, +1=済, +2=不要)
    try {
      const vals = masterSheet.getRange(11, masterCol, 1, 3).getValues()[0];
      const remain = Number(vals[0]) || 0;
      const done = Number(vals[1]) || 0;
      const unnecessary = Number(vals[2]) || 0;
      const total = remain + done + unnecessary;
      const progressPct = total > 0 ? Math.round(100 * done / total) : 0;
      const row = i + 1;
      caseSheet.getRange(row, _MASTER_SYNC_BASE_HEADERS + 1, 1, 5).setValues([[
        remain, done, unnecessary, progressPct, now
      ]]);
      updated++;
    } catch (e) {
      skipped++;
    }
  }

  return { updated: updated, skipped: skipped, totalRows: data.length - 1 };
}

/**
 * 毎日 深夜 3:15 (JST) に MasterSync_pullProgress を自動実行する trigger 登録。
 * bulk import (3:00) の直後に動かす想定。
 * 既存トリガーがあれば削除してから再作成（時刻変更にも対応）。
 */
function MasterSync_setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'MasterSync_pullProgress') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger('MasterSync_pullProgress')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .nearMinute(15)
    .create();
  return { removedOld: removed, created: true, hourJst: 3, minuteJst: 15 };
}
