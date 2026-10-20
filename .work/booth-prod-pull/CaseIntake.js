/**
 * 案件の受領データ (メール添付 / LINE / ギガファイル便) を、GitHub Actions の runner 経由で制作フォルダへ自動保存する入口。
 * GAS は「案件ごとに取込ジョブを積む」「runner の完了結果を取込ログシートへ反映する」だけを担当し、
 * ダウンロード・振り分け・Drive 保存は営業アプリ側の runner (scripts/case-intake-runner.mjs) が行う (25MB 超・動画も可)。
 *
 * 切替フラグ (ScriptProperties):
 *   INTAKE_MODE = 'runner' | 'legacy'   (未設定 = legacy)
 *     legacy … 従来どおり MailAttachments / TransferLinks が預かり素材へ直接保存する
 *     runner … 上記2つの自動巡回・手動実行を止め、CaseIntake_pollAll / CaseIntake_syncCase だけが動く (二重保存防止)
 *   INTAKE_RESULTS_CURSOR … (自動管理) 取込ログへ反映済みの最終 updated_at (ISO)
 */

const CASE_INTAKE_MODE_KEY = 'INTAKE_MODE';
const CASE_INTAKE_RESULTS_CURSOR_KEY = 'INTAKE_RESULTS_CURSOR';
const CASE_INTAKE_LOOKBACK_DAYS = 90;
const CASE_INTAKE_START_DEADLINE_MS = 3.5 * 60 * 1000;
const CASE_INTAKE_RUN_HARD_DEADLINE_MS = 5.2 * 60 * 1000;
const CASE_INTAKE_CURSOR_KEY = 'CaseIntake_caseCursor';

function CaseIntake_mode() {
  const value = String(PropertiesService.getScriptProperties().getProperty(CASE_INTAKE_MODE_KEY) || '').trim().toLowerCase();
  return value === 'runner' ? 'runner' : 'legacy';
}

function CaseIntake_isRunnerMode() {
  return CaseIntake_mode() === 'runner';
}

function _CaseIntake_apiConfig() {
  const mailConfig = _MailAttach_apiConfig();
  if (!mailConfig) return null;
  const originMatch = String(mailConfig.baseUrl || '').match(/^(https?:\/\/[^/]+)/i);
  if (!originMatch) return null;
  return { url: originMatch[1] + '/api/external/booth-intake-jobs', token: mailConfig.token };
}

function _CaseIntake_call(method, params, payload, label) {
  const config = _CaseIntake_apiConfig();
  if (!config) return { ok: false, error: 'api_config_unavailable' };
  const query = ['token=' + encodeURIComponent(config.token)];
  Object.keys(params || {}).forEach(function (key) {
    if (params[key] === null || params[key] === undefined || params[key] === '') return;
    query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
  });
  const options = { method: method, muteHttpExceptions: true };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  try {
    const response = UrlFetchApp.fetch(config.url + '?' + query.join('&'), options);
    const code = response.getResponseCode();
    let body;
    try {
      body = JSON.parse(response.getContentText());
    } catch (e) {
      console.warn('CaseIntake JSON parse failed: ' + label + ' / HTTP ' + code);
      return { ok: false, error: 'invalid_json', status: code };
    }
    if (code !== 200 || !body || !body.ok) {
      const error = String(body && body.error || (code !== 200 ? 'http_' + code : 'api_not_ok'));
      console.warn('CaseIntake API failed: ' + label + ' / ' + error);
      return { ok: false, error: error, status: code, body: body };
    }
    return { ok: true, body: body, status: code };
  } catch (e) {
    console.warn('CaseIntake fetch failed: ' + label + ' / ' + e.message);
    return { ok: false, error: 'fetch_failed:' + e.message };
  }
}

/** 案件1件分のジョブを積む。制作フォルダ (Case_resolveProjectRoot) の ID を runner に渡す。 */
function CaseIntake_syncCase(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const rootFolderId = Case_resolveProjectRoot(c);
  if (!rootFolderId) return { ok: false, caseId: c.caseId, error: '制作フォルダを解決できません' };
  const result = _CaseIntake_call('post', {}, {
    caseId: c.caseId,
    clientName: c.clientName || '',
    rootFolderId: rootFolderId,
    days: CASE_INTAKE_LOOKBACK_DAYS
  }, 'enqueue:' + c.caseId);
  if (!result.ok) return { ok: false, caseId: c.caseId, error: result.error };
  const body = result.body;
  return {
    ok: true, caseId: c.caseId, found: body.found !== false,
    queued: Number(body.queued) || 0, skipped: Number(body.skipped) || 0, counts: body.counts || {}
  };
}

