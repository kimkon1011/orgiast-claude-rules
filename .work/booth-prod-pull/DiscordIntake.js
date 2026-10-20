/**
 * Discord の新着メッセージを案件へ取り込み、外部連絡ドキュメントへ記録して再実行を促す（受信専用）。
 * Bot トークンは FeedbackRelay.js と同じ Script property DISCORD_BOT_TOKEN。
 * トリガーは追加せず MailAttachments_pollAll の末尾から呼ぶ。
 */

const DISCORD_INTAKE_SHEET = 'Discord連携';
const DISCORD_INTAKE_HEADERS = ['channelId', 'caseId', '案件名キーワード', '備考'];
const DISCORD_INTAKE_CURSOR_PREFIX = 'DISCORD_INTAKE_CURSOR_';
const DISCORD_INTAKE_DEFAULT_MAX_CHANNELS = 25;
const DISCORD_INTAKE_API = 'https://discord.com/api/v10';
const DISCORD_INTAKE_MAX_RETRY_WAIT_MS = 5000;

/**
 * 共通チャンネル本文 → caseId。caseId の一致を優先し、次に案件名の部分一致（最長一致）。
 * cases: [{caseId, caseName}]。見つからなければ null。
 */
function DiscordIntake_matchCase(content, cases) {
  const text = String(content || '');
  if (!text) return null;
  const list = cases || [];
  for (let i = 0; i < list.length; i++) {
    const id = String(list[i].caseId || '');
    if (id && text.indexOf(id) >= 0) return id;
  }
  let best = null, bestLen = 0;
  list.forEach(function (c) {
    const name = String(c.caseName || '').trim();
    if (name && name.length > bestLen && text.indexOf(name) >= 0) { best = String(c.caseId); bestLen = name.length; }
  });
  return best;
}

/** Bot 自身の投稿・システムメッセージ（type 0 通常 / 19 返信 以外）を除外。 */
function DiscordIntake_shouldSkipMessage(msg, botUserId) {
  if (!msg) return true;
  if (msg.type !== undefined && msg.type !== 0 && msg.type !== 19) return true;
  const a = msg.author || {};
  if (a.bot && botUserId && String(a.id) === String(botUserId)) return true;
  if (botUserId && String(a.id) === String(botUserId)) return true;
  return false;
}

/** snowflake（数字文字列）の大きい方。 */
function DiscordIntake_maxId(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a >= b ? a : b;
}

/** チャンネル名・顧客名を照合用に正規化する。 */
function DiscordIntake_normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).replace(/株式会社|有限会社|\(株\)|㈱|様/g, '')
    .replace(/[\s_\-・【】()（）\/／.]/g, '');
}

/** 照合語: 法人種別(医療法人・一般社団法人など)を除いた名前の先頭 6 文字。短すぎる名前(日本語3文字未満・英数4文字未満)は対象外(誤一致を避ける)。 */
function _DiscordIntake_matchWord(clientName) {
  var normalized = DiscordIntake_normalizeName(String(clientName || '').replace(/医療法人|一般社団法人|公益社団法人|一般財団法人|公益財団法人|学校法人|社会福祉法人|特定非営利活動法人|npo法人|合同会社|合資会社|合名会社/gi, ''));
  if (!normalized) return '';
  var japanese = /[ぁ-んァ-ヶ一-龠]/.test(normalized.charAt(0));
  var min = japanese ? 3 : 4;
  return normalized.length >= min ? normalized.slice(0, 6) : '';
}

/** channels:[{id,name}], cases:[{caseId,clientName}] から一意な自動対応を返す。 */
function DiscordIntake_autoMatch(channels, cases, explicitChannels) {
  var explicit = explicitChannels || {};
  var words = {};
  (cases || []).forEach(function (c) {
    var word = _DiscordIntake_matchWord(c.clientName);
    var caseId = String(c.caseId || '');
    if (!word || !caseId) return;
    if (!words[word]) words[word] = [];
    if (words[word].indexOf(caseId) < 0) words[word].push(caseId);
  });
  var map = {};
  (channels || []).forEach(function (ch) {
    var id = String(ch.id || '');
    if (!id || explicit[id]) return;
    var name = DiscordIntake_normalizeName(ch.name);
    var hits = [];
    Object.keys(words).forEach(function (word) {
      if (words[word].length === 1 && name.indexOf(word) >= 0 && hits.indexOf(words[word][0]) < 0) hits.push(words[word][0]);
    });
    if (hits.length === 1) map[id] = hits[0];
  });
  return map;
}

