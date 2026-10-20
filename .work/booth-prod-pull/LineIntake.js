/**
 * LINE Messaging API webhook 取り込み。doPost から ?src=line&key=... で呼ばれる。
 * GAS は X-Line-Signature を読めないため、URL の key と Script property LINE_WEBHOOK_KEY の一致で認証する。
 * 前提: TaskLedger_markDirty / ExternalNotes_append（別ファイルで実装）。
 */
var LINE_SHEET_MAP = 'LINE連携';
var LINE_SHEET_UNASSIGNED = '📨LINE未振分け';
var LINE_MAP_HEADERS = ['sourceId', 'caseId', '案件名キーワード', '表示名', '備考'];
var LINE_UNASSIGNED_HEADERS = ['日時', 'sourceId', '送信者', '本文', 'messageId'];
var LINE_SEEN_TTL_MS = 24 * 60 * 60 * 1000;
var LINE_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------- 純粋ロジック ----------
function LineIntake_authorize(params, configuredKey) {
  var p = params || {};
  return !!configuredKey && p.src === 'line' && String(p.key || '') === String(configuredKey);
}

/** property を優先し、空なら Drive 設定へフォールバックする。 */
function LineIntake_resolveSettings(propertyKey, configLine) {
  var prop = String(propertyKey || '');
  var config = configLine || {};
  if (prop) return { enabled: true, key: prop, source: 'property' };
  if (config.enabled === false) return { enabled: false, key: '', source: 'none' };
  var key = String(config.webhookKey || '');
  return { enabled: !!key, key: key, source: key ? 'config' : 'none' };
}

function LineIntake_sourceId(source) {
  var s = source || {};
  return String(s.groupId || s.roomId || s.userId || '');
}

/** mapping: [{sourceId, caseId, keyword}], cases: [{caseId, name}] -> {caseId, via} | null */
function LineIntake_matchCase(sourceId, text, mapping, cases) {
  var i;
  var m = mapping || [];
  for (i = 0; i < m.length; i++) {
    if (sourceId && String(m[i].sourceId) === String(sourceId) && m[i].caseId) {
      return { caseId: String(m[i].caseId), via: 'source' };
    }
  }
  var body = String(text || '');
  if (!body) return null;
  var best = null;
  var cs = cases || [];
  for (i = 0; i < cs.length; i++) {
    var id = String(cs[i].caseId || '');
    if (id && body.indexOf(id) >= 0 && (!best || id.length > best.len)) best = { caseId: id, len: id.length };
  }
  if (best) return { caseId: best.caseId, via: 'caseId' };
  var kw = [];
  for (i = 0; i < cs.length; i++) if (cs[i].name) kw.push({ caseId: String(cs[i].caseId), k: String(cs[i].name) });
  for (i = 0; i < m.length; i++) if (m[i].keyword && m[i].caseId) kw.push({ caseId: String(m[i].caseId), k: String(m[i].keyword) });
  for (i = 0; i < kw.length; i++) {
    if (body.indexOf(kw[i].k) >= 0 && (!best || kw[i].k.length > best.len)) best = { caseId: kw[i].caseId, len: kw[i].k.length };
  }
  return best ? { caseId: best.caseId, via: 'name' } : null;
}

/**
 * payload の events を処理する。deps（GAS 依存を注入）:
 *  isSeen(id) / markSeen(id) / loadMapping() / loadCases() / displayName(source) /
 *  saveMedia(message, caseId) -> url|'' / appendNote(caseId, src, note) / markDirty(caseId, src, ref, note) /
 *  appendUnassigned(row) / touch(ms)
 */
