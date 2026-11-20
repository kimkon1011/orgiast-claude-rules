/**
 * ai-sales-sync CommandQueue
 *
 * コマンドキュー方式（rules/gas.md §2）に従い、
 * Drive フォルダ経由で外部（Claude Code）から関数を呼び出せるようにする。
 */

function _COMMANDS_() {
  return {
    setSlackWebhook: setSlackWebhook,
    setSheetConfig: setSheetConfig,
    setTargetStatuses: setTargetStatuses,
    setDefaultDays: setDefaultDays,
    setSendTime: setSendTime,
    describeConfig: describeConfig,
    sendReportNow: sendReportNow,
    installDailyTrigger: installDailyTrigger,
    uninstallTriggers: uninstallTriggers
  };
}

/**
 * Slack Incoming Webhook URL を設定する。
 * @param {{url: string}} args
 */
function setSlackWebhook(args) {
  var url = args && typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('URL が空です');
  if (url.indexOf('https://hooks.slack.com/services/') !== 0) {
    throw new Error('Slack Webhook URL の形式が不正です: ' + url.substring(0, 50) + '...');
  }
  PropertiesService.getScriptProperties().setProperty('SLACK_WEBHOOK_URL', url);
  return { ok: true, webhookSet: true };
}

/**
 * シート設定を更新する。
 * @param {{sheetName?: string, dateCol?: number, statusCol?: number, salesCol?: number}} args
 */
function setSheetConfig(args) {
  if (!args) throw new Error('args がありません');
  var props = PropertiesService.getScriptProperties();

  if (typeof args.sheetName === 'string' && args.sheetName.trim()) {
    props.setProperty('SHEET_NAME', args.sheetName.trim());
  }
  if (typeof args.dateCol === 'number') {
    if (args.dateCol < 1) throw new Error('dateCol は 1 以上である必要があります');
    props.setProperty('DATE_COLUMN_INDEX', String(args.dateCol));
  }
  if (typeof args.statusCol === 'number') {
    if (args.statusCol < 1) throw new Error('statusCol は 1 以上である必要があります');
    props.setProperty('STATUS_COLUMN_INDEX', String(args.statusCol));
  }
  if (typeof args.salesCol === 'number') {
    if (args.salesCol < 1) throw new Error('salesCol は 1 以上である必要があります');
    props.setProperty('SALES_COLUMN_INDEX', String(args.salesCol));
  }

  return {
    ok: true,
    sheetName: props.getProperty('SHEET_NAME'),
    dateCol: parseInt(props.getProperty('DATE_COLUMN_INDEX'), 10),
    statusCol: parseInt(props.getProperty('STATUS_COLUMN_INDEX'), 10),
    salesCol: parseInt(props.getProperty('SALES_COLUMN_INDEX'), 10)
  };
}

/**
 * 集計対象ステータスを設定する（カンマ区切り）。
 * @param {{statuses: string}} args
 */
function setTargetStatuses(args) {
  var statuses = args && typeof args.statuses === 'string' ? args.statuses.trim() : '';
  if (!statuses) throw new Error('statuses が空です');
  var parts = statuses.split(',');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i].trim()) throw new Error('空のステータスがあります: ' + statuses);
  }
  PropertiesService.getScriptProperties().setProperty('TARGET_STATUSES', statuses);
  return { ok: true, targetStatuses: statuses, statusCount: parts.length };
}

/**
 * デフォルトの集計日数を設定する。
 * @param {{days: number}} args
 */
function setDefaultDays(args) {
  var days = args && typeof args.days === 'number' ? args.days : NaN;
  if (!isFinite(days) || days < 1 || days > 365) {
    throw new Error('days は 1〜365 の整数である必要があります');
  }
  PropertiesService.getScriptProperties().setProperty('DEFAULT_DAYS', String(days));
  return { ok: true, defaultDays: days };
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
  return {
    sheetName: props.getProperty('SHEET_NAME') || '(未設定)',
    dateCol: parseInt(props.getProperty('DATE_COLUMN_INDEX'), 10) || 7,
    statusCol: parseInt(props.getProperty('STATUS_COLUMN_INDEX'), 10) || 3,
    salesCol: parseInt(props.getProperty('SALES_COLUMN_INDEX'), 10) || 19,
    targetStatuses: props.getProperty('TARGET_STATUSES') || '(未設定)',
    defaultDays: parseInt(props.getProperty('DEFAULT_DAYS'), 10) || 7,
    sendTime: props.getProperty('SEND_TIME') || '09:00',
    webhookSet: !!(props.getProperty('SLACK_WEBHOOK_URL')),
    cmdFolderId: props.getProperty('CMD_FOLDER_ID') || '(未設定)',
    triggerCount: ScriptApp.getProjectTriggers().length
  };
}

/**
 * 即座に売上レポートを生成して Slack に投稿する（テスト用／手動実行）。
 */
function sendReportNow() {
  return generateAndSendSalesReport();
}

/**
 * 毎朝 9:00 に売上レポートを送信するトリガーを設置する。
 * 既存の同種トリガーは削除してから作り直す。
 */
function installDailyTrigger() {
  var props = PropertiesService.getScriptProperties();
  var time = props.getProperty('SEND_TIME') || '09:00';
  var parts = time.split(':');
  var hour = parseInt(parts[0], 10);
  var minute = parseInt(parts[1], 10);

  // 既存の dailySalesReport トリガーを削除
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'dailySalesReport'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  // 毎日指定時刻に設定
  ScriptApp.newTrigger('dailySalesReport')
    .timeBased()
    .everyDays(1)
    .atHour(hour)
    .nearMinute(minute)
    .create();

  var count = ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'dailySalesReport'; }).length;
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