/** 数値カーソルから最大 max 件を巡回選択する純粋関数。 */
function DiscordIntake_rotateChannels(channels, max, cursor) {
  var list = (channels || []).slice();
  var limit = Math.max(1, Number(max) || DISCORD_INTAKE_DEFAULT_MAX_CHANNELS);
  if (!list.length) return { channels: [], nextCursor: 0 };
  var start = Math.max(0, Number(cursor) || 0) % list.length;
  var count = Math.min(limit, list.length);
  var selected = [];
  for (var i = 0; i < count; i++) selected.push(list[(start + i) % list.length]);
  return { channels: selected, nextCursor: (start + count) % list.length };
}

/**
 * 1 チャンネル分の取得・振り分け。deps で GAS API を注入する。
 * deps: {fetch(url)->{code, headers, text}, sleep(ms), getCursor(ch), setCursor(ch,id), botUserId,
 *        cases, resolveFixed(ch)->caseId|null, append(caseId, source, entry), markDirty(caseId, source, ref, note), log(msg)}
 * 戻り値 {status:'ok'|'auth'|'ratelimited'|'error', fetched, linked, dropped, lastId}
 */
function DiscordIntake_processChannel(channelId, deps) {
  const fail = function (status, code) { return { status: status, code: code, fetched: 0, linked: 0, dropped: 0 }; };
  const cursor = deps.getCursor(channelId);
  let url = DISCORD_INTAKE_API + '/channels/' + channelId + '/messages?limit=100';
  if (cursor) url += '&after=' + cursor;
  let res = deps.fetch(url);
  if (res.code === 429) {
    let wait = 1000;
    try { wait = Math.ceil(Number(JSON.parse(res.text).retry_after || 1) * 1000); } catch (e) {}
    const hdr = res.headers && (res.headers['Retry-After'] || res.headers['retry-after']);
    if (hdr) wait = Math.ceil(Number(hdr) * 1000);
    if (wait > DISCORD_INTAKE_MAX_RETRY_WAIT_MS) return fail('ratelimited', 429);
    deps.sleep(wait);
    res = deps.fetch(url);
    if (res.code === 429) return fail('ratelimited', 429);
  }
  if (res.code === 401 || res.code === 403) return fail('auth', res.code);
  if (res.code !== 200) return fail('error', res.code);
  let msgs;
  try { msgs = JSON.parse(res.text); } catch (e) { return fail('error', res.code); }
  if (!Array.isArray(msgs)) return fail('error', res.code);
  // Discord は新しい順で返す。古い順に処理する。
  msgs.sort(function (x, y) {
    if (x.id === y.id) return 0;
    return DiscordIntake_maxId(x.id, y.id) === x.id ? 1 : -1;
  });
  const fixed = deps.resolveFixed(channelId);
  let lastId = cursor || '', linked = 0, dropped = 0;
  msgs.forEach(function (m) {
    lastId = DiscordIntake_maxId(lastId, m.id);
    if (DiscordIntake_shouldSkipMessage(m, deps.botUserId)) return;
    const caseId = fixed || DiscordIntake_matchCase(m.content, deps.cases);
    if (!caseId) { dropped++; deps.log('discord: 案件不明のため破棄 ' + m.id); return; }
    const content = String(m.content || '');
    const links = (m.attachments || []).map(function (a) { return a.url; }).filter(Boolean);
    deps.append(caseId, 'discord', { at: new Date(m.timestamp), author: (m.author && m.author.username) || '', text: content, links: links });
    deps.markDirty(caseId, 'discord', String(m.id), content.slice(0, 60));
    linked++;
  });
  if (lastId && lastId !== cursor) deps.setCursor(channelId, lastId);
  return { status: 'ok', fetched: msgs.length, linked: linked, dropped: dropped, lastId: lastId };
}

function _DiscordIntake_loadSheetMap() {
  const map = {};
  try {
    const ss = SpreadsheetApp.openById(_PANEL_MASTER_SS);
    let sheet = ss.getSheetByName(DISCORD_INTAKE_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(DISCORD_INTAKE_SHEET);
      sheet.appendRow(DISCORD_INTAKE_HEADERS);
      sheet.getRange(1, 1, 1, DISCORD_INTAKE_HEADERS.length).setFontWeight('bold').setBackground('#cfe2f3');
      sheet.setFrozenRows(1);
    }
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
        const ch = String(r[0] || '').trim(), id = String(r[1] || '').trim();
        if (ch) map[ch] = id || '';
      });
    }
  } catch (e) { Logger.log('DiscordIntake config: ' + e.message); }
  return map;
}

function _DiscordIntake_propertyChannels() {
  const set = {};
  String(PropertiesService.getScriptProperties().getProperty('DISCORD_INTAKE_CHANNEL_IDS') || '')
    .split(',').forEach(function (s) { s = s.trim(); if (s) set[s] = true; });
  return set;
}

function _DiscordIntake_activeCases() {
  return TaskLedger_activeCaseIds().map(function (caseId) { return CaseList_getById(caseId); }).filter(Boolean);
}

