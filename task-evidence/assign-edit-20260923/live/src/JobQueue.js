/**
 * 案件別実行パネルのジョブキュー。
 * 純関数は末尾で CommonJS export し、GAS API なしで node:test から検証する。
 */

const _JOBQUEUE_MASTER_SS = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
const _JOBQUEUE_SHEET = '_ジョブキュー';
const _JOBQUEUE_HEADERS = [
  'jobId', '受付日時', '依頼者', 'パネルシート名', 'パネル行', 'イベントラベル', '機能ラベル',
  'command', 'argsJSON', 'noCase', '状態', '開始日時', '終了日時', '結果URL', 'メッセージ', 'ワーカー'
];
var _JOBQUEUE_CTX = null;

function JobQueue_makePanelSheetName(eventLabel, blockStart, existingNames) {
  var parts = String(eventLabel || '').split(' / ');
  var client = String(parts.shift() || '').replace(/[\[\]*?:\/\\]/g, '').trim().slice(0, 12);
  var eventName = String(parts.join(' / ') || client).replace(/[\[\]*?:\/\\]/g, '').trim().slice(0, 20);
  if (parts.length === 0) client = '';
  var base = ('🚀' + client + (client && eventName ? ' ' : '') + eventName).slice(0, 99);
  if (!base) base = '🚀案件';
  var names = existingNames || [];
  if (names.indexOf(base) < 0) return base;
  var suffix = ' #' + String(blockStart || '');
  return base.slice(0, 99 - suffix.length) + suffix;
}

function JobQueue_selectCandidate(waiting, running) {
  var ordered = (waiting || []).slice().sort(function (a, b) { return Number(a.receivedAt) - Number(b.receivedAt); });
  var activePanels = {};
  var activeRequesters = {};
  (running || []).forEach(function (job) {
    activePanels[String(job.panelSheetName || '')] = true;
    if (String(job.requester || '')) activeRequesters[String(job.requester)] = true;
  });
  var fair = ordered.filter(function (job) {
    return !activePanels[String(job.panelSheetName || '')] &&
      (!String(job.requester || '') || !activeRequesters[String(job.requester)]);
  });
  if (fair.length) return fair[0];
  var fallback = ordered.filter(function (job) { return !activePanels[String(job.panelSheetName || '')]; });
  return fallback.length ? fallback[0] : null;
}

function JobQueue_isStale(startedAt, now) {
  if (!startedAt) return false;
  return Number(now) - Number(startedAt) >= 15 * 60 * 1000;
}

function JobQueue_countAhead(jobs, target) {
  return (jobs || []).filter(function (job) {
    return String(job.status) === '待機' && Number(job.receivedAt) < Number(target.receivedAt);
  }).length;
}

function JobQueue_findDuplicate(jobs, panelSheetName, row, nowMs) {
  // row<=0 はシステムジョブ (パネル生成・インデックス再構築など)。冪等なので重複を許す
  if (!(Number(row) > 0)) return null;
  var cutoff = Number(nowMs == null ? Date.now() : nowMs) - 30 * 60 * 1000;
  var hit = (jobs || []).filter(function (job) {
    return String(job.panelSheetName) === String(panelSheetName) && Number(job.row) === Number(row) &&
      (String(job.status) === '待機' || String(job.status) === '実行中') && Number(job.receivedAt) >= cutoff;
  })[0];
  return hit || null;
}

