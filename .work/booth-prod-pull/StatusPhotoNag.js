/** 設営日・本番日、08:00以上19:00未満(JST)の毎時通知。シートは読み取りのみ。 */
function _StatusPhotoNag_containsDate(value, today, year) {
  var text = _CaseApi_formatDate(value).normalize('NFKC').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '')
    .replace(/\d{1,2}:\d{2}(?:[〜～~–—-]\d{1,2}:\d{2})?/g, '');
  var first = _CaseApi_calendarDate(text, year);
  if (!first) return false;
  var parts = text.split(/[〜～~至]|(?<=日)[ー–—-]/);
  // ISO日付のハイフンは区切りにしない。日本語/スラッシュ表記の範囲だけ許可。
  if (parts.length === 1 && !/^\d{4}-/.test(text)) parts = text.split(/[-–—]/);
  var last = first;
  if (parts.length > 1) {
    if (parts.length !== 2) return false;
    var end = parts[1];
    if (/^\d{1,2}日?$/.test(end)) end = (first.getUTCMonth() + 1) + '/' + end.replace(/日$/, '');
    last = _CaseApi_calendarDate(end, first.getUTCFullYear());
    if (!last) return false;
    if (last < first && !/^\d{4}/.test(parts[1]) && last.getUTCMonth() < first.getUTCMonth()) {
      last = _CaseApi_calendarDate(end, first.getUTCFullYear() + 1);
    }
  }
  return !!last && today >= first && today <= last;
}

/** 全context取得は設定シート作成等を伴うため呼ばず、確定Dだけ既存シートから読む。 */
function _StatusPhotoNag_directors() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Checklist_CaseConfig');
  var map = Object.create(null);
  if (!sheet) return map;
  var rows = sheet.getDataRange().getDisplayValues(), headers = rows.shift() || [];
  var id = headers.indexOf('caseId'), name = headers.indexOf('directorName');
  if (id < 0 || name < 0) return map;
  rows.forEach(function (r) { if (r[id] && r[name]) map[r[id]] = r[name]; });
  return map;
}

function _StatusPhotoNag_people(staff, director, producer, today, year) {
  var names = [];
  if (director) names.push(director);
  (staff || []).forEach(function (s) {
    if (!s.assigned || !/ディレクター|当日D|プロデューサー|制作P|担当社員/.test(s.roleLabel || '')) return;
    if (director && /ディレクター|当日D/.test(s.roleLabel || '')) return;
    if (s.schedule && s.schedule.length && !s.schedule.some(function (day) {
      return _StatusPhotoNag_containsDate(day.date, today, year) &&
        [day.in, day.out].some(function (v) { return v && !/^(?:不要|休み|欠席|[-ー―])$/.test(String(v).trim()); });
    })) return;
    names.push(s.name);
  });
  // masterの制作Pはスタッフ表に日別指定がない場合の既存業務上の担当者。
  if (producer && !(staff || []).some(function (s) { return String(s.name || '').trim() === producer; })) names.push(producer);
  return names.map(function (n) { return String(n || '').trim(); }).filter(function (n, i, all) {
    return n && !/^(未定|未確定|未アサイン|不要)$/.test(n) && all.indexOf(n) === i;
  });
}