function _DiscordIntake_autoMap(config, token, explicit, force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var cached = cache.get('discord-automap');
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }
  var guildId = String(config.guildId || '');
  if (!guildId || !token || config.autoMatchByClientName !== true) return { map: {}, channels: [], status: 'disabled' };
  try {
    var res = UrlFetchApp.fetch(DISCORD_INTAKE_API + '/guilds/' + encodeURIComponent(guildId) + '/channels', {
      headers: { Authorization: 'Bot ' + token }, muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code !== 200) return { map: {}, channels: [], status: code === 401 || code === 403 ? 'auth' : 'error', code: code };
    var all = JSON.parse(res.getContentText());
    var textChannels = Array.isArray(all) ? all.filter(function (ch) { return ch.type === 0; }).map(function (ch) {
      return { id: String(ch.id || ''), name: String(ch.name || '') };
    }) : [];
    var map = DiscordIntake_autoMatch(textChannels, _DiscordIntake_activeCases(), explicit);
    var result = { map: map, channels: textChannels, status: 'ok' };
    cache.put('discord-automap', JSON.stringify(result), 3600);

    var props = PropertiesService.getScriptProperties();
    var sorted = {};
    Object.keys(map).sort().forEach(function (id) { sorted[id] = map[id]; });
    var hash = JSON.stringify(sorted);
    if (hash !== String(props.getProperty('DISCORD_INTAKE_AUTOMAP_HASH') || '')) {
      props.setProperty('DISCORD_INTAKE_AUTOMAP_HASH', hash);
      var names = {};
      textChannels.forEach(function (ch) { names[ch.id] = ch.name; });
      var pairs = Object.keys(map).map(function (id) { return (names[id] || id) + '→' + map[id]; });
      var message = pairs.slice(0, 15).join(', ') + (pairs.length > 15 ? '（残り' + (pairs.length - 15) + '件）' : '');
      TaskLedger_appendRunLog({ caseId: '', caseName: '-', taskName: '(discord-map)', route: 'discord', result: 'ok', message: message, seconds: 0 });
    }
    return result;
  } catch (e) {
    console.warn('DiscordIntake autoMap: ' + e);
    return { map: {}, channels: [], status: 'error', error: String(e) };
  }
}

function DiscordIntake_autoMapNow() {
  var config = (IntakeConfig_load().discord || {});
  var token = String(PropertiesService.getScriptProperties().getProperty('DISCORD_BOT_TOKEN') || '');
  var explicit = _DiscordIntake_propertyChannels();
  Object.keys(config.channels || {}).forEach(function (id) { explicit[id] = true; });
  (config.commonChannels || []).forEach(function (id) { explicit[id] = true; });
  Object.keys(_DiscordIntake_loadSheetMap()).forEach(function (id) { explicit[id] = true; });
  return _DiscordIntake_autoMap(config, token, explicit, true);
}

