/**
 * 営業自動化アプリが収集したギガファイル便 URL を、外部ランナーの取込キューへ登録する。
 * GAS では実ダウンロードせず、一覧取得・ジョブ登録・結果ログだけを担当する。
 */

const TRANSFER_LINKS_LOG_SHEET = 'Claude_ギガファイル取込';
const TRANSFER_LINKS_LOOKBACK_DAYS = 90;
const TRANSFER_LINKS_START_DEADLINE_MS = 3.5 * 60 * 1000;
const TRANSFER_LINKS_CASE_BUDGET_MS = 60 * 1000;
const TRANSFER_LINKS_RUN_HARD_DEADLINE_MS = 5.2 * 60 * 1000;
const TRANSFER_LINKS_CURSOR_KEY = 'TransferLinks_caseCursor';
const TRANSFER_LINKS_MAX_ERROR_RETRIES = 3;
const TRANSFER_LINKS_LOG_HEADERS = [
  '取込日時', '案件ID', 'クライアント', '受信日時', '差出人', '件名', 'URL',
  '保存名', '保存先URL', 'bytes', '状態'
];

let _TRANSFER_LINKS_LOG_STATE = null;

function _TransferLinks_apiConfig() {
  const mailConfig = _MailAttach_apiConfig();
  if (!mailConfig) return null;
  const originMatch = String(mailConfig.baseUrl || '').match(/^(https?:\/\/[^/]+)/i);
  if (!originMatch) return null;
  return {
    listUrl: originMatch[1] + '/api/external/booth-transfer-links',
    jobsUrl: originMatch[1] + '/api/external/booth-transfer-jobs',
    token: mailConfig.token
  };
}

function _TransferLinks_parseResponse(response, label) {
  const code = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (e) {
    console.warn('TransferLinks JSON parse failed: ' + label + ' / HTTP ' + code);
    return { ok: false, error: 'invalid_json', status: code };
  }
  if (code !== 200 || !body || !body.ok) {
    const error = String(body && body.error || (code !== 200 ? 'http_' + code : 'api_not_ok'));
    console.warn('TransferLinks API failed: ' + label + ' / HTTP ' + code + ' / ' + error);
    return { ok: false, error: error, status: code, body: body };
  }
  return { ok: true, body: body, status: code };
}

function _TransferLinks_list(c) {
  const config = _TransferLinks_apiConfig();
  if (!config) return { ok: false, error: 'api_config_unavailable' };
  const query = [
    'token=' + encodeURIComponent(config.token),
    'caseId=' + encodeURIComponent(String(c.caseId || '')),
    'clientName=' + encodeURIComponent(String(c.clientName || '')),
    'days=' + encodeURIComponent(String(TRANSFER_LINKS_LOOKBACK_DAYS))
  ];
  try {
    return _TransferLinks_parseResponse(UrlFetchApp.fetch(config.listUrl + '?' + query.join('&'), {
      muteHttpExceptions: true
    }), 'list:' + c.caseId);
  } catch (e) {
    console.warn('TransferLinks list failed: ' + c.caseId + ' / ' + e.message);
    return { ok: false, error: 'fetch_failed:' + e.message };
  }
}

function _TransferLinks_enqueue(payload) {
  const config = _TransferLinks_apiConfig();
  if (!config) return { ok: false, error: 'api_config_unavailable' };
  try {
    return _TransferLinks_parseResponse(UrlFetchApp.fetch(config.jobsUrl + '?token=' + encodeURIComponent(config.token), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }), 'enqueue:' + payload.caseId);
  } catch (e) {
    console.warn('TransferLinks enqueue failed: ' + payload.caseId + ' / ' + e.message);
    return { ok: false, error: 'fetch_failed:' + e.message };
  }
}

