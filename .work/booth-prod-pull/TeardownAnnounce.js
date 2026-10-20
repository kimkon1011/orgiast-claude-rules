/** 撤収終了までの残り時間を、各バンドに入った最初の巡回で通知する。 */
var TEARDOWN_ANNOUNCE_BANDS = [30, 15];
// 専用トリガーを張れない環境（GAS のトリガー上限 20/スクリプトに達している）向けに、
// 1分トリガーから呼ばれて5分間隔に間引くための最小間隔。起動の揺れで1回飛ばないよう余裕を持たせる。
var TEARDOWN_ANNOUNCE_TICK_MS = 4.5 * 60 * 1000;

function TeardownAnnounce_band(nowMs, removalAtMs) {
  if (!removalAtMs || !isFinite(removalAtMs) || !isFinite(nowMs)) return null;
  var left = removalAtMs - nowMs;
  if (left <= 0 || left > TEARDOWN_ANNOUNCE_BANDS[0] * 60000) return null;
  return { band: left > TEARDOWN_ANNOUNCE_BANDS[1] * 60000 ? 30 : 15, minutesLeft: Math.round(left / 60000) };
}

function TeardownAnnounce_plan(cases, nowMs, sentKeys) {
  var seen = Object.create(null), items = [];
  (cases || []).forEach(function (c) {
    if (seen[c.caseId]) return;
    seen[c.caseId] = true;
    var band = TeardownAnnounce_band(nowMs, c.removalAtMs);
    if (!band) return;
    var key = c.caseId + '|' + band.band;
    if (sentKeys && sentKeys[key]) return;
    items.push({ caseId: c.caseId, caseName: c.caseName, band: band.band, minutesLeft: band.minutesLeft, key: key });
  });
  return items;
}

function TeardownAnnounce_pruneSent(sentMap, nowMs) {
  var kept = {};
  if (!sentMap || typeof sentMap !== 'object' || Array.isArray(sentMap)) return kept;
  Object.keys(sentMap).forEach(function (key) {
    var value = sentMap[key], ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (isFinite(ms) && ms >= nowMs - 7 * 86400000) kept[key] = value;
  });
  return kept;
}

function TeardownAnnounce_message(caseName, band, minutesLeft, removalTime) {
  return caseName + '：撤収終了（搬出・ドライバー合流）まで あと約' + minutesLeft + '分（終了予定 ' + removalTime + '）';
}

/** StatusPhotoNag と同じ日別アサイン判定を、スタッフ・ドライバーにも適用する。 */
function _TeardownAnnounce_people(staff, director, producer, today, year) {
  var names = [];
  if (director) names.push(director);
  (staff || []).forEach(function (s) {
    if (!s.assigned || !/ディレクター|当日D|プロデューサー|制作P|担当社員|スタッフ|ドライバー/.test(s.roleLabel || '')) return;
    if (director && /ディレクター|当日D/.test(s.roleLabel || '')) return;
    if (s.schedule && s.schedule.length && !s.schedule.some(function (day) {
      return _StatusPhotoNag_containsDate(day.date, today, year) &&
        [day.in, day.out].some(function (v) { return v && !/^(?:不要|休み|欠席|[-ー―])$/.test(String(v).trim()); });
    })) return;
    names.push(s.name);
  });
  if (producer && !(staff || []).some(function (s) { return String(s.name || '').trim() === producer; })) names.push(producer);
  return names.map(function (n) { return String(n || '').trim(); }).filter(function (n, i, all) {
    return n && !/^(未定|未確定|未アサイン|不要)$/.test(n) && all.indexOf(n) === i;
  });
}