function DiscordIntake_pollAll() {
  const started = new Date().getTime();
  const props = PropertiesService.getScriptProperties();
  const config = (IntakeConfig_load().discord || {});
  if (config.enabled === false) return { ok: true, skipped: 'disabled' };
  const token = String(props.getProperty('DISCORD_BOT_TOKEN') || '');
  if (!token) { Logger.log('DiscordIntake: DISCORD_BOT_TOKEN 未設定のためスキップ'); return { ok: true, skipped: 'no_token' }; }
  const fixedMap = {};
  Object.keys(config.channels || {}).forEach(function (id) { fixedMap[id] = config.channels[id]; });
  const sheetMap = _DiscordIntake_loadSheetMap();
  Object.keys(sheetMap).forEach(function (id) { fixedMap[id] = sheetMap[id]; });
  const explicit = _DiscordIntake_propertyChannels();
  Object.keys(fixedMap).forEach(function (id) { explicit[id] = true; });
  (config.commonChannels || []).forEach(function (id) { explicit[id] = true; });
  const autoResult = _DiscordIntake_autoMap(config, token, explicit, false);
  Object.keys(autoResult.map || {}).forEach(function (id) { if (!fixedMap[id]) fixedMap[id] = autoResult.map[id]; });
  const target = {};
  Object.keys(explicit).forEach(function (id) { target[id] = true; });
  Object.keys(autoResult.map || {}).forEach(function (id) { target[id] = true; });
  const allChannels = Object.keys(target).sort();
  const rotated = DiscordIntake_rotateChannels(allChannels, config.maxChannelsPerPoll, props.getProperty('DISCORD_INTAKE_ROTATE'));
  const channels = rotated.channels;
  props.setProperty('DISCORD_INTAKE_ROTATE', String(rotated.nextCursor));
  const cases = CaseList_listAll().map(function (c) { return { caseId: c.caseId, caseName: c.caseName }; });
  const headers = { Authorization: 'Bot ' + token };
  let botUserId = '', botLabel = '';
  try {
    const me = UrlFetchApp.fetch(DISCORD_INTAKE_API + '/users/@me', { headers: headers, muteHttpExceptions: true });
    const code = me.getResponseCode();
    if (code === 200) { var meBody = JSON.parse(me.getContentText()); botUserId = String(meBody.id || ''); botLabel = String(meBody.username || '') + '#' + botUserId; }
    else if (code === 401 || code === 403) {
      Logger.log('DiscordIntake: 認証エラー HTTP ' + code);
      if (allChannels.length) {
        TaskLedger_appendRunLog({ caseId: '', caseName: '-', taskName: '(discord-poll)', route: 'discord', result: 'warn',
          message: 'channels=0/' + allChannels.length + ' new=0 matched=0 auth=1 errors=0',
          seconds: Math.round((new Date().getTime() - started) / 1000) });
      }
      return { ok: true, skipped: 'auth' };
    }
  } catch (e) { Logger.log('DiscordIntake users/@me: ' + e.message); }
  const deps = {
    fetch: function (url) {
      const r = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
      return { code: r.getResponseCode(), headers: r.getHeaders(), text: r.getContentText() };
    },
    sleep: function (ms) { Utilities.sleep(ms); },
    getCursor: function (ch) { return props.getProperty(DISCORD_INTAKE_CURSOR_PREFIX + ch) || ''; },
    setCursor: function (ch, id) { props.setProperty(DISCORD_INTAKE_CURSOR_PREFIX + ch, id); },
    botUserId: botUserId, cases: cases,
    resolveFixed: function (ch) { return fixedMap[ch] || null; },
    append: function (caseId, source, entry) { return ExternalNotes_append(caseId, source, entry); },
    markDirty: function (caseId, source, ref, note) { return TaskLedger_markDirty(caseId, source, ref, note); },
    log: function (m) { Logger.log(m); }
  };
  const result = { ok: true, channels: [], linked: 0, dropped: 0, auth: 0, errors: 0 };
  for (let i = 0; i < channels.length; i++) {
    let r;
    try {
      r = DiscordIntake_processChannel(channels[i], deps);
    } catch (e) {
      r = { status: 'error', error: String(e.message || e) };
      Logger.log('DiscordIntake ' + channels[i] + ': ' + r.error);
    }
    result.channels.push({ channelId: channels[i], status: r.status, fetched: r.fetched || 0, linked: r.linked || 0 });
    result.linked += r.linked || 0;
    result.dropped += r.dropped || 0;
    if (r.status === 'auth') result.auth++;
    else if (r.status !== 'ok') result.errors++;
  }
  props.setProperty('DISCORD_INTAKE_LAST_RUN', new Date().toISOString());
  if (allChannels.length) {
    TaskLedger_appendRunLog({ caseId: '', caseName: '-', taskName: '(discord-poll)', route: 'discord',
      result: result.errors || result.auth ? 'warn' : 'ok',
      message: 'channels=' + channels.length + '/' + allChannels.length + ' new=' + result.channels.reduce(function (n, c) { return n + c.fetched; }, 0) +
        ' matched=' + result.linked + ' auth=' + result.auth + ' errors=' + result.errors + ' bot=' + botLabel,
      seconds: Math.round((new Date().getTime() - started) / 1000) });
  }
  return result;
}

function DiscordIntake_status() {
  const props = PropertiesService.getScriptProperties();
  const config = (IntakeConfig_load().discord || {});
  const fixedMap = _DiscordIntake_loadSheetMap();
  Object.keys(config.channels || {}).forEach(function (id) { if (!fixedMap[id]) fixedMap[id] = config.channels[id]; });
  const target = _DiscordIntake_propertyChannels();
  Object.keys(fixedMap).forEach(function (id) { target[id] = true; });
  (config.commonChannels || []).forEach(function (id) { target[id] = true; });
  return {
    hasToken: !!props.getProperty('DISCORD_BOT_TOKEN'),
    lastRun: props.getProperty('DISCORD_INTAKE_LAST_RUN') || '',
    channels: Object.keys(target).map(function (ch) {
      return { channelId: ch, caseId: fixedMap[ch] || '(共通)', cursor: props.getProperty(DISCORD_INTAKE_CURSOR_PREFIX + ch) || '' };
    })
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DiscordIntake_matchCase: DiscordIntake_matchCase, DiscordIntake_shouldSkipMessage: DiscordIntake_shouldSkipMessage,
    DiscordIntake_processChannel: DiscordIntake_processChannel, DiscordIntake_maxId: DiscordIntake_maxId,
    DiscordIntake_normalizeName: DiscordIntake_normalizeName, DiscordIntake_autoMatch: DiscordIntake_autoMatch,
    DiscordIntake_rotateChannels: DiscordIntake_rotateChannels };
}