function LineIntake_processEvents(payload, deps) {
  var result = { processed: 0, duplicate: 0, unassigned: 0, ignored: 0 };
  var events = payload && payload.events ? payload.events : [];
  var mapping = null;
  var cases = null;
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (!ev || ev.type !== 'message' || !ev.message) { result.ignored++; continue; }
    var msg = ev.message;
    var id = String(msg.id || '');
    if (id && deps.isSeen(id)) { result.duplicate++; continue; }
    if (id) deps.markSeen(id);
    if (mapping === null) { mapping = deps.loadMapping(); cases = deps.loadCases(); }
    var sourceId = LineIntake_sourceId(ev.source);
    var isText = msg.type === 'text';
    var text = isText ? String(msg.text || '') : '[' + String(msg.type || 'unknown') + ' message ' + id + ']';
    var at = new Date(Number(ev.timestamp) || Date.now());
    var author = deps.displayName(ev.source) || (ev.source && ev.source.userId) || sourceId;
    var hit = LineIntake_matchCase(sourceId, isText ? text : '', mapping, cases);
    if (deps.touch) deps.touch(at.getTime());
    if (!hit) {
      deps.appendUnassigned([at, sourceId, author, text, id]);
      result.unassigned++;
      continue;
    }
    var links = [];
    if (!isText && deps.saveMedia) {
      var url = deps.saveMedia(msg, hit.caseId);
      if (url) links.push(url);
    }
    deps.appendNote(hit.caseId, 'line', { at: at, author: author, text: text, links: links });
    deps.markDirty(hit.caseId, 'line', id, text.slice(0, 60));
    result.processed++;
  }
  return result;
}

// ---------- GAS 実体 ----------
function _LineIntake_props() { return PropertiesService.getScriptProperties(); }

function _LineIntake_masterSs() { return SpreadsheetApp.openById(_PANEL_MASTER_SS); }

function _LineIntake_sheet(name, headers) {
  var ss = _LineIntake_masterSs();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

function _LineIntake_json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function _LineIntake_purgeSeen(now) {
  var props = _LineIntake_props();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('LINE_SEEN_') === 0 && now - Number(all[k]) > LINE_SEEN_TTL_MS) props.deleteProperty(k);
  });
}

function _LineIntake_token() { return _LineIntake_props().getProperty('LINE_CHANNEL_ACCESS_TOKEN') || ''; }

function _LineIntake_displayName(source) {
  var s = source || {};
  var userId = s.userId;
  if (!userId) return '';
  var props = _LineIntake_props();
  var cacheKey = 'LINE_NAME_' + userId;
  var now = Date.now();
  var cached = props.getProperty(cacheKey);
  if (cached) {
    try {
      var c = JSON.parse(cached);
      if (now - c.t < LINE_NAME_TTL_MS) return c.n;
    } catch (err) { /* 再取得 */ }
  }
  var token = _LineIntake_token();
  if (!token) return '';
  try {
    var url = s.groupId ? 'https://api.line.me/v2/bot/group/' + s.groupId + '/member/' + userId
      : s.roomId ? 'https://api.line.me/v2/bot/room/' + s.roomId + '/member/' + userId
      : 'https://api.line.me/v2/bot/profile/' + userId;
    var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    var name = JSON.parse(res.getContentText()).displayName || '';
    if (name) props.setProperty(cacheKey, JSON.stringify({ n: name, t: now }));
    return name;
  } catch (err) {
    console.error('LineIntake displayName: ' + err);
    return '';
  }
}

function _LineIntake_saveMedia(message, caseId) {
  var token = _LineIntake_token();
  if (!token || !message.id) return '';
  try {
    var res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + message.id + '/content',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    var sh = _LineIntake_masterSs().getSheetByName('案件一覧');
    if (!sh) return '';
    var rows = sh.getDataRange().getValues();
    var folderId = '';
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]) === String(caseId)) { folderId = String(rows[r][8] || ''); break; }
    }
    if (!folderId) return '';
    var blob = res.getBlob().setName('line_' + message.id);
    return DriveApp.getFolderById(folderId).createFile(blob).getUrl();
  } catch (err) {
    console.error('LineIntake saveMedia: ' + err);
    return '';
  }
}

