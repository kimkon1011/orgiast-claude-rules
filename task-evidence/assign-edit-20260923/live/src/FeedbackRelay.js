/**
 * 全社共通「不具合・要望」中継クライアント（管理者/開発担当者の Discord DM 着信）。
 *
 * 背景: 社内アプリの不具合・要望は全社共通の中継 (POST <FEEDBACK_RELAY_URL>) を通って
 * 管理者/開発担当者の Discord DM に届く仕組みが本番稼働している（Next.js 版は
 * orgiast-claude-rules/packages/feedback-widget）。本ファイルはその GAS 版クライアントで、
 * 他の GAS アプリへそのまま移植できるよう、Script Properties 読み取り以外の依存を持たない
 * （移植する場合は本ファイル単体をコピーすれば動く）。
 *
 * 設定は Script Properties から読む:
 *   FEEDBACK_RELAY_URL       中継の POST 先 URL
 *   FEEDBACK_RELAY_SECRET    共有シークレット（Admin_setFeedbackRelay で設定）
 *   FEEDBACK_APP_NAME        既定のアプリ名（呼び出し側が省略した場合に使う）
 *   DISCORD_BOT_TOKEN       Discord Bot トークン（DM 送信用）
 *   DISCORD_DM_USER_ID      Discord DM の送信先ユーザー ID
 *   DISCORD_FEEDBACK_WEBHOOK 中継が失敗した場合のフォールバック先（既存プロパティを流用）
 */

var _FEEDBACK_RELAY_MAX_TITLE = 200;
var _FEEDBACK_RELAY_MAX_BODY = 4000;

/** 未認証で開ける投稿フォーム用の 画像/本文 濫用対策の上限（背景の screenshot 8MB 以下と揃える）。 */
var _FEEDBACK_RELAY_FORM_MAX_TITLE = 200;
var _FEEDBACK_RELAY_FORM_MAX_BODY = 4000;
var _FEEDBACK_RELAY_IMG_MAX_BYTES = 8 * 1024 * 1024;
var _FEEDBACK_RELAY_IMG_MAX_TOTAL = 25 * 1024 * 1024;
var _FEEDBACK_RELAY_IMG_MAX_COUNT = 5;

var _FEEDBACK_RELAY_RATE_LIMIT = 5;
var _FEEDBACK_RELAY_RATE_WINDOW_SEC = 10 * 60;

function _FeedbackRelay_config() {
  var props = PropertiesService.getScriptProperties();
  return {
    url: String(props.getProperty('FEEDBACK_RELAY_URL') || ''),
    secret: String(props.getProperty('FEEDBACK_RELAY_SECRET') || ''),
    appName: String(props.getProperty('FEEDBACK_APP_NAME') || ''),
    botToken: String(props.getProperty('DISCORD_BOT_TOKEN') || ''),
    dmUserId: String(props.getProperty('DISCORD_DM_USER_ID') || ''),
    webhook: String(props.getProperty('DISCORD_FEEDBACK_WEBHOOK') || '')
  };
}

/**
 * 2 枚目以降の画像を保存する専用フォルダ（中継は screenshot を1枚しか受け取らないため）。
 * 他アプリへ移植してもそのまま動くよう、この関数だけで完結させる（外部フォルダIDに依存しない）。
 */
function _FeedbackRelay_extraImageFolder() {
  var name = 'FeedbackRelay添付（2枚目以降）';
  var folders = DriveApp.getRootFolder().getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.getRootFolder().createFolder(name);
}