function TeardownAnnounce_sweep(opts) {
  opts = opts || {};
  var nowMs = opts.nowMs || Date.now(), now = new Date(nowMs);
  var result = { ok: true, count: 0, sent: false, via: '', reason: '', items: [], content: '', results: [], skipped: [], truncated: false };
  var hour = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'HH'));
  if (hour < 6 || hour >= 23) { result.reason = '時間外'; return result; }
  var today = _CaseApi_calendarDate(Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd'));
  var date = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd'), year = today.getUTCFullYear();
  var summaries = CaseList_listAll(true), candidates = [], seen = Object.create(null);
  // 案件一覧の日付だけで絞り、実施計画を開くのは最大20件に制限する。
  for (var i = 0; i < summaries.length; i++) {
    var summary = summaries[i];
    if (/(?:テスト|TEST|__DELETED)/i.test(summary.clientName + ' ' + summary.caseName) || seen[summary.caseId]) continue;
    seen[summary.caseId] = true;
    var start = _CaseApi_calendarDate(summary.startDate, year);
    var end = _CaseApi_calendarDate(summary.endDate || summary.startDate, year);
    // 撤収日は会期最終日の翌日になることがあるため、終了側だけ1日の余裕を持たせる。
    // 実際の撤収日判定は _ES_source の撤去日で行うので、ここは絞り込みの粗さでよい。
    if (end) { end = new Date(end.getTime()); end.setUTCDate(end.getUTCDate() + 1); }
    if (!start || !end || today < start || today > end) continue;
    if (candidates.length >= 20) { result.truncated = true; break; }
    candidates.push(summary);
  }
  var cases = [], sources = Object.create(null);
  candidates.forEach(function (summary) {
    try {
      var source = _ES_source(summary.caseId), input = source.input;
      if (input.removalDate !== date) return;
      if (!input.removalTime) { result.skipped.push({ caseId: summary.caseId, reason: '撤去時刻不明' }); return; }
      var at = Date.parse(input.removalDate + 'T' + input.removalTime + ':00+09:00');
      if (!isFinite(at)) { result.skipped.push({ caseId: summary.caseId, reason: '撤去日時不正' }); return; }
      cases.push({ caseId: summary.caseId, caseName: summary.caseName, removalAtMs: at });
      sources[summary.caseId] = source;
    } catch (e) { result.skipped.push({ caseId: summary.caseId, reason: '案件情報の読み取り失敗' }); }
  });
  var props = PropertiesService.getScriptProperties(), sentMap, map;
  try { sentMap = JSON.parse(props.getProperty('TEARDOWN_ANNOUNCE_SENT') || '{}'); } catch (e) { sentMap = {}; }
  sentMap = TeardownAnnounce_pruneSent(sentMap, nowMs);
  var planned = TeardownAnnounce_plan(cases, nowMs, sentMap);
  if (!planned.length) { result.ok = result.skipped.length === 0; return result; }
  var config = _FeedbackRelay_config(), directors = _StatusPhotoNag_directors();
  try { map = JSON.parse(props.getProperty('ASSIGN_NAG_USER_MAP') || '{}'); } catch (e) { map = {}; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
  var groups = Object.create(null), itemGroups = Object.create(null);
  planned.forEach(function (item) {
    var source = sources[item.caseId];
    try {
      var fetched = source.c.zissiId ? StaffDrivers_fetchAll(source.c.zissiId) : { staff: [] };
      item.recipients = _TeardownAnnounce_people(fetched.staff, directors[item.caseId], source.input.producer, today, year);
    } catch (e) { result.skipped.push({ caseId: item.caseId, reason: 'スタッフ情報の読み取り失敗' }); return; }
    item.removalTime = source.input.removalTime;
    result.items.push(item);
    itemGroups[item.key] = [];
    var destinations = Object.create(null);
    (item.recipients.length ? item.recipients : ['担当者未設定']).forEach(function (name) {
      var mapped = Object.prototype.hasOwnProperty.call(map, name) && typeof map[name] === 'string' ? map[name].trim() : '';
      var id = mapped || String(config.dmUserId || '').trim();
      var via = config.botToken && id ? 'dm' : config.webhook ? 'webhook' : '';
      var key = via === 'dm' ? 'dm:' + id : via || 'none';
      if (!destinations[key]) destinations[key] = { via: via, userId: id, names: [], fallback: false };
      destinations[key].names.push(name);
      if (!mapped) destinations[key].fallback = true;
    });
    Object.keys(destinations).forEach(function (key) {
      var dest = destinations[key];
      if (!groups[key]) groups[key] = { via: dest.via, userId: dest.userId, lines: ['⏰ 撤収終了のアナウンス'], delivered: false };
      if (dest.fallback || dest.via !== 'dm') groups[key].lines.push('宛先: ' + dest.names.join(' / ') + '（Discord未同定の場合は取り次ぎをお願いします）');
      groups[key].lines.push(TeardownAnnounce_message(item.caseName, item.band, item.minutesLeft, item.removalTime));
      itemGroups[item.key].push(key);
    });
  });
  result.count = result.items.length;
  result.ok = result.skipped.length === 0;
  result.content = Object.keys(groups).map(function (key) { return groups[key].lines.join('\n'); }).join('\n\n');
  result.via = Object.keys(groups).map(function (key) { return groups[key].via; }).filter(function (v, i, all) { return v && all.indexOf(v) === i; }).join(',');
  if (opts.dryRun === true) return result;
  Object.keys(groups).forEach(function (key) {
    var group = groups[key], sent = false, ok = true;
    if (!group.via) { result.results.push({ ok: true, sent: false, via: '', reason: '通知先未設定' }); return; }
    (group.lines.join('\n').match(/[\s\S]{1,1900}/g) || []).forEach(function (chunk) {
      var delivered = false;
      try {
        delivered = group.via === 'dm' ? _FeedbackRelay_postDm(config.botToken, group.userId, chunk) === true
          : _FeedbackRelay_postWebhook(config.webhook, chunk) === true;
      } catch (e) { delivered = false; }
      sent = sent || delivered; ok = ok && delivered;
    });
    group.delivered = ok;
    result.results.push({ ok: ok, sent: sent, via: group.via, reason: ok ? '' : '通知送信失敗' });
  });
  // 分割された本文・複数宛先の全てに届いた案件だけを送信済みにする。
  result.items.forEach(function (item) {
    if (itemGroups[item.key].every(function (key) { return groups[key].delivered; })) sentMap[item.key] = now.toISOString();
  });
  props.setProperty('TEARDOWN_ANNOUNCE_SENT', JSON.stringify(sentMap));
  result.ok = result.ok && result.results.every(function (r) { return r.ok; });
  result.sent = result.results.some(function (r) { return r.sent; });
  if (result.results.some(function (r) { return r.reason; })) result.reason = result.results.filter(function (r) { return r.reason; })[0].reason;
  return result;
}

/**
 * 1分トリガー(processCommandQueue)から呼ばれる入口。TEARDOWN_ANNOUNCE_TICK_MS 未満の連続呼び出しは
 * 何もせず返す。専用の5分トリガーを張れる状況なら TeardownAnnounce_installTrigger() を使ってよい。
 */
function TeardownAnnounce_tick(opts) {
  opts = opts || {};
  var nowMs = opts.nowMs || Date.now();
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('TEARDOWN_ANNOUNCE_TICK_AT') || 0);
  if (!(nowMs - last >= TEARDOWN_ANNOUNCE_TICK_MS)) return { ok: true, reason: '間隔外' };
  props.setProperty('TEARDOWN_ANNOUNCE_TICK_AT', String(nowMs));
  return TeardownAnnounce_sweep({ nowMs: nowMs, dryRun: opts.dryRun === true });
}

function TeardownAnnounce_installTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'TeardownAnnounce_sweep'; });
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('TeardownAnnounce_sweep').timeBased().everyMinutes(5).create();
  return { ok: true, removed: existing.length, created: 1 };
}