function _LineIntake_deps() {
  var props = _LineIntake_props();
  return {
    isSeen: function (id) { return !!props.getProperty('LINE_SEEN_' + id); },
    markSeen: function (id) { props.setProperty('LINE_SEEN_' + id, String(Date.now())); },
    loadMapping: function () {
      var rows = _LineIntake_sheet(LINE_SHEET_MAP, LINE_MAP_HEADERS).getDataRange().getValues();
      var sheet = rows.slice(1).map(function (r) { return { sourceId: String(r[0] || ''), caseId: String(r[1] || ''), keyword: String(r[2] || '') }; });
      var used = {};
      sheet.forEach(function (m) { if (m.sourceId) used[m.sourceId] = true; });
      var line = (IntakeConfig_load().line || {});
      Object.keys(line.sources || {}).forEach(function (sourceId) {
        if (!used[sourceId]) sheet.push({ sourceId: sourceId, caseId: String(line.sources[sourceId]), keyword: '' });
      });
      return sheet;
    },
    loadCases: function () {
      var sh = _LineIntake_masterSs().getSheetByName('案件一覧');
      if (!sh) return [];
      return sh.getDataRange().getValues().slice(1).map(function (r) { return { caseId: String(r[0] || ''), name: String(r[2] || '') }; });
    },
    displayName: _LineIntake_displayName,
    saveMedia: _LineIntake_saveMedia,
    appendNote: function (caseId, src, note) { return ExternalNotes_append(caseId, src, note); },
    markDirty: function (caseId, src, ref, note) { return TaskLedger_markDirty(caseId, src, ref, note); },
    appendUnassigned: function (row) { _LineIntake_sheet(LINE_SHEET_UNASSIGNED, LINE_UNASSIGNED_HEADERS).appendRow(row); },
    touch: function (ms) { props.setProperty('LINE_LAST_EVENT_AT', new Date(ms).toISOString()); }
  };
}

function LineIntake_handlePost(e) {
  var settings = LineIntake_resolveSettings(_LineIntake_props().getProperty('LINE_WEBHOOK_KEY'), (IntakeConfig_load().line || {}));
  if (!settings.enabled) return _LineIntake_json({ ok: false, reason: 'disabled' });
  if (!LineIntake_authorize(e && e.parameter, settings.key)) return _LineIntake_json({ ok: false, reason: 'unauthorized' });
  try {
    var payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    _LineIntake_purgeSeen(Date.now());
    LineIntake_processEvents(payload, _LineIntake_deps());
  } catch (err) {
    console.error('LineIntake_handlePost: ' + err);
  }
  return ContentService.createTextOutput('ok');
}

/** CommandQueue 用: key 検証なしで webhook 本文を通す */
function LineIntake_simulate(payloadJson) {
  var payload = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
  return LineIntake_processEvents(payload, _LineIntake_deps());
}

function LineIntake_status() {
  var props = _LineIntake_props();
  var config = (IntakeConfig_load().line || {});
  var settings = LineIntake_resolveSettings(props.getProperty('LINE_WEBHOOK_KEY'), config);
  var map = _LineIntake_sheet(LINE_SHEET_MAP, LINE_MAP_HEADERS);
  var un = _LineIntake_sheet(LINE_SHEET_UNASSIGNED, LINE_UNASSIGNED_HEADERS);
  var mapped = {};
  if (map.getLastRow() > 1) map.getRange(2, 1, map.getLastRow() - 1, 1).getDisplayValues().forEach(function (r) { if (r[0]) mapped[String(r[0])] = true; });
  Object.keys(config.sources || {}).forEach(function (sourceId) { mapped[sourceId] = true; });
  return {
    keyConfigured: !!settings.key,
    source: settings.source,
    tokenConfigured: !!props.getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
    mappedSources: Object.keys(mapped).length,
    unassignedRows: Math.max(0, un.getLastRow() - 1),
    lastEventAt: props.getProperty('LINE_LAST_EVENT_AT') || ''
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LineIntake_authorize, LineIntake_resolveSettings, LineIntake_sourceId, LineIntake_matchCase, LineIntake_processEvents };
}
