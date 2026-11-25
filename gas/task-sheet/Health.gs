const HEALTH_JOB_TAB_NAME_ = 'ジョブ';
const HEALTH_JOB_HEADERS_ = ['job', 'cycleMinutes', 'startedAt', 'finishedAt', 'ok', 'summary', '最終更新', '通知済み'];

function healthColumn(headers, name, required) {
  var index = headers.indexOf(name);
  if (required && index < 0) throw new Error('required header not found: ' + name);
  return index;
}

function healthPlanUpsertJob(headers, rows, args, nowIso) {
  args = args || {};
  var job = typeof args.job === 'string' ? args.job.trim() : '';
  if (!job) throw new Error('job is required');

  var jobColumn = healthColumn(headers, 'job', true);
  var rowIndex = rows.findIndex(function(row) {
    return String(row[jobColumn] == null ? '' : row[jobColumn]) === job;
  });
  var existing = rowIndex >= 0 ? rows[rowIndex] : null;
  var values = {};
  headers.forEach(function(header, index) {
    values[header] = existing ? existing[index] : '';
  });
  values.job = job;
  ['cycleMinutes', 'startedAt', 'finishedAt', 'ok', 'summary'].forEach(function(field) {
    if (Object.prototype.hasOwnProperty.call(args, field)) values[field] = args[field];
  });
  values['最終更新'] = nowIso;

  var reportUpdated = ['finishedAt', 'ok', 'summary'].some(function(field) {
    return Object.prototype.hasOwnProperty.call(args, field);
  });
  if (reportUpdated) values['通知済み'] = '';

  return {
    rowIndex: rowIndex < 0 ? rows.length : rowIndex,
    row: headers.map(function(header) { return values[header]; }),
    action: rowIndex < 0 ? 'insert' : 'update'
  };
}

function healthPlanScan(headers, rows, nowIso) {
  var nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error('nowIso is invalid');
  var columns = {
    job: healthColumn(headers, 'job', true),
    cycleMinutes: healthColumn(headers, 'cycleMinutes', true),
    finishedAt: healthColumn(headers, 'finishedAt', true),
    ok: healthColumn(headers, 'ok', true),
    notified: healthColumn(headers, '通知済み', true)
  };
  var alerts = [];
  rows.forEach(function(row, rowIndex) {
    if (String(row[columns.notified] == null ? '' : row[columns.notified]).trim()) return;
    var reasons = [];
    var ok = row[columns.ok];
    if (ok === false || ok === 'false') reasons.push('ジョブが ok=false を申告');

    var finishedAt = String(row[columns.finishedAt] == null ? '' : row[columns.finishedAt]).trim();
    var cycleRaw = row[columns.cycleMinutes];
    var cycleMinutes = typeof cycleRaw === 'number'
      ? cycleRaw
      : (typeof cycleRaw === 'string' && cycleRaw.trim() !== '' ? Number(cycleRaw) : NaN);
    if (finishedAt === '') {
      reasons.push('終了申告がありません');
    } else if (Number.isFinite(cycleMinutes)) {
      var finishedMs = Date.parse(finishedAt);
      if (Number.isFinite(finishedMs) && nowMs - finishedMs > 2 * cycleMinutes * 60000) {
        reasons.push('終了申告が周期の2倍を超えて更新されていません');
      }
    }
    if (reasons.length) {
      alerts.push({
        rowIndex: rowIndex,
        job: String(row[columns.job] == null ? '' : row[columns.job]),
        reason: reasons.join(' / '),
        finishedAt: finishedAt,
        cycleMinutes: row[columns.cycleMinutes]
      });
    }
  });
  return { alerts: alerts, summary: { staleCount: alerts.length, checkedAt: nowIso } };
}

function healthSummaryLine(scanResult) {
  return '健全性: 未申告ジョブ ' + scanResult.summary.staleCount + '件 / 最終見張り ' + scanResult.summary.checkedAt;
}