function _TransferLinks_ensureLogState() {
  if (_TRANSFER_LINKS_LOG_STATE) return _TRANSFER_LINKS_LOG_STATE;
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TRANSFER_LINKS_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TRANSFER_LINKS_LOG_SHEET);
    sheet.appendRow(TRANSFER_LINKS_LOG_HEADERS);
    sheet.getRange(1, 1, 1, TRANSFER_LINKS_LOG_HEADERS.length)
      .setFontWeight('bold').setBackground('#cfe2f3');
    sheet.setFrozenRows(1);
  }
  const keys = new Set();
  const errorCounts = {};
  if (sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, 7, sheet.getLastRow() - 1, 5).getDisplayValues();
    values.forEach(function (row) {
      const key = String(row[0] || '');
      const status = String(row[4] || '');
      if (!key) return;
      if (status.indexOf('failed:') === 0) errorCounts[key] = (errorCounts[key] || 0) + 1;
      else if (status === 'saved' || status === 'expired' || status === 'needs_password') keys.add(key);
    });
  }
  _TRANSFER_LINKS_LOG_STATE = { sheet: sheet, keys: keys, errorCounts: errorCounts };
  return _TRANSFER_LINKS_LOG_STATE;
}

/** 決着済み、または failed が上限回数に達していれば再送しない。 */
function _TransferLinks_isSettled(logState, url) {
  const key = String(url || '');
  if (logState.keys.has(key)) return true;
  return (logState.errorCounts[key] || 0) >= TRANSFER_LINKS_MAX_ERROR_RETRIES;
}

function _TransferLinks_appendLog(state, c, link, fileName, driveFileUrl, bytes, status) {
  state.sheet.appendRow([
    new Date(), c && c.caseId || '', c && c.clientName || '', link && link.receivedAt || '',
    link && link.sender || '', link && link.subject || '', link && link.url || '',
    fileName || '', driveFileUrl || '', Number(bytes) || 0, status || ''
  ]);
}

function _TransferLinks_callbackConfig() {
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty('TRANSFER_CALLBACK_URL') || '').trim();
  const token = String(props.getProperty('TRANSFER_CALLBACK_TOKEN') || '').trim();
  // 片方だけの設定は認証不能な callback を作るため、callback 無しとして扱う。
  return url && token ? { url: url, token: token } : { url: '', token: '' };
}

function _TransferLinks_needsPassword(caseId) {
  const state = _TransferLinks_ensureLogState();
  const found = [];
  if (state.sheet.getLastRow() <= 1) return found;
  const rows = state.sheet.getRange(2, 2, state.sheet.getLastRow() - 1, 10).getDisplayValues();
  rows.forEach(function (row) {
    if (String(row[0]) === String(caseId) && String(row[9]) === 'needs_password') found.push(String(row[5] || ''));
  });
  return Array.from(new Set(found.filter(function (url) { return Boolean(url); })));
}

