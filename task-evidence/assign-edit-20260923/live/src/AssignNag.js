/** 会期の先頭の年から初日を読む。実在しない日付は繰り上げない。 */
function _AssignNag_parseFirstDate(text, defaultYear) {
  var value = String(text || '').replace(/[\s　]+/g, '');
  var year = /\d{4}/.exec(value);
  var m = year ? /^(\d{4})(?:年|\/|-)(\d{1,2})(?:月|\/|-)(\d{1,2})(?!\d)/.exec(value.slice(year.index)) : null;
  if (!m) {
    // 年の無い表記（4/17〜4/19）は defaultYear が渡されたときだけそれを当てる
    if (defaultYear == null) return null;
    m = /^(\d{1,2})(?:月|\/|-)(\d{1,2})(?!\d)/.exec(value);
    if (!m) return null;
    m = [m[0], String(defaultYear), m[1], m[2]];
  }
  var date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 &&
    date.getUTCDate() === Number(m[3]) ? date : null;
}

/** row8 のゆらぎ（制作P：百瀬かなう / P百瀬かなう / 制作P百瀬かなう）から氏名を取り出す。 */
function _AssignNag_producerName(value) {
  var base = _AssignSheet_producerName(value);
  var stripped = String(base).replace(/^[\s　]*(?:制作)?[PD][\s　]*(?=[぀-ヿ一-鿿])/, '')
    .replace(/^[\s　]+|[\s　]+$/g, '');
  return stripped || base;
}

function _AssignNag_isAssignRow(cells) {
  return String(cells.subCategory || '').indexOf('アサイン') !== -1 && String(cells.exclude || '').trim() !== '不要';
}

function _AssignNag_evaluateCase(params) {
  var incomplete = params.assignRows.filter(function (row) {
    var progress = String(row.progress || '').trim();
    return progress !== '済' && progress !== '不要';
  }).map(function (row) { return row.item; });
  var days = params.eventFirstDate ? Math.floor((params.eventFirstDate - params.today) / 86400000) : null;
  if (days !== null && !isFinite(days)) days = null;
  return { status: days === null ? 'skipped' : days >= 0 && days <= 21 ? 'window' : 'outside',
    daysLeft: days, incomplete: incomplete };
}

function _AssignNag_buildText(params) {
  var lines = [];
  if (params.fallback) {
    var names = params.items.map(function (item) { return item.producer || '担当者未設定'; })
      .filter(function (name, index, all) { return all.indexOf(name) === index; });
    lines.push('※この案件の制作P（' + names.join(' / ') + '）のDiscordが未同定です。取り次ぎをお願いします。');
  }
  lines.push('⏰ アサイン未完了リマインダー（イベント3週間前の毎日通知・自動）');
  params.items.forEach(function (item) {
    lines.push('・' + item.clientName + ' / ' + item.caseName + '（会期初日 ' + item.eventFirstDateText + '・あと' + item.daysLeft + '日）');
    lines.push('  未完了: ' + item.incomplete.join(' / '));
  });
  lines.push('対応が済んだら進捗表の該当行を「済」にしてください。');
  lines.push('https://docs.google.com/a/orgiast.jp/spreadsheets/d/1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI/edit');
  return lines.join('\n').slice(0, 1900);
}