function StatusPhotoNag_nagPending(opts) {
  opts = opts || {};
  var now = new Date(), hour = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'HH'));
  var result = { ok: true, count: 0, sent: false, via: '', items: [], content: '', results: [], skipped: [] };
  if (hour < 8 || hour >= 19) { result.reason = '時間外'; return result; }
  var today = _CaseApi_calendarDate(Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd'));
  var configs = _StatusPhotoNag_directors(), masters = Object.create(null);
  CaseList_listAll(true).forEach(function (summary) {
    if (/(?:テスト|TEST|__DELETED)/i.test(summary.clientName + ' ' + summary.caseName)) return;
    try {
      var c = CaseList_getById(summary.caseId);
      if (!c) throw new Error('案件が見つかりません');
      var masterId = c.masterSsId || CASE_API_MASTER_SS_ID;
      if (!Object.prototype.hasOwnProperty.call(masters, masterId)) masters[masterId] = SpreadsheetApp.openById(masterId).getSheetByName('task');
      var task = masters[masterId], master = {};
      if (task) {
        var resolved = CaseApi_resolveMasterColFromSheet(task, c.clientName, c.caseName, c.masterCol, { startDate: c.startDate, endDate: c.endDate });
        if (resolved.col > 0) {
          var dates = task.getRange(4, resolved.col, 2, 1).getValues();
          master = { setupDate: dates[0][0], eventDates: dates[1][0], producer: CaseApi_resolveProducer(task, resolved.col) };
        }
      }
      var read = CaseApi_readOverview(c);
      if (read.overviewError) throw new Error('概要の読み取り失敗');
      var fields = CaseApi_constructionFields(c, read.overview || {}, master);
      var start = _CaseApi_calendarDate(c.startDate), year = start ? start.getUTCFullYear() : today.getUTCFullYear();
      var event = _StatusPhotoNag_containsDate(fields.eventDates, today, year);
      var setup = !fields.estimated && _StatusPhotoNag_containsDate(fields.setupDate, today, year);
      if (!event && !setup) return;
      var fetched = read.zissi ? StaffDrivers_fetchAll(read.zissi) : { staff: [] };
      var people = _StatusPhotoNag_people(fetched.staff, configs[c.caseId], fields.producer, today, today.getUTCFullYear());
      result.items.push({ caseId: c.caseId, caseName: c.caseName, dayType: setup ? '設営日' : '本番日', recipients: people });
    } catch (e) { result.skipped.push({ caseId: summary.caseId, reason: '案件情報の読み取り失敗' }); }
  });
  result.count = result.items.length;
  result.ok = result.skipped.length === 0;
  if (!result.count) return result;
  var config = _FeedbackRelay_config(), props = PropertiesService.getScriptProperties(), map;
  try { map = JSON.parse(props.getProperty('ASSIGN_NAG_USER_MAP') || '{}'); } catch (e) { map = {}; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
  var groups = Object.create(null);
  result.items.forEach(function (item) {
    var destinations = Object.create(null);
    (item.recipients.length ? item.recipients : ['担当者未設定']).forEach(function (name) {
      var mapped = Object.prototype.hasOwnProperty.call(map, name) && typeof map[name] === 'string' ? map[name].trim() : '';
      var id = mapped || config.dmUserId.trim();
      var via = config.botToken && id ? 'dm' : config.webhook ? 'webhook' : '';
      var key = via === 'dm' ? 'dm:' + id : via || 'none';
      if (!destinations[key]) destinations[key] = { via: via, userId: id, names: [], fallback: false };
      destinations[key].names.push(name);
      if (!mapped) destinations[key].fallback = true;
    });
    Object.keys(destinations).forEach(function (key) {
      var dest = destinations[key];
      if (!groups[key]) groups[key] = { via: dest.via, userId: dest.userId, lines: ['📸 状況写真のリマインド（毎時）'] };
      if (dest.fallback || dest.via !== 'dm') groups[key].lines.push('宛先: ' + dest.names.join(' / ') + '（Discord未同定の場合は取り次ぎをお願いします）');
      groups[key].lines.push(item.caseName + '：社長へ状況写真（3方面）と10秒以上の動画を送ってください。');
    });
  });
  result.content = Object.keys(groups).map(function (key) { return groups[key].lines.join('\n'); }).join('\n\n');
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
    result.results.push({ ok: ok, sent: sent, via: group.via, reason: ok ? '' : '通知送信失敗' });
  });
  result.ok = result.ok && result.results.every(function (r) { return r.ok; });
  result.sent = result.results.some(function (r) { return r.sent; });
  result.via = result.results.map(function (r) { return r.via; }).filter(function (v, i, all) { return v && all.indexOf(v) === i; }).join(',');
  if (result.results.some(function (r) { return r.reason; })) result.reason = result.results.filter(function (r) { return r.reason; })[0].reason;
  return result;
}

/** 同じ時間帯(JSTの yyyy/MM/dd HH)に既に走っていたら送らない。lastKey が空なら送信対象。 */
function _StatusPhotoNag_shouldSendForHour(lastKey, currentKey) {
  return !!currentKey && lastKey !== currentKey;
}

/**
 * 毎分トリガーから呼ぶ入口。専用トリガーを増やさずに「8:00以上19:00未満(JST)の毎時1回」を守る。
 * GAS のトリガー上限(20)に既に達しており StatusPhotoNag_installTrigger が失敗するため(FB27)、
 * 既存の毎分トリガー(JobQueue_worker1)の末尾から本関数を呼ぶ。
 * 走らせた時間帯は STATUS_PHOTO_NAG_LAST_HOUR に記録し、同じ時間内の再走査・再送を止める。
 */
function StatusPhotoNag_tick(opts) {
  opts = opts || {};
  var now = new Date();
  var hour = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'HH'));
  var hourKey = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH');
  var wrapper = { ok: true, skipped: true, reason: '', hourKey: hourKey };
  if (hour < 8 || hour >= 19) { wrapper.reason = '時間外'; return wrapper; }
  var props = PropertiesService.getScriptProperties();
  var last = props.getProperty('STATUS_PHOTO_NAG_LAST_HOUR') || '';
  if (opts.force !== true && !_StatusPhotoNag_shouldSendForHour(last, hourKey)) {
    wrapper.reason = '既送信'; wrapper.lastHour = last; return wrapper;
  }
  var nag = StatusPhotoNag_nagPending(opts);
  wrapper.skipped = false; wrapper.ok = nag.ok; wrapper.nag = nag;
  // 送信件数0でも「走査済み」として記録する(毎分の全案件走査を避ける)。
  if (opts.dryRun !== true) props.setProperty('STATUS_PHOTO_NAG_LAST_HOUR', hourKey);
  return wrapper;
}

function StatusPhotoNag_installTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'StatusPhotoNag_nagPending'; });
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('StatusPhotoNag_nagPending').timeBased().everyHours(1).create();
  return { ok: true, removed: existing.length, created: 1 };
}

function _debug_statusPhotoNagPreview() { return StatusPhotoNag_nagPending({ dryRun: true }); }