/** 2 枚目以降の画像を Drive に保存し、本文末尾に「他 N 枚は報告シート参照」+ URL を追記する。 */
function _FeedbackRelay_appendExtraImagesNote(body, blobs) {
  var text = String(body || '');
  var list = Array.isArray(blobs) ? blobs : [];
  if (list.length <= 1) return text;
  var extras = list.slice(1);
  var urls = [];
  try {
    var folder = _FeedbackRelay_extraImageFolder();
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
    for (var i = 0; i < extras.length; i++) {
      try {
        var name = 'extra_' + stamp + '_' + (i + 1) + '_' + (extras[i].getName() || 'screenshot.png');
        var file = folder.createFile(extras[i].copyBlob().setName(name));
        urls.push(file.getUrl());
      } catch (e) { /* 個別保存失敗は送信本体を止めない */ }
    }
  } catch (e) { /* フォルダ確保に失敗しても本文送信は続行する */ }
  var note = '\n他 ' + extras.length + ' 枚は報告シート参照' + (urls.length ? ':\n' + urls.join('\n') : '');
  return (text + note).slice(0, _FEEDBACK_RELAY_MAX_BODY);
}

/** 中継 API へ渡す multipart フォームを組み立てる（screenshot は先頭 1 枚のみ）。 */
function _FeedbackRelay_buildForm(config, payload) {
  var kind = payload.kind === 'request' ? 'request' : 'bug';
  var title = String(payload.title || '').slice(0, _FEEDBACK_RELAY_MAX_TITLE);
  var blobs = Array.isArray(payload.imageBlobs) ? payload.imageBlobs : [];
  var body = String(payload.body || '').slice(0, _FEEDBACK_RELAY_MAX_BODY);
  body = _FeedbackRelay_appendExtraImagesNote(body, blobs);
  var form = {
    app_name: String(payload.appName || config.appName || ''),
    kind: kind,
    title: title,
    body: body,
    submitter: String(payload.submitter || ''),
    page_path: String(payload.pagePath || ''),
    source_url: String(payload.sourceUrl || '')
  };
  if (blobs.length) form.screenshot = blobs[0];
  return form;
}

/**
 * 中継へ POST する。ヘッダ名が分からないため Authorization: Bearer と x-feedback-secret の
 * 両方に同じシークレットを載せる（中継側はどちらか一方を見る想定）。例外は投げず結果を返す。
 */
function _FeedbackRelay_post(config, payload) {
  var form = _FeedbackRelay_buildForm(config, payload);
  var headers = {
    'Authorization': 'Bearer ' + config.secret,
    'x-feedback-secret': config.secret
  };
  try {
    var response = UrlFetchApp.fetch(config.url, {
      method: 'post', headers: headers, payload: form, muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true };
    return { ok: false, error: 'HTTP ' + code };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** webhook フォールバック用の本文（中継のような整形ではなく、素朴な組み立てで十分）。 */
function _FeedbackRelay_webhookContent(payload, config) {
  var appName = String(payload.appName || (config && config.appName) || 'アプリ');
  var kindLabel = payload.kind === 'request' ? '要望' : '不具合';
  var title = String(payload.title || '(無題)');
  var body = String(payload.body || '').slice(0, 300);
  var lines = ['🐛 **[' + appName + ']** ' + kindLabel + ': ' + title, body];
  if (payload.submitter) lines.push('提出者: ' + payload.submitter);
  if (payload.sourceUrl) lines.push('参照: ' + payload.sourceUrl);
  return lines.filter(function (line) { return line; }).join('\n');
}

/** Discord webhook へ投げる（複数画像はそのまま files[0..n] に添付できる）。失敗しても例外を投げない。 */
function _FeedbackRelay_postWebhook(hook, content, blobs) {
  var list = Array.isArray(blobs) ? blobs : [];
  var options;
  if (list.length) {
    var form = { payload_json: JSON.stringify({ content: content, flags: 4 }) };
    for (var i = 0; i < list.length; i++) form['files[' + i + ']'] = list[i];
    options = { method: 'post', payload: form, muteHttpExceptions: true };
  } else {
    options = {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ content: content, flags: 4 }), muteHttpExceptions: true
    };
  }
  try {
    var response = UrlFetchApp.fetch(hook, options);
    var code = response.getResponseCode();
    return code >= 200 && code < 300;
  } catch (e) {
    return false;
  }
}

/** Discord Bot で DM を送る。失敗は例外にせず false を返す。 */
function _FeedbackRelay_postDm(token, userId, content, blobs) {
  try {
    var channelResponse = UrlFetchApp.fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'post',
      headers: { Authorization: 'Bot ' + token },
      contentType: 'application/json',
      payload: JSON.stringify({ recipient_id: String(userId) }),
      muteHttpExceptions: true
    });
    var channelCode = channelResponse.getResponseCode();
    if (channelCode < 200 || channelCode >= 300) return false;
    var channel = JSON.parse(channelResponse.getContentText() || '{}');
    if (!channel.id) return false;

    var text = String(content || '').slice(0, 1900);
    var list = Array.isArray(blobs) ? blobs : [];
    var options;
    if (list.length) {
      var form = { payload_json: JSON.stringify({ content: text }) };
      for (var i = 0; i < list.length; i++) form['files[' + i + ']'] = list[i];
      options = { method: 'post', headers: { Authorization: 'Bot ' + token }, payload: form, muteHttpExceptions: true };
    } else {
      options = {
        method: 'post', headers: { Authorization: 'Bot ' + token }, contentType: 'application/json',
        payload: JSON.stringify({ content: text }), muteHttpExceptions: true
      };
    }
    var messageResponse = UrlFetchApp.fetch(
      'https://discord.com/api/v10/channels/' + encodeURIComponent(String(channel.id)) + '/messages', options
    );
    var messageCode = messageResponse.getResponseCode();
    return messageCode >= 200 && messageCode < 300;
  } catch (e) {
    return false;
  }
}

