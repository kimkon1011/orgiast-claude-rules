const CMD_FOLDER_NAME_ = 'claude-fleet-status-cmds';

function _COMMANDS_() {
  return { upsertFleetStatus: upsertFleetStatus, clearFleetMachineColumns: clearFleetMachineColumns, setFleetToken: setFleetToken, describeFleetConfig: describeFleetConfig, describeExtensionAudit: describeExtensionAudit, setPcInventorySheetId: setPcInventorySheetId, describePcInventoryHeaders: describePcInventoryHeaders };
}

// PC管理表の **1行目(見出し)だけ** を返す。本文(パスワード列を含む)は返さない。
// 列名の実表記が分からないと書き込み先を解決できないが、本文を読むと秘匿値がログに載るため。
function describePcInventoryHeaders() {
  var sheet = _pcInventorySheet_();
  var found = _pcFindHeaderRow_(sheet);
  return { sheetName: sheet.getName(), headerRow: found.row, headers: found.headers };
}

// PC管理表(備品管理表関係データ保管用)の spreadsheet ID を設定する。
// タブ名キャッシュは ID を変えたら無効になるので同時に消す。
function setPcInventorySheetId(args) {
  const id = args && typeof args.sheetId === 'string' ? args.sheetId.trim() : '';
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error('sheetId looks invalid');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('PC_INVENTORY_SHEET_ID', id);
  props.deleteProperty('PC_INVENTORY_TAB_NAME');
  const sheet = SpreadsheetApp.openById(id).getSheetByName('PC管理表');
  if (!sheet) throw new Error('PC管理表 tab not found in the given spreadsheet');
  return { ok: true, sheetName: sheet.getName(), headerCount: sheet.getLastColumn() };
}

// 共有シークレットは Claude 側で生成してここに流し込む。GAS から外へ出さない(戻り値もマスクする)。
function setFleetToken(args) {
  const token = args && typeof args.token === 'string' ? args.token.trim() : '';
  if (token.length < 32) throw new Error('token is too short');
  PropertiesService.getScriptProperties().setProperty('FLEET_TOKEN', token);
  return { ok: true, tokenLength: token.length };
}

// 設定の健全性確認用。秘匿値そのものは返さない。
function describeFleetConfig() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('FLEET_TOKEN') || '';
  return {
    sheetId: props.getProperty('SHEET_ID') || null,
    sheetTabName: props.getProperty('SHEET_TAB_NAME') || null,
    cmdFolderId: props.getProperty('CMD_FOLDER_ID') || null,
    tokenSet: !!token,
    tokenLength: token.length
  };
}

function installCommandQueue() {
  const props = PropertiesService.getScriptProperties();
  let folder;
  const currentId = props.getProperty('CMD_FOLDER_ID');
  if (currentId) {
    try { folder = DriveApp.getFolderById(currentId); } catch (e) {}
  }
  if (!folder) {
    const found = DriveApp.getFoldersByName(CMD_FOLDER_NAME_);
    folder = found.hasNext() ? found.next() : DriveApp.createFolder(CMD_FOLDER_NAME_);
    props.setProperty('CMD_FOLDER_ID', folder.getId());
  }

  // このハンドラだけを入れ直す。他のトリガーは削除しない。
  ScriptApp.getProjectTriggers()
    .filter(function(trigger) { return trigger.getHandlerFunction() === 'processCommandQueue'; })
    .forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('processCommandQueue').timeBased().everyMinutes(1).create();
}

function processCommandQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('another invocation is running, skip');
    return;
  }
  try {
    const folderId = PropertiesService.getScriptProperties().getProperty('CMD_FOLDER_ID');
    if (!folderId) throw new Error('CMD_FOLDER_ID is not configured');
    const files = DriveApp.getFolderById(folderId).getFiles();
    const commands = _COMMANDS_();
    while (files.hasNext()) {
      const file = files.next();
      if (file.getName().indexOf('cmd_') !== 0) continue;
      const name = file.getName();
      const raw = file.getBlob().getDataAsString();
      // payload 読込直後に必ず trash する(再実行・二重処理を防ぐ)。
      try { file.setTrashed(true); } catch (e) {}
      const resultName = 'result_' + name.replace(/^cmd_/, '').replace(/\.json$/, '') + '.txt';
      let outcome;
      try {
        const payload = JSON.parse(raw);
        const handler = commands[payload.command];
        if (!handler) throw new Error('command is not allowed: ' + payload.command);
        const value = handler(payload.args || payload.payload || {});
        outcome = { ok: true, command: payload.command, result: value === undefined ? null : value, at: new Date().toISOString() };
      } catch (e) {
        outcome = { ok: false, error: e.message, at: new Date().toISOString() };
        console.error('command failed: ' + e.message);
      }
      try { DriveApp.getFolderById(folderId).createFile(resultName, JSON.stringify(outcome), MimeType.PLAIN_TEXT); } catch (e) { console.error('result write failed: ' + e.message); }
    }
  } finally {
    lock.releaseLock();
  }
}
