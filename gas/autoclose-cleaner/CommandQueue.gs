/**
 * AutoClose Cleaner — Command Queue
 *
 * rules/gas.md コマンドキュー方式の実装。
 * Claude からの Drive コマンドを受け取りホワイトリスト関数のみ実行。
 */

var CMD_FOLDER_NAME_ = 'claude-autoclose-cleaner-cmds';

function _COMMANDS_() {
  return {
    runArchive: runArchive,
    nightlyArchive: nightlyArchive,
    installNightlyTrigger: installNightlyTrigger,
    describeConfig: describeConfig,
    setupOnce: setupOnce
  };
}

function installCommandQueue() {
  var props = PropertiesService.getScriptProperties();
  var folder;
  var currentId = props.getProperty('CMD_FOLDER_ID');
  if (currentId) {
    try { folder = DriveApp.getFolderById(currentId); } catch (e) {}
  }
  if (!folder) {
    var found = DriveApp.getFoldersByName(CMD_FOLDER_NAME_);
    folder = found.hasNext() ? found.next() : DriveApp.createFolder(CMD_FOLDER_NAME_);
    props.setProperty('CMD_FOLDER_ID', folder.getId());
  }

  // このハンドラだけを入れ直す。他のトリガーは削除しない。
  ScriptApp.getProjectTriggers()
    .filter(function (trigger) { return trigger.getHandlerFunction() === 'processCommandQueue'; })
    .forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('processCommandQueue').timeBased().everyMinutes(1).create();
}

function processCommandQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('another invocation is running, skip');
    return;
  }
  try {
    var folderId = PropertiesService.getScriptProperties().getProperty('CMD_FOLDER_ID');
    if (!folderId) throw new Error('CMD_FOLDER_ID is not configured');
    var files = DriveApp.getFolderById(folderId).getFiles();
    var commands = _COMMANDS_();
    while (files.hasNext()) {
      var file = files.next();
      if (file.getName().indexOf('cmd_') !== 0) continue;
      var name = file.getName();
      var raw = file.getBlob().getDataAsString();
      // payload 読込直後に必ず trash する（再実行・二重処理を防ぐ）
      try { file.setTrashed(true); } catch (e) {}
      var resultName = 'result_' + name.replace(/^cmd_/, '').replace(/\.json$/, '') + '.txt';
      var outcome;
      try {
        var payload = JSON.parse(raw);
        var handler = commands[payload.command];
        if (!handler) throw new Error('command is not allowed: ' + payload.command);
        var value = handler(payload.args || payload.payload || {});
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