/** count は通知対象案件数。シートの読み取りは一括で1回、書き込みは行わない。 */
function AssignNag_nagPending(opts) {
  opts = opts || {};
  var values = SpreadsheetApp.openById('1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI')
    .getSheetByName('task').getDataRange().getDisplayValues();
  var todayText = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd');
  var today = _AssignNag_parseFirstDate(todayText);
  var defaultYear = Number(todayText.slice(0, 4));
  var assignIndices = [];
  for (var r = 11; r < values.length; r++) {
    if (_AssignNag_isAssignRow({ subCategory: values[r][2], exclude: values[r][4] })) assignIndices.push(r);
  }
  var items = [], skipped = [], groups = Object.create(null);
  var headers = values[1] || [], last = -1;
  for (var c = 12; c < headers.length; c += 3) {
    if (String(headers[c] || '').trim()) last = c;
  }
  for (var col = 12; col <= last; col += 3) {
    if (!String(headers[col] || '').trim()) continue;
    var eventDate = _AssignNag_parseFirstDate((values[4] || [])[col], defaultYear);
    var evaluation = _AssignNag_evaluateCase({ today: today, eventFirstDate: eventDate,
      assignRows: assignIndices.map(function (row) { return { item: values[row][3], progress: values[row][col + 2] }; }) });
    if (evaluation.status === 'skipped') {
      skipped.push({ caseName: headers[col], masterCol: col + 1, reason: '会期初日を解析できません' });
      continue;
    }
    if (evaluation.status !== 'window' || !evaluation.incomplete.length) continue;
    var owners = values[7] || [];
    var producer = _AssignNag_producerName(owners[col]) || _AssignNag_producerName(owners[col + 1]) || '担当者未設定';
    var item = { producer: producer, clientName: (values[0] || [])[col] || '', caseName: headers[col],
      daysLeft: evaluation.daysLeft, eventFirstDateText: Utilities.formatDate(eventDate, 'UTC', 'yyyy/MM/dd'),
      incomplete: evaluation.incomplete };
    items.push(item);
    if (!groups[producer]) groups[producer] = [];
    groups[producer].push(item);
  }
  if (!items.length) return { ok: true, sent: false, count: 0, items: [], texts: [], results: [], skipped: skipped };
  var props = PropertiesService.getScriptProperties();
  var userMap;
  try { userMap = JSON.parse(props.getProperty('ASSIGN_NAG_USER_MAP') || '{}'); } catch (e) { userMap = {}; }
  if (!userMap || typeof userMap !== 'object' || Array.isArray(userMap)) userMap = {};
  var token = props.getProperty('DISCORD_BOT_TOKEN');
  var fallbackId = props.getProperty('DISCORD_DM_USER_ID');
  var texts = [], results = [];
  Object.keys(groups).forEach(function (producer) {
    var mappedId = Object.prototype.hasOwnProperty.call(userMap, producer) ? userMap[producer] : null;
    var fallback = typeof mappedId !== 'string' || !mappedId.trim();
    var userId = fallback ? fallbackId : mappedId.trim();
    var text = _AssignNag_buildText({ todayText: todayText, items: groups[producer], fallback: !!fallback });
    texts.push(text);
    if (opts.dryRun === true) return;
    var result = { producer: producer, userId: userId || '', via: fallback ? 'fallback' : 'map', ok: false };
    if (!token || !userId) result.reason = 'DISCORD_BOT_TOKEN または送信先ユーザーIDが未設定';
    else {
      try {
        result.ok = _FeedbackRelay_postDm(token, userId, text) === true;
        if (!result.ok) result.reason = 'Discord DM送信失敗';
      } catch (e) { result.reason = 'Discord DM送信時に例外が発生'; }
    }
    results.push(result);
  });
  if (opts.dryRun === true) return { ok: true, count: items.length, items: items, texts: texts, sent: false, skipped: skipped };
  return { ok: results.every(function (r) { return r.ok; }), count: items.length,
    sent: results.some(function (r) { return r.ok; }), results: results, skipped: skipped };
}

function AssignNag_installTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'AssignNag_nagPending') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  ScriptApp.newTrigger('AssignNag_nagPending').timeBased().atHour(9).everyDays(1).create();
  return { ok: true, removed: removed, created: 1 };
}

function AssignNag_testDm() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('DISCORD_BOT_TOKEN'), userId = props.getProperty('DISCORD_DM_USER_ID');
  if (!token || !userId) return { ok: false, sent: false, reason: 'DISCORD_BOT_TOKEN または DISCORD_DM_USER_ID が未設定' };
  try {
    var ok = _FeedbackRelay_postDm(token, userId, '疎通テスト（無視してください）') === true;
    return ok ? { ok: true, sent: true } : { ok: false, sent: false, reason: 'Discord DM送信失敗' };
  } catch (e) { return { ok: false, sent: false, reason: 'Discord DM送信時に例外が発生' }; }
}
