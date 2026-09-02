function _healthEnsureJobTab_() {
  var ss = _taskSheetSpreadsheet_();
  var sheet = ss.getSheetByName(HEALTH_JOB_TAB_NAME_);
  if (!sheet) sheet = ss.insertSheet(HEALTH_JOB_TAB_NAME_);
  var lastColumn = sheet.getLastColumn();
  var headers = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  if (headers.join('\u0001') !== HEALTH_JOB_HEADERS_.join('\u0001')) {
    sheet.getRange(1, 1, 1, HEALTH_JOB_HEADERS_.length).setValues([HEALTH_JOB_HEADERS_]);
  }
  return sheet;
}

function upsertJob(args) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, status: 503, error: 'busy' };
  try {
    var sheet = _healthEnsureJobTab_();
    var lastRow = sheet.getLastRow();
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues() : [];
    var plan = healthPlanUpsertJob(headers, rows, args, new Date().toISOString());
    if (plan.action === 'insert') sheet.appendRow(plan.row);
    else sheet.getRange(plan.rowIndex + 2, 1, 1, plan.row.length).setValues([plan.row]);
    return { ok: true, action: plan.action, row: plan.rowIndex + 2 };
  } finally {
    lock.releaseLock();
  }
}

function _jobWatchDiscord_(webhook, alert) {
  if (!webhook) return { ok: false, error: 'JOBWATCH_DISCORD_WEBHOOK is not configured' };
  try {
    var response = UrlFetchApp.fetch(webhook, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'User-Agent': 'DiscordBot (https://github.com/orgiast, 1.0) JobWatch' },
      payload: JSON.stringify({ content: 'JobWatch異常: ' + alert.job + '\n' + alert.reason + '\nfinishedAt=' + (alert.finishedAt || '(なし)') + ' cycleMinutes=' + alert.cycleMinutes }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    return code >= 200 && code < 300
      ? { ok: true, code: code }
      : { ok: false, code: code, error: response.getContentText().slice(0, 500) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function _jobWatchTaskId_(job) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, job, Utilities.Charset.UTF_8);
  return 'jobwatch-' + bytes.slice(0, 8).map(function(value) { return ('0' + ((value + 256) % 256).toString(16)).slice(-2); }).join('');
}

function jobWatchRun() {
  var nowIso = new Date().toISOString();
  var sheet = _healthEnsureJobTab_();
  var lastRow = sheet.getLastRow();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getDisplayValues() : [];
  var scan = healthPlanScan(headers, rows, nowIso);
  var notifiedColumn = healthColumn(headers, '通知済み', true) + 1;
  var webhook = PropertiesService.getScriptProperties().getProperty('JOBWATCH_DISCORD_WEBHOOK');
  var failures = [];
  var alerted = 0;

  scan.alerts.forEach(function(alert) {
    var discord = _jobWatchDiscord_(webhook, alert);
    var task;
    try {
      task = upsertTask({
        taskId: _jobWatchTaskId_(alert.job),
        起票元: 'system',
        件名: 'JobWatch異常: ' + alert.job,
        次アクション: alert.reason,
        備考: JSON.stringify({ job: alert.job, finishedAt: alert.finishedAt, cycleMinutes: alert.cycleMinutes })
      });
    } catch (error) {
      task = { ok: false, error: error.message };
    }
    if (discord.ok && task && task.ok) {
      sheet.getRange(alert.rowIndex + 2, notifiedColumn).setValue(nowIso);
      alerted += 1;
    } else {
      if (!discord.ok) failures.push({ job: alert.job, step: 'discord', code: discord.code || null, error: discord.error });
      if (!task || !task.ok) failures.push({ job: alert.job, step: 'task', error: task && task.error ? task.error : 'unknown error' });
    }
  });

  try {
    var taskSheet = _taskSheetEnsureTab_();
    taskSheet.getRange(1, 1).setValue(healthSummaryLine(scan));
  } catch (error) {
    failures.push({ step: 'summary', error: error.message });
  }
  return { ok: true, checked: rows.length, alerted: alerted, failures: failures };
}

function installJobWatchTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === 'jobWatchRun';
  });
  if (!exists) ScriptApp.newTrigger('jobWatchRun').timeBased().everyHours(1).create();
  return { ok: true, created: !exists };
}
