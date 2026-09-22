/**
 * 案件ごとの確認シート（クライアント/主催会社への確認事項 + 回答）。
 *
 * 各案件の Drive フォルダ直下に「確認シート」という Spreadsheet を作る。
 * Phase1 生成中に Claude が判断保留した項目をここに積む運用。
 *
 * 列: A 確認ID  B フェーズ  C 確認カテゴリ  D 確認内容  E 回答  F ステータス  G 起票日時
 */

const CONFIRMATION_SHEET_HEADERS = [
  '確認ID', 'フェーズ', '確認カテゴリ', '確認内容', '回答', 'ステータス', '起票日時'
];

function ConfirmationSheet_appendItems(caseId, items, phase) {
  // items: [{ category, content }, ...]
  if (!items || items.length === 0) return 0;
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const ss = _ConfirmationSheet_open(c.folderId, c);
  const sheet = ss.getSheetByName('確認事項') || ss.getActiveSheet();
  const startId = sheet.getLastRow();
  const now = new Date();
  const rows = items.map((it, idx) => [
    'Q' + String(startId + idx).padStart(4, '0'),
    phase || c.phase,
    it.category || '',
    it.content || '',
    '',                 // 回答
    '未回答',
    now
  ]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, CONFIRMATION_SHEET_HEADERS.length)
    .setValues(rows);
  _ConfirmationSheet_recountUnresolved(caseId, sheet);
  return rows.length;
}

function ConfirmationSheet_getUnresolved(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) return [];
  const ss = _ConfirmationSheet_open(c.folderId, c);
  const sheet = ss.getSheetByName('確認事項');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][5] !== '回答済み') {
      out.push({
        id: data[i][0],
        phase: data[i][1],
        category: data[i][2],
        content: data[i][3]
      });
    }
  }
  return out;
}

function ConfirmationSheet_getUrl(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) return null;
  const folder = DriveApp.getFolderById(c.folderId);
  const it = folder.getFilesByName('確認シート');
  if (!it.hasNext()) return null;
  return it.next().getUrl();
}

// -------- private --------

function _ConfirmationSheet_open(folderId, caseInfo) {
  const folder = DriveApp.getFolderById(folderId);
  const it = folder.getFilesByName('確認シート');
  if (it.hasNext()) return SpreadsheetApp.openById(it.next().getId());
  // 新規作成
  const ss = SpreadsheetApp.create('確認シート');
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  const sh = ss.getActiveSheet();
  sh.setName('確認事項');
  sh.appendRow(CONFIRMATION_SHEET_HEADERS);
  sh.getRange(1, 1, 1, CONFIRMATION_SHEET_HEADERS.length)
    .setFontWeight('bold').setBackground('#fce5cd');
  sh.setFrozenRows(1);
  return ss;
}

function _ConfirmationSheet_recountUnresolved(caseId, sheet) {
  if (sheet.getLastRow() < 2) return;
  const statuses = sheet.getRange(2, 6, sheet.getLastRow() - 1, 1).getValues().flat();
  const unresolved = statuses.filter(s => s !== '回答済み').length;
  const list = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  const c = CaseList_getById(caseId);
  if (c) list.getRange(c.rowIndex, 8).setValue(unresolved);
}