/** Discord Bot で固定チャンネルへ直接投稿する。失敗は例外にせず結果を返す。 */
function _FeedbackRelay_postToChannel(token, channelId, content, blobs) {
  return _FeedbackRelay_sendChannelMessage(token, channelId, content, blobs, "");
}

/** Discord Bot で固定チャンネルの元メッセージへ返信する。 */
function _FeedbackRelay_replyInChannel(token, channelId, replyToMessageId, content, blobs) {
  if (!String(replyToMessageId || "")) return _FeedbackRelay_postToChannel(token, channelId, content, blobs);
  return _FeedbackRelay_sendChannelMessage(token, channelId, content, blobs, String(replyToMessageId));
}

/** 固定チャンネルへの通常投稿と返信投稿を共通処理する。 */
function _FeedbackRelay_sendChannelMessage(token, channelId, content, blobs, replyToMessageId) {
  try {
    var text = String(content || '').slice(0, 1900);
    var list = Array.isArray(blobs) ? blobs : [];
    var payload = { content: text };
    if (replyToMessageId) payload.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false };
    var options;
    if (list.length) {
      var form = { payload_json: JSON.stringify(payload) };
      for (var i = 0; i < list.length; i++) form['files[' + i + ']'] = list[i];
      options = { method: 'post', headers: { Authorization: 'Bot ' + token }, payload: form, muteHttpExceptions: true };
    } else {
      options = { method: 'post', headers: { Authorization: 'Bot ' + token }, contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };
    }
    var response = UrlFetchApp.fetch('https://discord.com/api/v10/channels/' + encodeURIComponent(String(channelId)) + '/messages', options);
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) return { ok: false, messageId: "" };
    var body = {};
    try { body = JSON.parse(response.getContentText() || "{}"); } catch (parseError) { body = {}; }
    return { ok: true, messageId: String(body.id || "") };
  } catch (e) {
    return { ok: false, messageId: "" };
  }
}

/**
 * FeedbackRelay_submit(payload) -> { ok, relayed, via: 'relay'|'dm'|'webhook'|'none', error? }
 * payload = { appName, kind, title, body, submitter, pagePath, sourceUrl, imageBlobs: [Blob] }
 *
 * 例外は投げない。中継が失敗したら Script Property DISCORD_FEEDBACK_WEBHOOK があれば
 * 従来どおり webhook へフォールバックする。設定が何も無ければ { ok:true, relayed:false, via:'none' }。
 * 呼び出し側は via で分岐する必要はない（記録が本体、通知は best-effort）。
 */