function JobQueue_ensureSheet() {
  var ms = SpreadsheetApp.openById(_JOBQUEUE_MASTER_SS);
  var sheet = ms.getSheetByName(_JOBQUEUE_SHEET);
  if (!sheet) sheet = ms.insertSheet(_JOBQUEUE_SHEET);
  sheet.getRange(1, 1, 1, _JOBQUEUE_HEADERS.length).setValues([_JOBQUEUE_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('B:B').setNumberFormat('yyyy/MM/dd HH:mm:ss');
  sheet.getRange('L:M').setNumberFormat('yyyy/MM/dd HH:mm:ss');
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

function _JobQueue_rows(sheet) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 16).getValues().map(function (r, i) {
    return {
      sheetRow: i + 2, jobId: String(r[0] || ''), receivedAt: r[1] instanceof Date ? r[1].getTime() : new Date(r[1]).getTime(),
      requester: String(r[2] || ''), panelSheetName: String(r[3] || ''), row: Number(r[4]) || 0,
      eventLabel: String(r[5] || ''), featureLabel: String(r[6] || ''), command: String(r[7] || ''),
      argsJSON: String(r[8] || '[]'), noCase: String(r[9] || '') === '1', status: String(r[10] || ''),
      startedAt: r[11] instanceof Date ? r[11].getTime() : (r[11] ? new Date(r[11]).getTime() : 0), raw: r
    };
  });
}

/** jobId から現在の行番号を引き直す (行削除による番号ズレ対策)。見つからなければ 0。 */
function _JobQueue_rowByJobId(sheet, jobId, hintRow) {
  if (!jobId) return hintRow || 0;
  try {
    if (hintRow && String(sheet.getRange(hintRow, 1).getValue()) === String(jobId)) return hintRow;
  } catch (e) {}
  var rows = _JobQueue_rows(sheet).filter(function (j) { return j.jobId === String(jobId); });
  return rows.length ? rows[0].sheetRow : 0;
}

function JobQueue_enqueue(job) {
  // script lock は processCommandQueue (Claude 側の操作経路) が保持するので使わない。
  // 同じロックを奪うと cmd キューが毎分 skip して操作不能になる (2026-08-21 実際に詰まった)
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error('ジョブキューが混雑しています。少し待ってもう一度押してください');
  try {
    var sheet = JobQueue_ensureSheet();
    var rows = _JobQueue_rows(sheet);
    var duplicate = JobQueue_findDuplicate(rows, job.panelSheetName, job.row, Date.now());
    if (duplicate) {
      return { duplicate: true, requester: duplicate.requester, since: duplicate.raw[1], jobId: duplicate.jobId };
    }
    var now = new Date();
    var id = 'J' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMddHHmmss') + '_' + ('00' + Math.floor(Math.random() * 1000)).slice(-3);
    sheet.appendRow([
      id, now, String(job.requester || ''), String(job.panelSheetName || ''), Number(job.row) || 0,
      String(job.eventLabel || ''), String(job.featureLabel || ''), String(job.command || ''),
      JSON.stringify(job.args || []), job.noCase ? '1' : '', '待機', '', '', '', '', ''
    ]);
    return { duplicate: false, jobId: id };
  } finally {
    lock.releaseLock();
  }
}

function _JobQueue_loadResolution(ms) {
  var task = ms.getSheetByName('task');
  var blockInfo = {};
  var labelToBlock = {};
  if (task) {
    var lastCol = task.getLastColumn();
    var width = Math.max(3, lastCol - 13 + 1);
    var clients = task.getRange(1, 13, 1, width).getValues()[0];
    var events = task.getRange(2, 13, 1, width).getValues()[0];
    for (var bs = 13; bs + 2 <= lastCol; bs += 3) {
      var idx = bs - 13;
      var ev = String(events[idx] || '').replace(/\s+/g, ' ').trim();
      var cl = String(clients[idx] || '').replace(/\s+/g, ' ').trim();
      if (!ev) continue;
      var label = (cl ? cl + ' / ' : '') + ev.slice(0, 40);
      labelToBlock[label] = bs;
      blockInfo[bs] = { client: cl, event: ev };
    }
  }
  var appSheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  var data = appSheet ? appSheet.getDataRange().getValues() : [];
  var rows = [];
  var byBlock = {};
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][12]) !== _JOBQUEUE_MASTER_SS) continue;
    var item = { rowNum: i + 1, caseId: String(data[i][0]), client: String(data[i][1] || ''), caseName: String(data[i][2] || ''), masterCol: Number(data[i][13]) || 0 };
    rows.push(item);
    byBlock[item.masterCol] = item.caseId;
  }
  return { task: task, blockInfo: blockInfo, labelToBlock: labelToBlock, appSheet: appSheet, appRows: rows, caseIdByBlock: byBlock };
}

