const CMD_FOLDER_NAME_ = 'claude-fleet-status-cmds';

function _COMMANDS_() {
  return { upsertFleetStatus: upsertFleetStatus, setFleetToken: setFleetToken, describeFleetConfig: describeFleetConfig, describeExtensionAudit: describeExtensionAudit };
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