function FeedbackRelay_submit(payload) {
  payload = payload || {};
  try {
    var config = _FeedbackRelay_config();
    var blobs = Array.isArray(payload.imageBlobs) ? payload.imageBlobs : [];
    var errors = [];
    if (config.url && config.secret) {
      var attempt = _FeedbackRelay_post(config, payload);
      if (attempt.ok) return { ok: true, relayed: true, via: 'relay' };
      errors.push('中継: ' + (attempt.error || '送信失敗'));
    } else errors.push('中継: 未設定');

    var content = _FeedbackRelay_webhookContent(payload, config);
    if (config.botToken && config.dmUserId) {
      if (_FeedbackRelay_postDm(config.botToken, config.dmUserId, content, blobs)) {
        return { ok: true, relayed: false, via: 'dm' };
      }
      errors.push('DM: 送信失敗');
    } else errors.push('DM: 未設定');
    if (config.webhook) {
      if (_FeedbackRelay_postWebhook(config.webhook, content, blobs)) {
        return { ok: true, relayed: false, via: 'webhook' };
      }
      errors.push('webhook: 送信失敗');
    } else errors.push('webhook: 未設定');
    return { ok: true, relayed: false, via: 'none', error: errors.join(' / ') };
  } catch (e) {
    return { ok: true, relayed: false, via: 'none', error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 管理コマンド: 中継の設定を Script Properties に保存する。
 * 戻り値にシークレットそのものは含めない。
 */
function Admin_setFeedbackRelay(url, secret, appName, formUrl) {
  var props = PropertiesService.getScriptProperties();
  if (url !== undefined && url !== null) props.setProperty('FEEDBACK_RELAY_URL', String(url));
  if (secret !== undefined && secret !== null) props.setProperty('FEEDBACK_RELAY_SECRET', String(secret));
  if (appName !== undefined && appName !== null) props.setProperty('FEEDBACK_APP_NAME', String(appName));
  // 各シートに置く「🐛 不具合・要望」リンクの組み立て元。Web アプリの /exec URL をそのまま入れる。
  if (formUrl !== undefined && formUrl !== null) props.setProperty('FEEDBACK_FORM_URL', String(formUrl));
  return {
    ok: true,
    set: {
      url: Boolean(url), secret: Boolean(secret),
      appName: String(appName || ''), formUrl: Boolean(formUrl)
    }
  };
}

/** Discord DM 設定を Script Properties に保存する。トークン値は返さない。 */
function Admin_setFeedbackDiscord(botToken, dmUserId) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DISCORD_BOT_TOKEN', String(botToken || ''));
  props.setProperty('DISCORD_DM_USER_ID', String(dmUserId || ''));
  return { ok: true, set: { botToken: Boolean(botToken), dmUserId: String(dmUserId || '') } };
}

/** 倉庫の Discord チャンネル ID を Script Properties に保存する。 */
function Admin_setChecklistRushChannel(channelId) {
  var id = String(channelId || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, error: 'チャンネル ID が不正です' };
  PropertiesService.getScriptProperties().setProperty('DISCORD_WAREHOUSE_CHANNEL_ID', id);
  return { ok: true, channelId: id };
}

/** Discord DM を1回実送信する疎通テスト。 */
function FeedbackRelay_testDm() {
  var config = _FeedbackRelay_config();
  if (!(config.botToken && config.dmUserId)) return { ok: false, sent: false, via: 'none', error: 'DM: 未設定' };
  var sent = _FeedbackRelay_postDm(config.botToken, config.dmUserId, '疎通テストです（無視してください）', []);
  return { ok: sent, sent: sent, via: sent ? 'dm' : 'none', error: sent ? undefined : 'DM: 送信失敗' };
}

/** 読み取り専用の疎通確認。値そのものは返さない。 */
function FeedbackRelay_ping() {
  var config = _FeedbackRelay_config();
  return {
    ok: true,
    hasUrl: Boolean(config.url),
    hasSecret: Boolean(config.secret),
    appName: config.appName,
    webhookFallback: Boolean(config.webhook),
    dmConfigured: Boolean(config.botToken && config.dmUserId)
  };
}

/** 未対応かつ返答のない不具合・要望を1通にまとめて通知する（シートは読み取りのみ）。 */
function FeedbackRelay_nagPending(opts) {
  opts = opts || {};
  try {
    var config = _FeedbackRelay_config();
    var ss = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
    var sheet = ss.getSheetByName(_FEEDBACK_LOG);
    if (!sheet) return { ok: true, count: 0, sent: false, via: 'none', reason: '記録シートなし' };
    var values = sheet.getDataRange().getValues();
    if (!values.length) return { ok: true, count: 0, sent: false, via: 'none', reason: '記録なし' };
    var headers = values[0].map(function (v) { return String(v || '').trim(); });
    var required = ['日時', '種別', 'タイトル', '状態', '対応メモ', '送信元'];
    var col = {};
    for (var h = 0; h < required.length; h++) {
      col[required[h]] = headers.indexOf(required[h]);
      if (col[required[h]] < 0) return { ok: false, count: 0, sent: false, via: 'none', reason: '必須列がありません: ' + required[h] };
    }
    var doneStates = { done: true, '完了': true, '対応済': true, '却下': true };
    var now = new Date();
    var items = [];
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var state = String(row[col['状態']] || '').trim().toLowerCase();
      // 対応メモが入っていても未完了なら対象にする。実測でブース制作アプリの
      // 唯一の未完了1件が「メモ入りだが未完了」で、メモ空だけに絞ると取りこぼした。
      if (doneStates[state]) continue;
      var rawDate = row[col['日時']];
      var days = rawDate instanceof Date && !isNaN(rawDate.getTime())
        ? Math.max(0, Math.floor((now.getTime() - rawDate.getTime()) / 86400000)) : null;
      items.push({
        kind: String(row[col['種別']] || '不具合'), title: String(row[col['タイトル']] || '(無題)'),
        days: days, source: String(row[col['送信元']] || '不明'),
        replyState: String(row[col['対応メモ']] || '').trim() ? '返答済・未完了' : '未返答'
      });
    }
    if (!items.length) return { ok: true, count: 0, sent: false, via: 'none', reason: '未対応なし' };
    var lines = ['🐛 未対応の不具合・要望 ' + items.length + ' 件'];
    items.slice(0, 15).forEach(function (item) {
      lines.push('・[' + item.kind.slice(0, 20) + '/' + item.replyState + '] ' + item.title.slice(0, 70) + ' … ' +
        (item.days === null ? '経過不明' : '経過 ' + item.days + ' 日') + ' / 送信元: ' + item.source.slice(0, 50));
    });
    if (items.length > 15) lines.push('ほか ' + (items.length - 15) + ' 件');
    // Workspace URL は /a/orgiast.jp/ を挟む（素URLは個人Gmail既定のブラウザで開いて
    // 「アクセス権が必要です」になる。Discord から踏むリンクなので必須）。
    lines.push('https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + sheet.getParent().getId() +
      '/edit#gid=' + sheet.getSheetId());
    var content = lines.join('\n');
    if (opts.dryRun === true) return { ok: true, count: items.length, items: items, content: content };
    if (config.botToken && config.dmUserId && _FeedbackRelay_postDm(config.botToken, config.dmUserId, content, [])) {
      return { ok: true, count: items.length, sent: true, via: 'dm' };
    }
    if (config.webhook && _FeedbackRelay_postWebhook(config.webhook, content, [])) {
      return { ok: true, count: items.length, sent: true, via: 'webhook' };
    }
    var configured = Boolean((config.botToken && config.dmUserId) || config.webhook);
    return { ok: true, count: items.length, sent: false, via: 'none', reason: configured ? '通知送信失敗' : '通知先未設定' };
  } catch (e) {
    return { ok: false, count: 0, sent: false, via: 'none', reason: String(e && e.message ? e.message : e) };
  }
}

/** 毎日 9 時の未対応通知トリガーを重複なく1本だけ設置する。 */
function FeedbackRelay_installNagTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'FeedbackRelay_nagPending') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  ScriptApp.newTrigger('FeedbackRelay_nagPending').timeBased().atHour(9).everyDays(1).create();
  return { ok: true, removed: removed, created: true };
}