function CaseIntake_pollAll() {
  const started = Date.now();
  const hardDeadlineAt = started + CASE_INTAKE_RUN_HARD_DEADLINE_MS;
  const filtered = _MailAttach_filterCases(CaseList_listAll(), started);
  const cases = filtered.included;
  const props = PropertiesService.getScriptProperties();
  const cursorCaseId = String(props.getProperty(CASE_INTAKE_CURSOR_KEY) || '');
  let startIndex = 0;
  if (cursorCaseId) {
    const cursorIndex = cases.findIndex(function (c) { return String(c.caseId) === cursorCaseId; });
    if (cursorIndex >= 0) startIndex = cursorIndex + 1;
  }
  const result = { ok: true, mode: 'runner', casesScanned: 0, casesSkipped: filtered.skipped.length, queuedTotal: 0, truncated: false, errors: [] };
  // LINE グループ ⇄ 顧客のリンクを毎回同期する (リンクが無いと LINE の添付が案件に結び付かない鶏と卵を避ける)。
  // 日次サマリとは切り離す。失敗しても巡回は続ける。
  const lineSync = _CaseIntake_call('post', { action: 'sync-line' }, {}, 'sync-line');
  result.lineSync = lineSync.ok ? { groups: lineSync.body.groups, autoLinked: lineSync.body.autoLinked } : { error: lineSync.error };
  for (let i = startIndex; i < cases.length; i++) {
    if (Date.now() - started > CASE_INTAKE_START_DEADLINE_MS || Date.now() > hardDeadlineAt) {
      result.truncated = true;
      break;
    }
    const item = cases[i] || {};
    result.casesScanned++;
    try {
      const synced = CaseIntake_syncCase(item.caseId);
      if (!synced.ok) result.errors.push({ caseId: item.caseId, error: synced.error || 'sync_failed' });
      else result.queuedTotal += synced.queued;
    } catch (e) {
      result.errors.push({ caseId: item.caseId || '', error: String(e.message || e) });
    }
    props.setProperty(CASE_INTAKE_CURSOR_KEY, String(item.caseId));
  }
  if (!result.truncated) props.deleteProperty(CASE_INTAKE_CURSOR_KEY);
  try {
    result.reflected = CaseIntake_reflectResults({ deadlineAt: hardDeadlineAt });
  } catch (e) {
    result.errors.push({ caseId: '', error: 'reflect:' + String(e.message || e) });
  }
  return result;
}

/** runner が決着させたジョブを、従来の取込ログシート (Claude_メール添付取込) へ追記する。cursor で二重反映を防ぐ。 */
function CaseIntake_reflectResults(opts) {
  // 時間予算内でのみ実行する (巡回で時間を使い切った回は次回に回す)。
  const deadlineAt = opts && opts.deadlineAt;
  if (deadlineAt && Date.now() > deadlineAt) return { ok: true, appended: 0, deferred: true };
  const props = PropertiesService.getScriptProperties();
  const since = String(props.getProperty(CASE_INTAKE_RESULTS_CURSOR_KEY) || '');
  const listed = _CaseIntake_call('get', { results: 1, since: since, limit: 200 }, null, 'results');
  if (!listed.ok) return { ok: false, error: listed.error, appended: 0 };
  const jobs = listed.body.jobs || [];
  if (jobs.length === 0) return { ok: true, appended: 0 };
  const state = _MailAttach_ensureLogState();
  // 1 件ずつ appendRow すると遅い (API 呼び出し N 回) ので、まとめて setValues 1 回で書く。
  const rows = jobs.map(function (job) {
    const status = job.status === 'saved' ? 'saved' : job.status === 'skipped' ? 'skipped_duplicate' : 'error:' + (job.error || job.status);
    return [
      new Date(), job.case_id || '', job.client_name || '', job.received_at || '', job.sender || '',
      job.subject || '', job.file_name || '', job.file_name || '',
      job.drive_file_url || '', Number(job.bytes) || 0,
      'runner:' + (job.kind || ''), job.routed_path || '', status
    ];
  });
  state.sheet.getRange(state.sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  props.setProperty(CASE_INTAKE_RESULTS_CURSOR_KEY, String(jobs[jobs.length - 1].updated_at));
  return { ok: true, appended: jobs.length };
}

/** 15 分毎に runner 用ジョブを積む。MailAttachments_pollAll のトリガーを流用するので、通常は新規トリガー不要。 */
function CaseIntake_setupTrigger() {
  // 冪等: 既存の CaseIntake_pollAll トリガーを削除してから作り直す (重複トリガーで二重に積まない)。
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'CaseIntake_pollAll') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  ScriptApp.newTrigger('CaseIntake_pollAll').timeBased().everyMinutes(15).create();
  return { removedOld: removed, created: true, everyMinutes: 15 };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CaseIntake_mode: CaseIntake_mode, CASE_INTAKE_MODE_KEY: CASE_INTAKE_MODE_KEY };
}