function TransferLinks_syncCase(caseId, opts) {
  const started = Date.now();
  let caseDeadlineAt = started + TRANSFER_LINKS_CASE_BUDGET_MS;
  if (opts && opts.hardDeadlineAt && opts.hardDeadlineAt < caseDeadlineAt) caseDeadlineAt = opts.hardDeadlineAt;
  if (Date.now() > caseDeadlineAt) return { ok: true, caseId: caseId, queued: 0, skipped: 0, truncated: true };

  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const listed = _TransferLinks_list(c);
  if (!listed.ok) return { ok: false, caseId: c.caseId, error: listed.error };
  if (!listed.body.found) return { ok: true, found: false, caseId: c.caseId, queued: 0, skipped: 0, truncated: false };

  const links = listed.body.links || [];
  // URL が無い案件では、空の「預かり素材」フォルダを作らない。
  if (links.length === 0) return { ok: true, caseId: c.caseId, queued: 0, skipped: 0, truncated: false,
    needsPasswordUrls: _TransferLinks_needsPassword(c.caseId) };

  const logState = _TransferLinks_ensureLogState();
  const pending = links.filter(function (link) {
    return link && link.url && !_TransferLinks_isSettled(logState, String(link.url));
  });
  if (pending.length === 0) {
    return { ok: true, caseId: c.caseId, queued: 0, skipped: links.length, truncated: false,
      needsPasswordUrls: _TransferLinks_needsPassword(c.caseId) };
  }
  if (Date.now() > caseDeadlineAt) return { ok: true, caseId: c.caseId, queued: 0, skipped: 0, truncated: true };

  const folderId = _Upload_findOrCreateAzukariFolder(c);
  if (!folderId) return { ok: false, caseId: c.caseId, error: '預かり素材フォルダを解決できません' };
  let azukariFolderUrl = '';
  try { azukariFolderUrl = DriveApp.getFolderById(folderId).getUrl(); } catch (e) {}
  if (Date.now() > caseDeadlineAt) return { ok: true, caseId: c.caseId, queued: 0, skipped: 0, truncated: true,
    azukariFolderUrl: azukariFolderUrl };

  const callback = _TransferLinks_callbackConfig();
  const jobLinks = pending.map(function (link) {
    return {
      url: String(link.url || ''), dlkey: String(link.dlkey || ''), messageId: String(link.messageId || ''),
      subject: String(link.subject || ''), sender: String(link.sender || ''), receivedAt: link.receivedAt || ''
    };
  });
  const enqueued = _TransferLinks_enqueue({
    caseId: c.caseId,
    clientName: c.clientName || '',
    folderId: folderId,
    prefix: 'ギガファイル_',
    callbackUrl: callback.url,
    callbackToken: callback.token,
    links: jobLinks
  });
  if (!enqueued.ok) {
    pending.forEach(function (link) {
      const reason = String(enqueued.error || 'enqueue_failed');
      _TransferLinks_appendLog(logState, c, link, '', '', 0, 'failed:' + reason);
      logState.errorCounts[String(link.url)] = (logState.errorCounts[String(link.url)] || 0) + 1;
    });
    return { ok: false, caseId: c.caseId, error: enqueued.error, queued: 0, truncated: false,
      azukariFolderUrl: azukariFolderUrl };
  }
  pending.forEach(function (link) {
    _TransferLinks_appendLog(logState, c, link, '', '', 0, 'queued');
  });
  return {
    ok: true, caseId: c.caseId, queued: Number(enqueued.body.queued) || 0,
    skipped: Number(enqueued.body.skipped) || 0, submitted: pending.length, truncated: false,
    azukariFolderUrl: azukariFolderUrl, needsPasswordUrls: _TransferLinks_needsPassword(c.caseId)
  };
}

function TransferLinks_pollAll() {
  const started = Date.now();
  const hardDeadlineAt = started + TRANSFER_LINKS_RUN_HARD_DEADLINE_MS;
  const filtered = _MailAttach_filterCases(CaseList_listAll(), started);
  const cases = filtered.included;
  const props = PropertiesService.getScriptProperties();
  const cursorCaseId = String(props.getProperty(TRANSFER_LINKS_CURSOR_KEY) || '');
  let startIndex = 0;
  if (cursorCaseId) {
    const cursorIndex = cases.findIndex(function (c) { return String(c.caseId) === cursorCaseId; });
    if (cursorIndex >= 0) startIndex = cursorIndex + 1;
  }
  const result = { ok: true, casesScanned: 0, casesSkipped: filtered.skipped.length,
    casesProcessed: 0, queuedTotal: 0, truncated: false, errors: [] };
  for (let i = startIndex; i < cases.length; i++) {
    if (Date.now() - started > TRANSFER_LINKS_START_DEADLINE_MS || Date.now() > hardDeadlineAt) {
      result.truncated = true;
      break;
    }
    const item = cases[i] || {};
    result.casesScanned++;
    try {
      const synced = TransferLinks_syncCase(item.caseId, { hardDeadlineAt: hardDeadlineAt });
      result.casesProcessed++;
      if (!synced.ok) result.errors.push({ caseId: item.caseId, error: synced.error || 'sync_failed' });
      else result.queuedTotal += Number(synced.queued) || 0;
      if (synced.truncated) {
        result.truncated = true;
        break;
      }
      props.setProperty(TRANSFER_LINKS_CURSOR_KEY, String(item.caseId));
    } catch (e) {
      result.casesProcessed++;
      result.errors.push({ caseId: item.caseId || '', error: String(e.message || e) });
      props.setProperty(TRANSFER_LINKS_CURSOR_KEY, String(item.caseId));
    }
  }
  if (!result.truncated) props.deleteProperty(TRANSFER_LINKS_CURSOR_KEY);
  return result;
}

