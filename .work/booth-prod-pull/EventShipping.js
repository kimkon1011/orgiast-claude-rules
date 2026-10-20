/** イベント開催登録。既定 off。入力・送信状態は案件一覧SSの専用シートに保存。 */
var _ES_RESPONSE_SS = '1aQZTd4bHc86KjgU66GZdFEeO7DvR4kb5BEXJxpqtfq0';
var _ES_RESPONSE_GID = 1836673925;
var _ES_ROOM = '1382599503479312384';
var _ES_GUILD = '715211007307284530';
var _ES_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLScEeR-fUCAd3iSMFjp_UTiWJczGO_qzQRmiGUucc-JD6J905g/formResponse';
var _ES_STATE = 'EventShipping状態';

function _ES_prop(key) { return PropertiesService.getScriptProperties().getProperty(key) || ''; }
function _ES_mode(opts) {
  var configured = _ES_prop('EVENT_SHIPPING_MODE') || 'off';
  if (['off', 'test', 'live'].indexOf(configured) < 0) {
    console.error('EVENT_SHIPPING_MODE が不正なため off として停止');
    return 'off';
  }
  if (configured === 'off') return 'off';
  var mode = (opts && opts.mode) || configured;
  if (['off', 'test', 'live'].indexOf(mode) < 0) {
    console.error('EVENT_SHIPPING_MODE オプションが不正なため off として停止');
    return 'off';
  }
  return mode;
}
// 外部書込み直前にも呼ぶ。処理途中のモード変更では再実行を必要とする。
// configured はフォーム開始時の設定。opts による明示モード指定は維持する。
function _ES_assertSend(discord, configured) {
  var current = _ES_mode();
  if (current === 'off' || (discord && current !== 'live') ||
      (configured && current !== configured)) {
    var error = new Error('mode=' + current + '（送信停止）');
    error.shippingModeStopped = true;
    error.shippingNotSent = true;
    throw error;
  }
}
function _ES_skipDiscord(mode) {
  var reason = mode === 'test' ? 'test なので Discord 操作をスキップした' : 'mode=off';
  console.log(reason);
  return { ok: true, skipped: true, reason: reason, warnings: [] };
}

