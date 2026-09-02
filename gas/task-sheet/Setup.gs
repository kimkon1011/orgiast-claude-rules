const TASK_SHEET_TAB_NAME_ = 'タスク';
const TASK_SHEET_HEADERS_ = ['taskId', '起票元', '件名', '依頼元', '担当PC', '状態', '次アクション', '成果物リンク', '期限', '最終更新', '備考'];

// 初回の準備はこの関数だけを実行する（トークンは setTaskSheetToken で別途設定する）。
function setupOnce() {
  const sheet = _taskSheetEnsureTab_();
  installCommandQueue();
  console.log('task sheet read-back OK; tab=' + sheet.getName() + '; command queue installed');
  return { ok: true, tabName: sheet.getName(), headerCount: sheet.getLastColumn() };
}

// 共有シークレットは Claude 側で生成してここに流し込む。GAS から外へ出さない(戻り値もマスクする)。
function setTaskSheetToken(args) {
  const token = (args && typeof args.token === 'string' ? args.token : (typeof args === 'string' ? args : '')).trim();
  if (token.length < 32) throw new Error('token is too short');
  PropertiesService.getScriptProperties().setProperty('TASK_SHEET_TOKEN', token);
  return { ok: true, tokenLength: token.length };
}

// 設定の健全性確認用。秘匿値そのものは返さない。
function describeTaskSheetConfig() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TASK_SHEET_TOKEN') || '';
  return {
    cmdFolderId: props.getProperty('CMD_FOLDER_ID') || null,
    tokenSet: !!token,
    tokenLength: token.length
  };
}

function _taskSheetSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function _taskSheetEnsureTab_() {
  const ss = _taskSheetSpreadsheet_();
  let sheet = ss.getSheetByName(TASK_SHEET_TAB_NAME_);
  if (!sheet) sheet = ss.insertSheet(TASK_SHEET_TAB_NAME_);
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  if (headers.join('') !== TASK_SHEET_HEADERS_.join('')) {
    sheet.getRange(1, 1, 1, TASK_SHEET_HEADERS_.length).setValues([TASK_SHEET_HEADERS_]);
  }
  return sheet;
}
