/**
 * weekly-photo-list CommandQueue
 *
 * コマンドキュー方式（rules/gas.md §2）に従い、
 * Drive フォルダ経由で外部（Claude Code）から関数を呼び出せるようにする。
 */

function _COMMANDS_() {
  return {
    setPhotoFolder: setPhotoFolder,
    setRecipients: setRecipients,
    setSendTime: setSendTime,
    describeConfig: describeConfig,
    sendNow: sendNow,
    installWeeklyTrigger: installWeeklyTrigger,
    uninstallTriggers: uninstallTriggers
  };
}

/**
 * 監視対象の Google Drive フォルダ ID を設定する。
 * @param {{folderId: string}} args
 */
function setPhotoFolder(args) {
  var id = args && typeof args.folderId === 'string' ? args.folderId.trim() : '';
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) throw new Error('folderId が不正です: ' + id);
  // 存在確認
  var folder = DriveApp.getFolderById(id);
  PropertiesService.getScriptProperties().setProperty('PHOTO_FOLDER_ID', id);
  return { ok: true, folderName: folder.getName(), fileCount: folder.getFiles().hasNext() ? '1件以上' : '空' };
}

/**
 * 送信先メールアドレスを設定する（カンマ区切り）。
 * @param {{emails: string}} args
 */
function setRecipients(args) {
  var emails = args && typeof args.emails === 'string' ? args.emails.trim() : '';
  if (!emails) throw new Error('emails が空です');
  var parts = emails.split(',');
  for (var i = 0; i < parts.length; i++) {
    var e = parts[i].trim();
    if (e && !/^[^@]+@[^@]+\.[^@]+$/.test(e)) throw new Error('不正なメールアドレス: ' + e);
  }
  PropertiesService.getScriptProperties().setProperty('RECIPIENT_EMAILS', emails);
  return { ok: true, recipientCount: parts.length };
}

/**
 * 送信時刻を設定する（HH:mm 形式）。
 * @param {{time: string}} args
 */
function setSendTime(args) {
  var t = args && typeof args.time === 'string' ? args.time.trim() : '';
  if (!/^\d{2}:\d{2}$/.test(t)) throw new Error('時刻形式が不正です (HH:mm): ' + t);
  PropertiesService.getScriptProperties().setProperty('SEND_TIME', t);
  return { ok: true, sendTime: t };
}

/**
 * 現在の設定を取得する（秘匿値はマスク）。
 */
function describeConfig() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('PHOTO_FOLDER_ID') || '';
  var emails = props.getProperty('RECIPIENT_EMAILS') || '';
  return {
    photoFolderId: folderId || '(未設定)',
    photoFolderName: folderId ? DriveApp.getFolderById(folderId).getName() : '(N/A)',
    recipients: emails || '(未設定)',
    recipientCount: emails ? emails.split(',').length : 0,
    sendTime: props.getProperty('SEND_TIME') || '08:00',
    cmdFolderId: props.getProperty('CMD_FOLDER_ID') || '(未設定)',
    triggerCount: ScriptApp.getProjectTriggers().length
  };
}

/**
 * 即座に写真リストを生成して送信する（テスト用）。
 */
function sendNow() {
  return generateAndSendPhotoList();
}

/**
 * 毎週月曜朝に sendNow を実行するトリガーを設置する。
 * 既存の同種トリガーは削除してから作り直す。
 */
function installWeeklyTrigger() {
  var props = PropertiesService.getScriptProperties();
  var time = props.getProperty('SEND_TIME') || '08:00';
  var parts = time.split(':');
  var hour = parseInt(parts[0], 10);
  var minute = parseInt(parts[1], 10);

  // 既存の weeklyPhotoListSend トリガーを削除
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'weeklyPhotoListSend'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  // 毎週月曜に設定
  ScriptApp.newTrigger('weeklyPhotoListSend')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(hour)
    .nearMinute(minute)
    .create();

  var count = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'weeklyPhotoListSend'; }).length;
  return { ok: true, hour: hour, minute: minute, triggerCount: count };
}

/**
 * すべてのトリガーを削除する。
 */
function uninstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });
  return { ok: true, remainingTriggers: ScriptApp.getProjectTriggers().length };
}

// ---- CommandQueue インフラ ----

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

  // このハンドラだけを入れ直す
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === TRIGGER_HANDLER_; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(TRIGGER_HANDLER_).timeBased().everyMinutes(1).create();
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