function _JobQueue_resolveCase(eventLabel, resolution) {
  var blockStart = resolution.labelToBlock[String(eventLabel || '')];
  if (!blockStart) return { caseId: '', blockStart: 0 };
  var info = resolution.blockInfo[blockStart];
  var norm = function (x) { return String(x || '').normalize('NFC').toLowerCase().replace(/様$/, '').replace(/[\s　]+/g, '').replace(/＆/g, '&'); };
  if (info) {
    var clientN = norm(info.client);
    var eventN = norm(info.event).slice(0, 25);
    var cands = resolution.appRows.filter(function (r) { return norm(r.client) === clientN && (!eventN || norm(r.caseName).indexOf(eventN) === 0); });
    var hit = null;
    if (cands.length === 1) hit = cands[0];
    else if (cands.length > 1) hit = cands.filter(function (r) { return r.masterCol === blockStart; })[0] || cands.sort(function (a, b) { return Math.abs(a.masterCol - blockStart) - Math.abs(b.masterCol - blockStart); })[0];
    if (hit) {
      if (hit.masterCol !== blockStart && resolution.appSheet) {
        try { resolution.appSheet.getRange(hit.rowNum, 14).setValue(blockStart); } catch (e) {}
      }
      return { caseId: hit.caseId, blockStart: blockStart };
    }
  }
  return { caseId: resolution.caseIdByBlock[blockStart] || '', blockStart: blockStart };
}

function _JobQueue_writePanel(ms, job, resultValue, nowStr, status, links, opts) {
  var panel = ms.getSheetByName(job.panelSheetName);
  if (!panel || !job.row) return;
  // links は配列。生成物が複数あるコマンド (実施計画書 + 提案書 等) は1セルに全部並べる。
  // 「Claude生成物 シートを探すのが大変」を無くすため、結果セルを必ずクリック可能にする。
  var list = Array.isArray(links) ? links : (links ? [{ label: '📄 開く', url: String(links) }] : []);
  var layout = PanelLinks_writePanelOutcome(panel, job.row, resultValue, nowStr, status, list);
  var successful = String(status || '').indexOf('❌') !== 0 && String(status || '').indexOf('エラー') < 0;
  var resolved = null;
  if (layout.isV3 && successful) {
    var featureKey = String(panel.getRange(job.row, 10).getValue() || '');
    resolved = _JobQueue_resolveCase(job.eventLabel, _JobQueue_loadResolution(ms));
    if (featureKey && resolved.caseId) {
      PanelProgress_upsert(resolved.caseId, job.eventLabel, featureKey, true, 'auto', '');
      panel.getRange(job.row, 2).setValue(true);
    }
  }
  // 未完了リストの再構築は SS を3枚読んでパネル末尾を書き直すので数十秒かかる。
  // claim の document lock 内で回すと JobQueue_enqueue が 10 秒で溢れて
  // 「ジョブキューが混雑しています」になるため、ロック内の呼び出し元は skipPending を渡す。
  if (opts && opts.skipPending) return;
  try {
    if (!resolved) resolved = _JobQueue_resolveCase(job.eventLabel, _JobQueue_loadResolution(ms));
    if (resolved.caseId) PanelPending_write(panel, resolved.caseId);
  } catch (e) { console.warn('JobQueue pending write failed: ' + e); }
}