// ---------------------------------------------------------------------------
// 未認証フォーム (doGet ?form=feedback) 用: 濫用対策つきの記録+通知エントリポイント
// ---------------------------------------------------------------------------

/**
 * トークン無しで開けるフォームページを返す。CaseApi.js の doGet から
 * token 検証より前に呼ばれる（報告者に token を配れないため）。
 * app / src はテンプレート内で <?= ?>（エスケープあり）にのみ渡す。
 */
function FeedbackRelay_serveForm(params) {
  var opts = params || {};
  var template = HtmlService.createTemplateFromFile('ui/FeedbackForm');
  template.appName = String(opts.app || '');
  template.sourceUrl = String(opts.src || '');
  return template.evaluate()
    .setTitle('不具合・要望の報告')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function _FeedbackRelay_rateLimitKey() {
  var userKey = '';
  try { userKey = Session.getTemporaryActiveUserKey() || ''; } catch (e) { userKey = ''; }
  var bucket = Math.floor(new Date().getTime() / (_FEEDBACK_RELAY_RATE_WINDOW_SEC * 1000));
  return 'fbrl_' + (userKey || 'anon') + '_' + bucket;
}

/** 10 分間に 5 件まで（固定ウィンドウ）。true=送信可, false=超過。 */
function _FeedbackRelay_checkRateLimit() {
  var cache = CacheService.getScriptCache();
  var key = _FeedbackRelay_rateLimitKey();
  var count = Number(cache.get(key)) || 0;
  if (count >= _FEEDBACK_RELAY_RATE_LIMIT) return false;
  cache.put(key, String(count + 1), _FEEDBACK_RELAY_RATE_WINDOW_SEC);
  return true;
}

/** フォームが送る base64 画像を Blob へ復元する（デコード失敗は無視）。極端な配列長からも防御する。 */
function _FeedbackRelay_decodeImages(images) {
  var candidates = [];
  var list = Array.isArray(images) ? images.slice(0, 20) : [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    try {
      var bytes = Utilities.base64Decode(String(item.base64 || ''));
      var mimeType = String(item.mimeType || 'image/png');
      var name = String(item.name || 'screenshot.png').replace(/[\\/]/g, '_');
      var blob = Utilities.newBlob(bytes, mimeType, name);
      candidates.push({ blob: blob, name: name, bytes: bytes.length });
    } catch (e) { /* デコード失敗は無視 */ }
  }
  return candidates;
}

/** 通知に載せる画像を選ぶ（1枚8MB・合計25MB・5枚まで）。超過分は選ばない＝保存はするが通知には載らない。 */
function _FeedbackRelay_selectImages(candidates) {
  var selected = [];
  var totalBytes = 0;
  for (var i = 0; i < candidates.length; i++) {
    var item = candidates[i];
    if (item.bytes > _FEEDBACK_RELAY_IMG_MAX_BYTES || selected.length >= _FEEDBACK_RELAY_IMG_MAX_COUNT ||
        totalBytes + item.bytes > _FEEDBACK_RELAY_IMG_MAX_TOTAL) {
      continue;
    }
    selected.push(item);
    totalBytes += item.bytes;
  }
  return selected;
}

/** master「不具合要望」シート（Feedback.js と共有）を用意する。無ければ作成しヘッダを揃える。 */
function _FeedbackRelay_ensureLogSheet(ms) {
  var log = ms.getSheetByName(_FEEDBACK_LOG);
  if (!log) {
    log = ms.insertSheet(_FEEDBACK_LOG);
    log.getRange(1, 1, 1, 8).setValues([['日時', '種別', 'タイトル', '内容', '状態', '対応メモ', '画像', '送信元']])
      .setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
    log.setFrozenRows(1);
    log.setColumnWidth(1, 130); log.setColumnWidth(3, 240); log.setColumnWidth(4, 420);
  }
  _Feedback_migrateLogHeaders(log);
  return log;
}

/**
 * FeedbackRelay_submitFromForm(payload) — google.script.run から呼ばれる、未認証フォームの送信口。
 * payload = { company(honeypot), kind, title, body, submitter, appName, sourceUrl, pagePath,
 *             images: [{name, mimeType, base64}] }
 *
 * 濫用対策（常時有効）: honeypot / レート制限(10分5件) / 文字数切り詰め / 画像上限。
 * 処理順: ①記録（master「不具合要望」シートに append → 読み戻して照合）→ ②通知。
 * 通知が失敗しても記録は成功として扱う。
 */
function FeedbackRelay_submitFromForm(payload) {
  payload = payload || {};

  // honeypot: 埋まっていたら bot とみなし、成功を装って何もせず破棄する（bot を学習させない）。
  if (String(payload.company || '').trim()) {
    return { ok: true };
  }

  if (!_FeedbackRelay_checkRateLimit()) {
    return { ok: false, error: 'しばらく時間をおいて再度お試しください' };
  }

  var title = String(payload.title || '').trim().slice(0, _FEEDBACK_RELAY_FORM_MAX_TITLE);
  var body = String(payload.body || '').trim().slice(0, _FEEDBACK_RELAY_FORM_MAX_BODY);
  if (!title && !body) {
    return { ok: false, error: 'タイトルか内容を入力してください' };
  }

  var kindLabel = String(payload.kind || '') === '要望' ? '要望' : '不具合';
  var appName = String(payload.appName || '').trim();
  var submitter = String(payload.submitter || '').trim();
  var sourceUrl = String(payload.sourceUrl || '').trim();
  var pagePath = String(payload.pagePath || '').trim();

  var candidates = _FeedbackRelay_decodeImages(payload.images);
  var selected = _FeedbackRelay_selectImages(candidates);

  // ①記録: master「不具合要望」シートへ append → 読み戻して照合
  var ms = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
  var log = _FeedbackRelay_ensureLogSheet(ms);
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var imageUrls = [];
  if (candidates.length) {
    var folder = _Feedback_getImageFolder();
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
    for (var i = 0; i < candidates.length; i++) {
      try {
        var saved = folder.createFile(
          candidates[i].blob.copyBlob().setName('fb_' + stamp + '_' + (i + 1) + '_' + candidates[i].name)
        );
        imageUrls.push(saved.getUrl());
      } catch (e) { /* 個別保存失敗は記録を止めない */ }
    }
  }
  var source = (appName || 'アプリ') + ' / フォーム';
  log.appendRow([now, kindLabel, title, body, 'new', '', imageUrls.join('\n'), source]);
  SpreadsheetApp.flush();
  var lastRow = log.getLastRow();
  var readBack = String(log.getRange(lastRow, 3).getValue() || '');
  if (readBack !== title) {
    return { ok: false, error: '記録の読み戻しに失敗しました' };
  }

  // ②通知: 失敗しても記録は成功として扱う（best-effort）
  var notify = { via: 'none' };
  try {
    notify = FeedbackRelay_submit({
      appName: appName,
      kind: kindLabel === '要望' ? 'request' : 'bug',
      title: title,
      body: body,
      submitter: submitter,
      pagePath: pagePath,
      sourceUrl: sourceUrl,
      imageBlobs: selected.map(function (item) { return item.blob; })
    });
  } catch (e) { /* 通知は best-effort */ }

  return { ok: true, logged: true, images: candidates.length, notified: notify.via !== 'none' };
}