function _ES_read(key) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(_ES_STATE);
  if (!sheet) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (rows[i][0] === key) return JSON.parse(rows[i][1]);
  return null;
}
// 呼出元でスクリプトロックを保持する。
function _ES_write(key, data) {
  var ss = SpreadsheetApp.getActive(), sheet = ss.getSheetByName(_ES_STATE);
  if (!sheet) { sheet = ss.insertSheet(_ES_STATE); sheet.appendRow(['キー', 'JSON', '更新日時']); }
  var rows = sheet.getDataRange().getValues(), row = rows.length + 1;
  for (var i = 1; i < rows.length; i++) if (rows[i][0] === key) { row = i + 1; break; }
  var json = JSON.stringify(data);
  sheet.getRange(row, 1, 1, 3).setValues([[key, json, new Date()]]);
  SpreadsheetApp.flush();
  if (sheet.getRange(row, 2).getValue() !== json) throw new Error('発送状態の read-back verify 失敗');
}
function EventShipping_saveInput(caseId, payload) {
  if (!CaseList_getById(caseId)) throw new Error('案件がありません: ' + caseId);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var input = _ES_read('input:' + caseId) || {};
    ['dateStatus', 'eventType', 'moveInDate', 'producerEmail', 'itemListUrl', 'removalDate',
      'projectCode', 'logisticsPlanUrl', 'removalTime', 'area', 'venue', 'venueAddress', 'producer', 'designer'].forEach(function (key) {
      if (payload && Object.prototype.hasOwnProperty.call(payload, key)) input[key] = String(payload[key] || '').trim();
    });
    _ES_write('input:' + caseId, input);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function _ES_date(value) {
  if (value instanceof Date) value = Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  var m = String(value || '').match(/^(\d{4})[年/\-](\d{1,2})[月/\-](\d{1,2})(?:日|\b)/);
  if (!m) return '';
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return '';
  return d.toISOString().slice(0, 10);
}
function _ES_add(date, days) { var d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function _ES_person(name) { return String(name || '').replace(/^\s*(?:制作)?[PDＰＤ]\s*[：:]?\s*/, '').trim(); }
function _ES_source(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件がありません: ' + caseId);
  var input = _ES_read('input:' + caseId) || {}, warnings = [];
  if (c.masterSsId && c.masterCol) {
    var sheet = SpreadsheetApp.openById(c.masterSsId).getSheetByName('task');
    if (!sheet) throw new Error('master task がありません');
    var head = sheet.getRange(1, c.masterCol, 8, 3).getValues();
    input.area = String(input.area || head[2][0] || '');
    input.venue = String(input.venue || head[2][1] || '');
    input.producer = String(input.producer || head[7][0] || '');
    input.designer = String(input.designer || head[7][1] || '');
  }
  var code = '', itemUrl = '', planUrl = '';
  if (c.zissiId) {
    var zissi = SpreadsheetApp.openById(c.zissiId);
    var match = zissi.getName().match(/(?:^|[^0-9A-Za-z])(\d{6}[A-Za-z]+)(?=$|[^0-9A-Za-z])/);
    code = match ? match[1] : '';
    var item = zissi.getSheetByName('アイテムリスト');
    var plan = zissi.getSheetByName('搬入出計画');
    if (item) itemUrl = PanelLinks_sheetUrl(zissi, item);
    if (plan) planUrl = PanelLinks_sheetUrl(zissi, plan);
    var extracted = _ES_planFields(zissi, warnings);
    Object.keys(extracted).forEach(function (key) { if (!input[key]) input[key] = extracted[key]; });
    code = code || extracted.projectCode || '';
    itemUrl = itemUrl || extracted.itemListUrl || '';
    planUrl = planUrl || extracted.logisticsPlanUrl || '';
  }
  code = code || input.projectCode || '';
  itemUrl = itemUrl || input.itemListUrl || '';
  planUrl = planUrl || input.logisticsPlanUrl || '';
  if (!input.area && input.venueAddress) {
    var prefecture = input.venueAddress.match(/東京都|北海道|(?:京都|大阪)府|.{2,3}県/);
    if (prefecture) input.area = prefecture[0];
  }
  if (!planUrl) warnings.push('搬入出計画シートURLを取得できません');
  return { c: c, input: input, code: code, itemUrl: itemUrl, planUrl: planUrl, warnings: warnings };
}
// セル位置は推測しない。明示ラベルの直後の値だけを読み、矛盾する値は採用しない。
function _ES_planFields(ss, warnings) {
  var labels = {
    '会場住所': 'venueAddress', '会場所在地': 'venueAddress',
    '撤去日': 'removalDate', '撤去時刻': 'removalTime', '撤去日時': 'removalDateTime',
    '搬入日': 'moveInDate', 'プロジェクトコード': 'projectCode',
    'アイテムリストURL': 'itemListUrl', '搬入出計画URL': 'logisticsPlanUrl'
  }, found = {}, result = {};
  ['summary', '概要', '搬入出計画'].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var rows = sheet.getDataRange().getDisplayValues();
    // Phase2_OperationsPlan の21行目以降はAI生成本文。確定値として読み戻さない。
    if (name === '搬入出計画') rows = rows.slice(0, 20);
    rows.forEach(function (row) {
      row.forEach(function (cell, i) {
        var label = String(cell || '').normalize('NFKC').replace(/[\s:：]/g, ''), key = labels[label];
        if (!key) return;
        // 結合セルの空白を越える場合も、同じ行の最初の非空セルだけを見る。
        var value = '';
        for (var j = i + 1; j < row.length; j++) if (String(row[j] || '').trim()) { value = String(row[j]).normalize('NFKC').trim(); break; }
        if (!value || labels[value.replace(/[\s:：]/g, '')]) return;
        function add(k, v) { if (v) { found[k] = found[k] || []; if (found[k].indexOf(v) < 0) found[k].push(v); } }
        if (key === 'removalDateTime') {
          add('removalDate', _ES_date(value));
          var time = value.match(/(?:日|\s|T)([0-2]?\d:[0-5]\d)(?:$|\s)/);
          if (time && +time[1].split(':')[0] < 24) add('removalTime', time[1].padStart(5, '0'));
        } else if (key === 'removalDate' || key === 'moveInDate') add(key, _ES_date(value));
        else if (key === 'removalTime') { if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value)) add(key, value.padStart(5, '0')); }
        else if (key === 'projectCode') { if (/^\d{6}[A-Za-z]+$/.test(value)) add(key, value); }
        else if (/Url$/.test(key)) { if (/^https:\/\/\S+$/.test(value)) add(key, value); }
        else add(key, value);
      });
    });
  });
  Object.keys(found).forEach(function (key) {
    if (found[key].length === 1) result[key] = found[key][0];
    else warnings.push('実施計画の値が競合: ' + key);
  });
  return result;
}
function _ES_returnDate(date, local, time, warnings) {
  if (!date) return '';
  if (local) {
    var m = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) { warnings.push('撤去時刻不明のため返却予定日は翌日'); return _ES_add(date, 1); }
    return _ES_add(date, +m[1] * 60 + +m[2] <= 780 ? 0 : 1);
  }
  var holidays = {}, calendar;
  try {
    calendar = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
    if (!calendar) throw new Error('日本の祝日カレンダーがありません');
    calendar.getEvents(new Date(date + 'T00:00:00+09:00'), new Date(_ES_add(date, 40) + 'T00:00:00+09:00')).forEach(function (e) {
      holidays[Utilities.formatDate(e.getStartTime(), 'Asia/Tokyo', 'yyyy-MM-dd')] = true;
    });
  } catch (e) { throw new Error('祝日取得不可のため返却予定日を確定できず発送停止: ' + String(e.message || e)); }
  var count = 0, next = date;
  for (var i = 0; i < 40 && count < 2; i++) {
    next = _ES_add(next, 1);
    var day = new Date(next + 'T00:00:00Z').getUTCDay();
    if (day !== 0 && day !== 6 && !holidays[next]) count++;
  }
  if (count !== 2) throw new Error('返却予定日を計算できません');
  return next;
}
function EventShipping_buildPayload(caseId, opts) {
  var s = _ES_source(caseId), p = s.input, warnings = s.warnings, missing = [];
  var region = p.area + ' ' + p.venue + ' ' + (p.venueAddress || '');
  var local = /東京|千葉|埼玉/.test(region);
  var moveIn = _ES_date(p.moveInDate), removal = _ES_date(p.removalDate);
  var notes = s.planUrl ? '-------------------------------\n■搬入出計画：' + s.planUrl + '\n-------------------------------' : '';
  if (local) notes += '\n確定MTGで判断するため後日判断';
  if (/小間|ブース\s*(?:番号|No[.．]?|[A-Z]?\d)/i.test(region)) notes += '\n発送荷物には備品シール256　配送業者向けお願いシールシートの貼り付けをお願いいたします';
  var values = {
    emailAddress: _ES_mode(opts) === 'test' ? (_ES_prop('EVENT_SHIPPING_TEST_EMAIL') || Session.getActiveUser().getEmail()) : (p.producerEmail || ''),
    'entry.1859301085': s.code,
    'entry.1535079389': p.eventType || '',
    'entry.703864926': '「-」',
    'entry.14566595': s.c.clientName,
    'entry.1526132716': _ES_date(s.c.startDate),
    'entry.587075988': p.dateStatus || '仮',
    'entry.1632051127': moveIn ? _ES_add(moveIn, -1) : '',
    'entry.853815232': s.itemUrl || p.itemListUrl || '',
    'entry.1685872457': _ES_person(p.producer),
    'entry.612910910': notes.trim(), 'entry.735457817': '',
    'entry.340525760': _ES_returnDate(removal, local, p.removalTime, warnings),
    'entry.1714948167': local ? '' : '会場保管'
  };
  [['entry.1535079389', 'イベント種類'], ['entry.853815232', 'アイテムリストURL'], ['entry.1685872457', '担当者名'],
    ['entry.1859301085', 'プロジェクトコード'], ['emailAddress', '制作Pのメールアドレス'],
    ['entry.1526132716', '本番日付']].forEach(function (pair) { if (!values[pair[0]]) missing.push(pair[1]); });
  if (values['entry.1535079389'] && ['学会', '上場の鐘', 'イベント', 'reブース'].indexOf(values['entry.1535079389']) < 0) missing.push('イベント種類（選択肢不正）');
  if (['仮', '確定'].indexOf(values['entry.587075988']) < 0) missing.push('仮/確定（選択肢不正）');
  if (values.emailAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.emailAddress)) missing.push('制作Pのメールアドレス（形式不正）');
  if (values['entry.853815232'] && (!/^https:\/\//.test(values['entry.853815232']) || /1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI/.test(values['entry.853815232']))) missing.push('アイテムリストURL（task不可）');
  if (!moveIn) warnings.push('搬入日未入力または不正: 到着指定日なし');
  if (!removal) warnings.push('撤去日未入力または不正: 返却予定日なし');
  if (!String(p.area || '').trim()) { missing.push('会場地域'); values['entry.340525760'] = ''; values['entry.1714948167'] = ''; }
  return { values: values, missing: missing, warnings: warnings };
}
function _ES_jsonProp(key) { return JSON.parse(_ES_prop(key) || '{}'); }
function _ES_channelName(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/株式会社|有限会社|合同会社|一般社団法人|公益社団法人|一般財団法人|公益財団法人|\(株\)|\(有\)|\(同\)/g, '')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}
function _ES_channelMatches(channels, c, code, input) {
  var client = _ES_channelName(c.clientName), event = _ES_channelName(String(c.caseName || '').split(/ [\/／] /)[0]);
  var normalizedCode = _ES_channelName(code);
  var locations = String(c.caseName || '').split(/ [\/／] /).slice(1);
  input = input || {};
  [input.area, input.venue].forEach(function (v) { if (v) locations.push(v); });
  locations = locations.map(_ES_channelName).filter(function (v, i, all) { return v && all.indexOf(v) === i; });
  return channels.filter(function (ch) {
    if ([0, 5].indexOf(ch.type) < 0 || !/^\d{17,20}$/.test(String(ch.id))) return false;
    var name = _ES_channelName(ch.name);
    // コードがあるチャンネルを別案件の社名・展示会名で拾わない。
    var codes = String(ch.name || '').normalize('NFKC').match(/\d{6,}[a-z]+/gi) || [];
    if (codes.length) return !!normalizedCode && codes.every(function (v) { return v.toLowerCase() === normalizedCode; });
    // 同一社の別案件を避けるため、コード無しは社名と展示会名の両方が必要。
    if (!_ES_channelName(input.area) || client.length < 2 || event.length < 2 || !locations.length) return false;
    // 全ての地域・会場が一致し、余分な識別語も無い場合だけ採用する。
    // 別地域の併記や不足情報は取りこぼし側に倒す。
    var parts = [client, event].concat(locations).filter(function (v, i, all) { return all.indexOf(v) === i; });
    if (!parts.every(function (v) { return name.indexOf(v) >= 0; })) return false;
    parts.sort(function (a, b) { return b.length - a.length; });
    var remainder = name;
    parts.forEach(function (v) { remainder = remainder.split(v).join(''); });
    return !remainder;
  });
}
// lockHeld=true は submit/relay の既存スクリプトロック内からだけ使う。
function _ES_destination(caseId, lockHeld) {
  var lock;
  if (!lockHeld) { lock = LockService.getScriptLock(); lock.waitLock(30000); }
  try {
    var c = CaseList_getById(caseId);
    if (!c) throw new Error('案件がありません: ' + caseId);
    var channels = [], candidates = [], failure = '', code = '', input = {};
    try { var source = _ES_source(caseId); code = source.code; input = source.input; }
    catch (e) { failure = '案件情報取得失敗'; }
    var fingerprint = JSON.stringify([c.clientName, c.caseName, c.zissiId, code, input.area || '', input.venue || '']);
    var warehouse = _ES_prop('DISCORD_WAREHOUSE_CHANNEL_ID') || '1383253163729223872';
    var cached = _ES_read('channel:' + caseId);
    if (!failure && cached && cached.fingerprint === fingerprint && /^\d{17,20}$/.test(cached.id) && cached.id !== warehouse && cached.id !== _ES_ROOM) {
      try {
        var current = _ES_api('/channels/' + cached.id);
        if (current && current.id === cached.id && _ES_channelMatches([current], c, code, input).length === 1) return { id: cached.id, note: '', kind: 'case', caseId: caseId };
      } catch (e) { failure = 'キャッシュ先の現在名取得失敗'; }
      // 改名・取得失敗時は古い宛先を再利用しない。取得失敗は制作へ退避。
      _ES_write('channel:' + caseId, {});
    }
    try {
      channels = _ES_api('/guilds/' + _ES_GUILD + '/channels');
      if (!Array.isArray(channels)) throw new Error('チャンネル一覧の形式不正');
      candidates = failure ? [] : _ES_channelMatches(channels, c, code, input);
    } catch (e) { channels = []; candidates = []; failure = 'チャンネル一覧取得失敗'; }
    if (candidates.length === 1 && candidates[0].id !== warehouse && candidates[0].id !== _ES_ROOM) {
      _ES_write('channel:' + caseId, { id: candidates[0].id, name: candidates[0].name, fingerprint: fingerprint });
      return { id: candidates[0].id, note: '', kind: 'case', caseId: caseId };
    }
    var production = _ES_prop('EVENT_SHIPPING_PRODUCTION_CHANNEL_ID');
    if (!production) {
      var known = _ES_read('channel:production');
      if (known && known.id) {
        try {
          _ES_validateDestination(known.id, { kind: 'production' });
          production = known.id;
        } catch (e) { _ES_write('channel:production', {}); }
      }
      if (!production) {
        var matches = channels.filter(function (ch) {
          return [0, 5].indexOf(ch.type) >= 0 && ['制作', '制作チャンネル'].indexOf(_ES_channelName(ch.name)) >= 0;
        });
        if (matches.length === 1 && /^\d{17,20}$/.test(String(matches[0].id)) && matches[0].id !== warehouse && matches[0].id !== _ES_ROOM) {
          production = matches[0].id;
          _ES_write('channel:production', { id: production, name: matches[0].name });
        }
      }
    }
    if (!/^\d{17,20}$/.test(String(production)) || production === warehouse || production === _ES_ROOM) {
      throw new Error('案件・制作チャンネルを一意に特定できないため送信停止: ' + caseId);
    }
    return { id: production, kind: 'production', caseId: caseId, note: '案件チャンネルを特定できなかったので制作チャンネルに送った。\n案件名: ' +
      c.clientName + ' / ' + c.caseName + '\n候補チャンネル名: ' +
      (candidates.map(function (ch) { return ch.name; }).join('、') || 'なし') + (failure ? '（' + failure + '）' : '') + '\n' };
  } finally { if (lock) lock.releaseLock(); }
}
// メッセージPOSTの唯一の検証口。保存IDや一覧取得時の名前を送信の根拠にしない。
function _ES_validateDestination(id, destination, fetchCurrent) {
  if (!destination) throw new Error('Discord 宛先の用途未指定');
  var current = fetchCurrent ? fetchCurrent(id) : _ES_api('/channels/' + id);
  if (!current || current.id !== id) throw new Error('Discord 現在の宛先を確認できません');
  if (destination.kind === 'warehouse') {
    // 運用記録で確認した名称のみ許可。部分一致では別案件への転用を見逃す。
    var warehouseId = _ES_prop('DISCORD_WAREHOUSE_CHANNEL_ID') || '1383253163729223872';
    if (id === warehouseId && current.type === 0 && current.guild_id === _ES_GUILD &&
        String(current.name || '').normalize('NFKC').trim() === '倉庫リーダー情報伝達グループ') return;
  } else if (destination.kind === 'dm') {
    if (current.type === 1 && Array.isArray(current.recipients) && current.recipients.length === 1 &&
        current.recipients[0].id === destination.userId) return;
  } else if ([0, 5].indexOf(current.type) >= 0 && (!current.guild_id || current.guild_id === _ES_GUILD)) {
    var name = _ES_channelName(current.name);
    if (destination.kind === 'room' && id === _ES_ROOM && name === _ES_channelName('イベントアイテム発送ルーム')) return;
    var warehouse = _ES_prop('DISCORD_WAREHOUSE_CHANNEL_ID') || '1383253163729223872';
    if (id !== warehouse && id !== _ES_ROOM) {
      if (destination.kind === 'production' && ['制作', '制作チャンネル'].indexOf(name) >= 0) return;
      if (destination.kind === 'case') {
        var source = _ES_source(destination.caseId);
        if (_ES_channelMatches([current], source.c, source.code, source.input).length === 1) return;
      }
    }
  }
  throw new Error('Discord 宛先の現在名・用途が不一致のため送信停止: ' + id);
}
function _ES_api(path, method, body, destination) {
  var options;
  try {
    var token = _ES_prop('DISCORD_BOT_TOKEN');
    if (!token) throw new Error('DISCORD_BOT_TOKEN 未設定');
    options = { method: method || 'get', headers: { Authorization: 'Bot ' + token }, muteHttpExceptions: true };
    if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
    if (options.method.toLowerCase() !== 'get') _ES_assertSend(true);
    if (options.method.toLowerCase() === 'post') {
      var messagePath = path.match(/^\/channels\/([^/]+)\/messages$/);
      if (messagePath) _ES_validateDestination(messagePath[1], destination);
    }
    if (options.method.toLowerCase() !== 'get') _ES_assertSend(true);
  } catch (e) { e.shippingNotSent = true; throw e; }
  // ここから先の失敗は送信済みの可能性がある。shippingNotSent を付けない。
  var response = UrlFetchApp.fetch('https://discord.com/api/v10' + path, options);
  var code = response.getResponseCode(), result = {};
  if (code >= 200 && code < 300) { var text = response.getContentText(); result = text ? JSON.parse(text) : {}; }
  else { var error = new Error('Discord HTTP ' + code + ' ' + path); error.code = code; throw error; }
  return result;
}
function _ES_post(channel, content, mentions, destination) {
  if (!channel) throw new Error('Discord 送信先未設定');
  _ES_assertSend(true);
  return _ES_api('/channels/' + channel + '/messages', 'post', { content: content, allowed_mentions: { parse: [], users: mentions || [] } }, destination);
}
function _ES_notify(caseId, reason, lockHeld, mode) {
  try {
    var effective = _ES_mode(mode ? { mode: mode } : null);
    if (effective !== 'live') return _ES_skipDiscord(effective);
    var destination = _ES_destination(caseId, lockHeld);
    _ES_post(destination.id,
      (destination.note + 'イベント開催登録 ' + caseId + ': ' + String(reason).replace(/[\r\n]+/g, ' ')).slice(0, 1900), [], destination);
    return { ok: true };
  } catch (e) { console.error('イベント開催登録 通知失敗: ' + e.message); return { ok: false, reason: e.message, notSent: !!e.shippingNotSent || !destination }; }
}
function _ES_notifyOnce(caseId, reason, key, state, mode) {
  if (state && state.errorNotified) return { ok: true, skipped: true };
  if (state) { state.errorNotified = true; _ES_write(key, state); }
  var result = _ES_notify(caseId, reason, true, mode);
  if (state && (result.skipped || result.notSent)) {
    state.errorNotified = false; _ES_write(key, state);
  }
  return result;
}
// ファイル名はタブ名ではない。gid優先でも、フォーム回答のヘッダーを必ず検証する。
function _ES_responseHeadersMatch(sheet) {
  var width = sheet.getLastColumn();
  if (!width || !sheet.getLastRow()) return false;
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  var questions = ['案件名（プロジェクトコードのみ）', 'イベント種類', 'アイテムリストのURL'];
  return headers.indexOf('タイムスタンプ') >= 0 && questions.filter(function (label) {
    return headers.indexOf(label) >= 0;
  }).length >= 2;
}
function _ES_responseSheet() {
  var ss;
  try { ss = SpreadsheetApp.openById(_ES_RESPONSE_SS); }
  catch (e) { throw new Error('回答ブックにアクセスできない（共有が切れた可能性）: ' + _ES_RESPONSE_SS + ' / ' + String(e.message || e)); }
  var sheets = ss.getSheets();
  var inventory = sheets.map(function (sheet) { return sheet.getName() + ' (gid=' + sheet.getSheetId() + ')'; }).join('、');
  function fail(reason) {
    throw new Error('回答シートを特定できません: ' + reason + '。全タブ: ' + (inventory || '（なし）'));
  }
  var gid = Number(_ES_prop('EVENT_SHIPPING_RESPONSE_GID') || _ES_RESPONSE_GID);
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() !== gid) continue;
    if (!_ES_responseHeadersMatch(sheets[i])) fail('指定gid=' + gid + 'のヘッダーがフォームの質問と一致しません');
    return sheets[i];
  }
  var candidates = sheets.filter(_ES_responseHeadersMatch);
  if (candidates.length !== 1) fail('gid=' + gid + 'がなく、ヘッダー一致候補が' + candidates.length + '件');
  return candidates[0];
}
// 数式の空文字は回答ではない。getLastRow は1列走査の上限にだけ使う。
function _ES_responseExtent(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  var timestamp = headers.indexOf('タイムスタンプ');
  if (timestamp < 0) throw new Error('回答シートのタイムスタンプ見出しが一致しません');
  var upper = sheet.getLastRow();
  var timestamps = upper > 1 ? sheet.getRange(2, timestamp + 1, upper - 1, 1).getValues() : [];
  var lastRow = 1;
  for (var i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i][0] !== '' && timestamps[i][0] != null) { lastRow = i + 2; break; }
  }
  return { headers: headers, timestamps: timestamps, lastRow: lastRow };
}
function _ES_verify(sheet, record) {
  var extent = _ES_responseExtent(sheet), headers = extent.headers;
  function column(label) { return headers.indexOf(label); }
  var project = column('案件名（プロジェクトコードのみ）'), email = column('メールアドレス');
  if (project < 0 || email < 0) throw new Error('回答シートの案件名/メール見出しが一致しません');
  if (extent.lastRow < 2 || !record.project || !record.email) return 0;
  // 旧記録の beforeRow=131 等は実データ末尾に補正し、手前10行も候補に含める。
  var before = Number(record.beforeRow);
  if (!isFinite(before) || before < 1) before = 1;
  var startRow = Math.max(2, Math.min(Math.floor(before), extent.lastRow) - 9);
  // 一意性は候補範囲外も含めて確認する。全列ではなく照合キー2列だけを読む。
  var projects = sheet.getRange(2, project + 1, extent.lastRow - 1, 1).getValues();
  var emails = sheet.getRange(2, email + 1, extent.lastRow - 1, 1).getValues();
  var match = 0;
  for (var i = 0; i < projects.length; i++) {
    if (extent.timestamps[i][0] === '' || extent.timestamps[i][0] == null) continue;
    if (String(projects[i][0]) !== record.project || String(emails[i][0]) !== record.email) continue;
    if (match) throw new Error('回答シートの照合キーが複数行に一致。一意に特定できないため自動再送はしません');
    match = i + 2;
  }
  if (!match || match < startRow) return 0;
  var row = sheet.getRange(match, 1, 1, headers.length).getValues()[0];
  var dates = { '本番日付': 'entry.1526132716', '到着指定日': 'entry.1632051127', '倉庫への荷物返却予定日': 'entry.340525760' };
  var valid = true;
  Object.keys(dates).forEach(function (label) {
    var expected = record.values[dates[label]];
    if (expected && (column(label) < 0 || _ES_date(row[column(label)]) !== expected)) valid = false;
  });
  if (!valid) throw new Error('回答行 ' + match + ' の日付が不一致。自動再送はしません');
  return match;
}
// ロック内で照合のみ行う。HTTP成功と回答確認を分離し、再POSTはしない。
function _ES_confirm(key, record, scheduled) {
  if (record.status === 'sent' || record.status === 'confirmed') {
    return { ok: true, confirmed: true, skipped: true, responseRow: record.responseRow };
  }
  var row = 0, reason = '';
  try { row = _ES_verify(_ES_responseSheet(), record); }
  catch (e) { reason = String(e.message || e); }
  if (row) {
    record.status = 'confirmed'; record.confirmed = true;
    record.responseRow = row; record.confirmedAt = new Date().toISOString();
    delete record.confirmationError;
    _ES_write(key, record);
    return { ok: true, confirmed: true, recovered: true, responseRow: row };
  }
  record.confirmationError = reason || '回答シートに未反映';
  var now = Date.now();
  // トリガの重複発火や手動照合で約1時間の猶予を短縮しない。
  if (scheduled && now - new Date(record.lastCheckedAt || record.sentAt).getTime() >= 10 * 60 * 1000) {
    record.confirmationAttempts = (record.confirmationAttempts || 0) + 1;
    record.lastCheckedAt = new Date(now).toISOString();
  }
  _ES_write(key, record);
  var failed = (record.confirmationAttempts || 0) >= 6;
  var result = { ok: !failed && record.status === 'sent-unconfirmed', confirmed: false,
    status: record.status, reason: record.confirmationError };
  if (failed) {
    result.ok = false;
    result.reason = '回答確認失敗（6回以上未確認・再送禁止）: ' + record.confirmationError;
    if (scheduled) result.notification = _ES_notifyOnce(record.caseId, result.reason, key, record, record.mode);
  }
  return result;
}
// 既存10分トリガから呼ぶ。Discord転送の成否やtest/live切替とは独立して照合する。
function _ES_confirmOutstanding() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(_ES_STATE), results = [];
  if (!sheet) return results;
  sheet.getDataRange().getValues().slice(1).forEach(function (row) {
    if (!/^(test|live):/.test(String(row[0]))) return;
    try {
      var record = JSON.parse(row[1]);
      if (record.status !== 'sent-unconfirmed') return;
      results.push({ key: row[0], result: _ES_confirm(row[0], record, true) });
    } catch (e) { results.push({ key: row[0], result: { ok: false, reason: String(e.message || e) } }); }
  });
  return results;
}
// 両モードの保存済み記録を照合。offでも利用可。POST・通知・設定変更は行わない。
function EventShipping_reconcile(caseId) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var results = [];
    ['test', 'live'].forEach(function (mode) {
      var key = mode + ':' + caseId, record = _ES_read(key);
      if (!record || record.status === 'unsent') return;
      results.push({ mode: mode, result: _ES_confirm(key, record, false) });
    });
    return { ok: results.length > 0 && results.every(function (r) { return r.result.ok; }),
      confirmed: results.length > 0 && results.every(function (r) { return r.result.confirmed; }), results: results };
  } finally { lock.releaseLock(); }
}
function EventShipping_submit(caseId, opts) {
  var configured = _ES_mode(), mode = _ES_mode(opts);
  if (mode === 'off') return { ok: false, reason: 'mode=off' };
  var discord = mode === 'test' ? _ES_skipDiscord(mode) : null;
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    _ES_assertSend(false, configured);
    var key = mode + ':' + caseId, previous = _ES_read(key);
    if (previous && (previous.status === 'sent' || previous.status === 'confirmed')) return { ok: true, confirmed: true, skipped: true, mode: mode, discord: discord };
    if (previous && previous.status === 'sent-unconfirmed') {
      var confirmation = _ES_confirm(key, previous, false);
      confirmation.skipped = true; confirmation.mode = mode; confirmation.discord = discord;
      return confirmation;
    }
    // 通信切断や確認タイムアウト後は read-back のみ。受理済みの可能性があるPOSTを繰り返さない。
    if (previous && previous.status !== 'unsent') {
      var recovered = _ES_verify(_ES_responseSheet(), previous);
      if (!recovered) throw new Error('前回送信の結果が未確定です。回答シート確認が必要');
      previous.status = 'confirmed'; previous.confirmed = true; previous.responseRow = recovered; _ES_write(key, previous);
      return { ok: true, confirmed: true, skipped: true, recovered: true, responseRow: recovered, discord: discord };
    }
    var payload = EventShipping_buildPayload(caseId, { mode: mode });
    if (discord) payload.warnings.push(discord.reason);
    if (payload.missing.length) return { ok: false, missing: payload.missing, warnings: payload.warnings,
      notification: _ES_notify(caseId, '不足項目があるので登録できません: ' + payload.missing.join('、'), true, mode) };
    var values = payload.values;
    if (mode === 'test') {
      values['entry.1859301085'] = '__TEST__' + values['entry.1859301085'] + '_' + Utilities.getUuid();
      values['entry.612910910'] = 'これはテスト送信です。対応不要です。\n' + values['entry.612910910'];
    }
    var sheet = _ES_responseSheet();
    var record = { status: 'pending', caseId: caseId, mode: mode, sentAt: new Date().toISOString(), responseCode: null,
      project: values['entry.1859301085'], email: values.emailAddress, beforeRow: _ES_responseExtent(sheet).lastRow, values: values };
    _ES_assertSend(false, configured);
    _ES_write(key, record);
    var postValues = {};
    Object.keys(values).forEach(function (k) { postValues[k] = values[k]; });
    // 実送信で日付不一致を確認した後にのみ、別のテスト案件で split を検証する。
    if (_ES_prop('EVENT_SHIPPING_DATE_FORMAT') === 'split') {
      ['entry.1526132716', 'entry.1632051127', 'entry.340525760'].forEach(function (k) {
        if (!postValues[k]) return;
        var parts = postValues[k].split('-'); delete postValues[k];
        postValues[k + '_year'] = parts[0]; postValues[k + '_month'] = parts[1]; postValues[k + '_day'] = parts[2];
      });
    }
    var body = Object.keys(postValues).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(postValues[k]); }).join('&');
    _ES_assertSend(false, configured);
    var response = UrlFetchApp.fetch(_ES_FORM, { method: 'post', contentType: 'application/x-www-form-urlencoded', payload: body, muteHttpExceptions: true });
    record.responseCode = response.getResponseCode();
    if (record.responseCode < 200 || record.responseCode >= 300) {
      _ES_write(key, record);
      throw new Error('フォーム HTTP ' + record.responseCode);
    }
    record.status = 'sent-unconfirmed'; record.confirmed = false; record.confirmationAttempts = 0;
    _ES_write(key, record);
    // 即時照合は1回だけ。反映遅延・読取り障害は後追い確認へ回す。
    var confirmation = _ES_confirm(key, record, false);
    confirmation.mode = mode; confirmation.warnings = payload.warnings;
    return confirmation;
  } catch (e) {
    if (e.shippingNotSent && record) { record.status = 'unsent'; _ES_write(key, record); }
    var notification = { ok: true, skipped: true };
    if (!e.shippingModeStopped) {
      // pending が残る限り通知も一度だけ。通知の応答消失にも備え先に保存する。
      var pending = key ? _ES_read(key) : null;
      notification = _ES_notifyOnce(caseId, e.message || e, key, pending, mode);
    }
    return { ok: false, reason: String(e.message || e), notification: notification };
  }
  finally { lock.releaseLock(); }
}
function _ES_people(caseId, warnings) {
  var source = _ES_source(caseId), map = _ES_jsonProp('ASSIGN_NAG_USER_MAP'), ids = [];
  ['producer', 'designer'].forEach(function (role) {
    var name = _ES_person(source.input[role]), id = String(map[name] || '');
    if (/^\d{17,20}$/.test(id)) ids.push(id);
    else warnings.push((role === 'producer' ? '制作P' : '制作D') + ' Discord ID名寄せ不可: ' + name);
  });
  return ids.filter(function (id, i) { return ids.indexOf(id) === i; });
}
// Discord permissions は64bitの10進文字列。必要な下位ビットだけを精度損失なく操作。
function _ES_low(decimal) {
  var n = 0; String(decimal || '0').split('').forEach(function (digit) { n = (n * 10 + Number(digit)) % 4096; }); return n;
}
function _ES_adjust(decimal, delta) {
  var chars = String(decimal || '0').split(''), carry = delta;
  for (var i = chars.length - 1; i >= 0; i--) {
    var n = Number(chars[i]) + carry; chars[i] = String(((n % 10) + 10) % 10); carry = Math.floor(n / 10);
  }
  if (carry > 0) chars.unshift(String(carry));
  return chars.join('').replace(/^0+(?=\d)/, '');
}
function _ES_permissions(channel, member, roles, owner) {
  if (String(member.user.id) === String(owner)) return 3072;
  var permissions = 0;
  roles.forEach(function (role) {
    if (role.id === _ES_GUILD || member.roles.indexOf(role.id) >= 0) permissions |= _ES_low(role.permissions);
  });
  if (permissions & 8) return 3072;
  var overwrites = channel.permission_overwrites || [];
  function apply(overwrite) { permissions = (permissions & ~_ES_low(overwrite.deny)) | _ES_low(overwrite.allow); }
  overwrites.forEach(function (o) { if (o.id === _ES_GUILD) apply(o); });
  var allow = 0, deny = 0;
  overwrites.forEach(function (o) { if (Number(o.type) === 0 && member.roles.indexOf(o.id) >= 0) { allow |= _ES_low(o.allow); deny |= _ES_low(o.deny); } });
  permissions = (permissions & ~deny) | allow;
  overwrites.forEach(function (o) { if (Number(o.type) === 1 && o.id === member.user.id) apply(o); });
  return permissions;
}
function EventShipping_ensureRoomAccess(caseId) {
  var mode = _ES_mode();
  if (mode !== 'live') return _ES_skipDiscord(mode);
  var warnings = [], results = [], ids = _ES_people(caseId, warnings);
  if (!ids.length) return { ok: true, warnings: warnings, results: results };
  var channel = _ES_api('/channels/' + _ES_ROOM), roles = _ES_api('/guilds/' + _ES_GUILD + '/roles');
  var guild = _ES_api('/guilds/' + _ES_GUILD);
  ids.forEach(function (id) {
    try {
      var member = _ES_api('/guilds/' + _ES_GUILD + '/members/' + id);
      if ((_ES_permissions(channel, member, roles, guild.owner_id) & 3072) === 3072) { results.push({ id: id, ok: true, skipped: true }); return; }
      var existing = { allow: '0', deny: '0' };
      (channel.permission_overwrites || []).forEach(function (o) { if (o.id === id && Number(o.type) === 1) existing = o; });
      _ES_api('/channels/' + _ES_ROOM + '/permissions/' + id, 'put', { type: 1,
        allow: _ES_adjust(existing.allow, 3072 & ~_ES_low(existing.allow)),
        deny: _ES_adjust(existing.deny, -(_ES_low(existing.deny) & 3072)) });
      var verified = _ES_api('/channels/' + _ES_ROOM);
      if ((_ES_permissions(verified, member, roles, guild.owner_id) & 3072) !== 3072) throw new Error('権限 read-back verify 失敗');
      results.push({ id: id, ok: true });
    } catch (e) {
      var result = { id: id, ok: false, reason: String(e.message || e) };
      warnings.push(id + ': ' + result.reason);
      if (e.code === 403) {
        try {
          var dm = _ES_api('/users/@me/channels', 'post', { recipient_id: id });
          _ES_post(dm.id, 'イベントアイテム発送ルームへの参加をお願いします。 https://discord.gg/AtYrCrTDpu', [], { kind: 'dm', userId: id });
          result.dmSent = true;
          warnings.push(id + ': 招待DM送信済み（チャンネル権限は未確認）');
        } catch (dmError) { result.dmSent = false; warnings.push(id + ': DM失敗 ' + dmError.message); }
      }
      results.push(result);
    }
  });
  return { ok: results.every(function (r) { return r.ok; }), warnings: warnings, results: results };
}
function EventShipping_register(caseId, payload) {
  var result = { ok: true };
  try { EventShipping_saveInput(caseId, payload); }
  catch (e) { return { ok: false, reason: e.message, notification: _ES_notify(caseId, e.message) }; }
  try { result.room = EventShipping_ensureRoomAccess(caseId); }
  catch (e) { result.room = { ok: false, reason: String(e.message || e) }; }
  try { result.submission = EventShipping_submit(caseId); }
  catch (e) { result.submission = { ok: false, reason: String(e.message || e), notification: _ES_notify(caseId, e.message || e) }; }
  result.ok = result.room.ok && result.submission.ok;
  if (!result.room.ok) result.notification = _ES_notify(caseId, '発送ルーム参加失敗: ' + (result.room.reason || (result.room.warnings || []).join('、')));
  return result;
}
function EventShipping_relayWarehouseNotice() {
  var mode = _ES_mode();
  if (mode === 'off') return _ES_skipDiscord(mode);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (_ES_mode() === 'off') return _ES_skipDiscord('off');
    var confirmations = _ES_confirmOutstanding();
    if (_ES_mode() !== 'live') {
      var skipped = _ES_skipDiscord(_ES_mode());
      skipped.confirmations = confirmations;
      skipped.ok = confirmations.every(function (r) { return r.result.ok; });
      return skipped;
    }
    var warehouse = _ES_prop('DISCORD_WAREHOUSE_CHANNEL_ID') || '1383253163729223872';
    var messages = _ES_api('/channels/' + warehouse + '/messages?limit=100');
    var projects = {}, warnings = [], results = [];
    CaseList_listAll().forEach(function (c) {
      try {
        var code = _ES_source(c.caseId).code;
        if (code) { if (!projects[code]) projects[code] = []; projects[code].push(c.caseId); }
      } catch (e) { warnings.push(c.caseId + ': ' + e.message); }
    });
    messages.reverse().forEach(function (message) {
      var text = String(message.content || '');
      (message.embeds || []).forEach(function (embed) {
        text += '\n' + (embed.title || '') + '\n' + (embed.description || '');
        (embed.fields || []).forEach(function (f) { text += '\n' + f.name + '\n' + f.value; });
      });
      if (text.indexOf('【登録イベントが追加されました】') < 0 || text.indexOf('__TEST__') >= 0) return;
      var codes = text.match(/\b\d{6}[A-Za-z]+\b/g) || [];
      codes = codes.filter(function (code, i) { return codes.indexOf(code) === i; });
      if (codes.length !== 1 || !projects[codes[0]] || projects[codes[0]].length !== 1) { warnings.push(message.id + ': 案件を一意に特定できません'); return; }
      var caseId = projects[codes[0]][0], key = 'relay:' + message.id, state = _ES_read(key) || {};
      if (state.done) return;
      try {
        // pending は旧形式も含め必ず先に止める。保存先IDは再利用しない。
        if (state.pending) throw new Error('前回転送の結果未確定。重複防止のため停止');
        var destination = _ES_destination(caseId, true);
        var target = destination.id;
        if (state.forwarded && state.target !== target) throw new Error('転送済み宛先が変わったため定型文送信停止');
        state.target = target; state.destinationNote = destination.note;
        // APIが受理した後の通信切断にも備え、先にpendingを永続化する。
        var ids = _ES_people(caseId, warnings);
        if (!state.forwarded) {
          state.pending = true; _ES_write(key, state);
          _ES_api('/channels/' + target + '/messages', 'post', {
            message_reference: { type: 1, message_id: message.id, channel_id: warehouse, guild_id: _ES_GUILD },
            allowed_mentions: { parse: [] }
          }, destination);
          state.forwarded = true; state.pending = false; _ES_write(key, state);
        }
        state.pending = true; _ES_write(key, state);
        _ES_post(target, destination.note.slice(0, 1000) + (ids.length ? ids.map(function (id) { return '<@' + id + '>'; }).join('　') : '＠制作P　＠制作D') +
          '\nイベント登録が完了し、事前MTG・確定MTGの日程が決まりました。\n制作アカウントで確認し、ご自身のGmailを追加しておいてください。\nまたご都合の悪い場合は、ご自身でリスケをお願いします。\n事前MTG・確定MTGマニュアル\nhttps://orgiast-manual.com/664e9ed7bca30903a3ee5bf3\nこちらの送信を持ってタスクを「済」にします。', ids, destination);
        state.done = true; state.pending = false; _ES_write(key, state);
        results.push({ caseId: caseId, messageId: message.id, ok: true });
      } catch (e) {
        if (e.shippingNotSent) { state.pending = false; _ES_write(key, state); }
        var notification = { ok: true, skipped: true };
        if (!e.shippingModeStopped) notification = _ES_notifyOnce(caseId, e.message, key, state);
        results.push({ caseId: caseId, messageId: message.id, ok: false, reason: e.message, notification: notification });
      }
    });
    return { ok: !warnings.length && results.every(function (r) { return r.ok; }) &&
      confirmations.every(function (r) { return r.result.ok; }), results: results, warnings: warnings, confirmations: confirmations };
  } finally { lock.releaseLock(); }
}
function EventShipping_cancel(caseId, reason) {
  var mode = _ES_mode();
  if (mode !== 'live') return _ES_skipDiscord(mode);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    if (_ES_mode() !== 'live') return _ES_skipDiscord(_ES_mode());
    var key = 'cancel:' + caseId, previous = _ES_read(key);
    if (previous && previous.status !== 'unsent') return previous.status === 'sent' ? { ok: true, skipped: true, messageId: previous.messageId } :
      { ok: false, reason: '前回キャンセル通知の結果未確定。Discord履歴確認が必要' };
    var source = _ES_source(caseId);
    if (!source.code || !String(reason || '').trim()) return { ok: false, reason: 'プロジェクトコードとキャンセル理由が必要です' };
    var record = { status: 'pending', code: source.code, reason: String(reason).trim(), sentAt: new Date().toISOString() };
    _ES_write(key, record);
    var message = _ES_post(_ES_ROOM, '【案件キャンセル】' + source.code + '\n' + source.c.clientName + '\n理由: ' + record.reason.slice(0, 1200), [], { kind: 'room' });
    record.status = 'sent'; record.messageId = message.id; _ES_write(key, record);
    return { ok: true, messageId: message.id };
  } catch (e) {
    if (e.shippingNotSent && record) { record.status = 'unsent'; _ES_write(key, record); }
    return { ok: false, reason: String(e.message || e) };
  }
  finally { lock.releaseLock(); }
}