function TransferLinks_setupTrigger() {
  const handlers = ScriptApp.getProjectTriggers().map(function (trigger) { return trigger.getHandlerFunction(); });
  if (handlers.indexOf('TransferLinks_pollAll') >= 0) return { created: false, existing: true, atHour: 3 };
  ScriptApp.newTrigger('TransferLinks_pollAll').timeBased().atHour(3).nearMinute(0).everyDays(1).create();
  return { created: true, existing: false, atHour: 3 };
}

function TransferLinks_handleCallback(payload) {
  payload = payload || {};
  const expected = String(PropertiesService.getScriptProperties().getProperty('TRANSFER_CALLBACK_TOKEN') || '');
  if (!expected || String(payload.token || '') !== expected) return { ok: false };
  const url = String(payload.url || '');
  if (!url) return { ok: false, error: 'url_required' };
  const rawStatus = String(payload.status || 'failed');
  const allowed = ['queued', 'saved', 'expired', 'needs_password'];
  const status = allowed.indexOf(rawStatus) >= 0
    ? rawStatus
    : (rawStatus.indexOf('failed:') === 0
      ? rawStatus.slice(0, 207)
      : 'failed:' + String(payload.error || rawStatus || 'unknown').slice(0, 200));
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    _TRANSFER_LINKS_LOG_STATE = null;
    const state = _TransferLinks_ensureLogState();
    let rowNumber = 0;
    if (state.sheet.getLastRow() > 1) {
      const urls = state.sheet.getRange(2, 7, state.sheet.getLastRow() - 1, 1).getDisplayValues();
      for (let i = urls.length - 1; i >= 0; i--) {
        if (String(urls[i][0] || '') === url) { rowNumber = i + 2; break; }
      }
    }
    if (rowNumber) {
      state.sheet.getRange(rowNumber, 8, 1, 4).setValues([[
        payload.fileName || '', payload.driveFileUrl || '', Number(payload.bytes) || 0, status
      ]]);
      state.sheet.getRange(rowNumber, 1).setValue(new Date());
    } else {
      const c = CaseList_getById(String(payload.caseId || '')) || { caseId: payload.caseId || '', clientName: '' };
      _TransferLinks_appendLog(state, c, { url: url }, payload.fileName, payload.driveFileUrl, payload.bytes, status);
      rowNumber = state.sheet.getLastRow();
    }
    _TRANSFER_LINKS_LOG_STATE = null;
    return { ok: true, rowNumber: rowNumber, status: status };
  } finally {
    lock.releaseLock();
  }
}

function _TransferLinks_withPanelResult(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.ok === false) {
    r.panelResult = '❌ ギガファイル便の取込登録に失敗しました: ' + String(r.error || '不明なエラー').slice(0, 120);
    r.panelStatus = '❌ エラー';
    return r;
  }
  if (r.found === false) {
    r.panelResult = 'お客様メールが見つかりませんでした (顧客の紐付けを確認してください)';
    return r;
  }
  const passwordUrls = r.needsPasswordUrls || [];
  let message = Number(r.queued || 0) + ' 件をキューに登録しました。夜間ランナーが取得し、完了すると預かり素材フォルダに入ります';
  if (r.truncated) message += '（時間切れのため続きは次回）';
  if (passwordUrls.length) message += ' / ダウンロードキー要確認 ' + passwordUrls.length + '件: ' + passwordUrls.join(', ');
  r.panelResult = message;
  return r;
}

function _debug_transferLinks(caseId) {
  return _TransferLinks_withPanelResult(TransferLinks_syncCase(caseId));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _TransferLinks_isSettled: _TransferLinks_isSettled,
    _TransferLinks_withPanelResult: _TransferLinks_withPanelResult
  };
}