function JobQueue_claimAndRun(workerId) {
  var lock = LockService.getDocumentLock(); // worker 同士の claim 競合だけを直列化する
  if (!lock.tryLock(10000)) return null;
  var sheet, ms, selected;
  try {
    sheet = JobQueue_ensureSheet();
    ms = SpreadsheetApp.openById(_JOBQUEUE_MASTER_SS);
    var rows = _JobQueue_rows(sheet);
    var nowMs = new Date().getTime();
    rows.filter(function (j) { return j.status === '実行中' && JobQueue_isStale(j.startedAt, nowMs); }).forEach(function (j) {
      var ended = new Date();
      sheet.getRange(j.sheetRow, 11, 1, 5).setValues([['タイムアウト', j.raw[11], ended, '', '15分を超えたためタイムアウト']]);
      _JobQueue_writePanel(ms, j, '', Utilities.formatDate(ended, 'Asia/Tokyo', 'MM/dd HH:mm'), '❌ タイムアウト（もう一度 ▶ を押してください）', '', { skipPending: true });
      j.status = 'タイムアウト';
    });
    var running = rows.filter(function (j) { return j.status === '実行中'; });
    selected = JobQueue_selectCandidate(rows.filter(function (j) { return j.status === '待機'; }), running);
    if (!selected) return null;
    var started = new Date();
    sheet.getRange(selected.sheetRow, 11, 1, 2).setValues([['実行中', started]]);
    sheet.getRange(selected.sheetRow, 16).setValue(workerId);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  var nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm');
  var end = new Date();
  var finalStatus = '完了', resultUrl = '', message = '', panelResult = '', panelStatus = '✅ 完了';
  var resultLinks = [];
  var jobCaseId = '';
  _JOBQUEUE_CTX = { panelSheetName: selected.panelSheetName, row: selected.row, requester: selected.requester, eventLabel: selected.eventLabel };
  try {
    var commands = _cmdQueue_commands();
    if (!commands[selected.command]) throw new Error('不明な機能: ' + selected.command);
    var args = [];
    try { args = JSON.parse(selected.argsJSON || '[]'); } catch (e) { args = []; }
    if (!selected.noCase) {
      var resolution = _JobQueue_loadResolution(ms);
      var resolved = _JobQueue_resolveCase(selected.eventLabel, resolution);
      if (!resolved.caseId) {
        try { BulkImportFromTaskMgmt_run({}); } catch (e) {}
        resolution = _JobQueue_loadResolution(ms);
        resolved = _JobQueue_resolveCase(selected.eventLabel, resolution);
      }
      if (!resolved.caseId) throw new Error('案件未同期: task シートのイベント列を確認してください');
      jobCaseId = resolved.caseId;
      args = [resolved.caseId].concat(args);
    }
    var ret = commands[selected.command].apply(null, args);
    // skipped は真偽値の規約。配列で skipped を返すコマンド (MailAttachments) があり
    // [] が truthy なので === true で判定する (完了なのに「スキップ」と出た)
    if (ret && ret.skipped === true) {
      finalStatus = 'スキップ';
      message = String(ret.reason || 'スキップされました').slice(0, 200);
      panelResult = '⚠ ' + message;
      panelStatus = '⚠ スキップ';
    } else {
      resultLinks = PanelLinks_collect(ret);
      resultUrl = resultLinks.length ? resultLinks[0].url : '';
      panelStatus = ret && ret.panelStatus ? String(ret.panelStatus) : '✅ 完了';
      if (ret && ret.panelResult) panelResult = String(ret.panelResult).slice(0, 200);
      // リンクが取れたら案内文は要らない (セル自体がリンクになる)
      else if (resultLinks.length) panelResult = '';
      else {
        // リンクも表示文も無いコマンド。実在する実施計画書の出力先を優先して案内する。
        var zissiLinks = PanelLinks_zissiOutputLinks(jobCaseId, selected.command);
        var fallback = PanelLinks_completionFallback(MasterWriteBack_artifactSheetUrl(jobCaseId), zissiLinks);
        panelResult = fallback.text;
        resultLinks = fallback.links;
      }
    }
  } catch (err) {
    finalStatus = 'エラー';
    message = String(err).slice(0, 200);
    panelResult = '';
    panelStatus = '❌ ' + message;
  } finally {
    _JOBQUEUE_CTX = null;
    end = new Date();
  }
  // 実行中に housekeep 等で行が削除されていると sheetRow が別ジョブを指す。
  // 書き戻す直前に jobId で行を引き直す (別ジョブの結果欄を汚さないため)。
  var writeRow = _JobQueue_rowByJobId(sheet, selected.jobId, selected.sheetRow);
  if (writeRow) sheet.getRange(writeRow, 11, 1, 5).setValues([[finalStatus, started, end, resultUrl, message]]);
  _JobQueue_writePanel(ms, selected, panelResult, nowStr, panelStatus, resultLinks);
  try { Panel_rebuildIndex(); } catch (e) {}
  return { jobId: selected.jobId, status: finalStatus, url: resultUrl, message: message };
}

function JobQueue_worker1() { return JobQueue_claimAndRun('w1'); }
function JobQueue_worker2() { return JobQueue_claimAndRun('w2'); }

function JobQueue_refreshWaitingLabels() {
  var sheet = JobQueue_ensureSheet();
  var jobs = _JobQueue_rows(sheet);
  var waiting = jobs.filter(function (j) { return j.status === '待機'; });
  var ms = SpreadsheetApp.openById(_JOBQUEUE_MASTER_SS);
  waiting.slice(0, 20).forEach(function (job) {
    var panel = ms.getSheetByName(job.panelSheetName);
    if (panel && job.row) {
      var statusCol = 6;
      panel.getRange(job.row, statusCol).setValue('⏳ 順番待ち (前に ' + JobQueue_countAhead(waiting, job) + ' 件)');
    }
  });
  return { waiting: waiting.length, updated: Math.min(waiting.length, 20) };
}

function JobQueue_housekeep() {
  var sheet = JobQueue_ensureSheet();
  var all = _JobQueue_rows(sheet);
  // 実行中のジョブがあるときは 1 行も削除しない (走っているジョブの行番号がズレて
  // 結果が別の行へ書かれる事故を防ぐ。翌日の実行で消えるので急がない)
  var busy = all.filter(function (j) { return j.status === '実行中'; }).length > 0;
  if (!busy && sheet.getLastRow() > 1201) {
    var done = all.filter(function (j) { return j.status === '完了'; }).slice(0, 400).map(function (j) { return j.sheetRow; }).sort(function (a, b) { return b - a; });
    done.forEach(function (row) { sheet.deleteRow(row); });
  }
  Panel_hideFinishedPanels(30);
  Panel_rebuildIndex();
  var resultTrashCount = 0;
  var resultCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  var cmdFiles = DriveApp.getFolderById(CMD_FOLDER_ID).getFiles();
  while (cmdFiles.hasNext() && resultTrashCount < 200) {
    var cmdFile = cmdFiles.next();
    if (cmdFile.getName().indexOf('result_') === 0 && cmdFile.getDateCreated().getTime() < resultCutoff) {
      cmdFile.setTrashed(true);
      resultTrashCount++;
    }
  }
  console.log('JobQueue_housekeep: trashed result files=' + resultTrashCount);
  return { rows: sheet.getLastRow() - 1, resultFilesTrashed: resultTrashCount };
}

function _JobQueue_currentPanel() {
  return _JOBQUEUE_CTX && _JOBQUEUE_CTX.panelSheetName ? _JOBQUEUE_CTX.panelSheetName : '🚀実行パネル';
}

/**
 * 保守用: 指定 jobId の行を削除する (最大10件・降順)。
 * 待機/実行中の行は消さない (走っているジョブの行番号をズラさないため)。
 */
function _admin_deleteJobRows(jobIds) {
  var ids = (jobIds || []).map(String);
  if (!ids.length) return { deleted: 0, reason: 'jobIds empty' };
  var sheet = JobQueue_ensureSheet();
  var rows = _JobQueue_rows(sheet).filter(function (j) {
    return ids.indexOf(j.jobId) >= 0 && j.status !== '待機' && j.status !== '実行中';
  });
  var targets = rows.slice(0, 10).map(function (j) { return j.sheetRow; }).sort(function (a, b) { return b - a; });
  targets.forEach(function (row) { sheet.deleteRow(row); });
  return { deleted: targets.length, rows: targets, skipped: ids.length - targets.length };
}

function _debug_jobQueue(limit) {
  var rows = _JobQueue_rows(JobQueue_ensureSheet());
  var counts = {};
  rows.forEach(function (j) { counts[j.status] = (counts[j.status] || 0) + 1; });
  return { total: rows.length, statusCounts: counts, jobs: rows.slice(-Math.min(Number(limit) || 20, 100)).reverse() };
}

function _debug_sleepEcho(caseId, seconds) {
  // 検証専用。並列実行の重なりを観測するため最大 120 秒まで許容する (本番機能では使わない)
  var sec = Math.max(0, Math.min(Number(seconds) || 0, 120));
  Utilities.sleep(sec * 1000);
  return { url: '', panelStatus: '✅ 検証OK' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    JobQueue_makePanelSheetName: JobQueue_makePanelSheetName,
    JobQueue_selectCandidate: JobQueue_selectCandidate,
    JobQueue_isStale: JobQueue_isStale,
    JobQueue_countAhead: JobQueue_countAhead,
    JobQueue_findDuplicate: JobQueue_findDuplicate
  };
}
