/**
 * 全社標準「不具合・要望」フォーム + 中継クライアント（GAS 版）。
 *
 * 背景: 社内アプリの不具合・要望は全社共通の中継 (POST <FEEDBACK_RELAY_URL>) を通って
 * 開発担当の Discord DM に届く仕組みが本番稼働している（Next.js 版は
 * orgiast-claude-rules/packages/feedback-widget）。本ファイルはその GAS 版で、
 * どの GAS プロジェクトへもそのまま移植できるよう、Script Properties 読み取り以外の
 * 外部依存を持たない（このファイルと ui/FeedbackForm.html の2つをコピーすれば動く）。
 *
 * 設定は Script Properties から読む（値そのものはコードに書かない。Admin_setFeedbackRelay
 * で設定する。詳細は INSTALL.md）:
 *   FEEDBACK_RELAY_URL       中継の POST 先 URL
 *   FEEDBACK_RELAY_SECRET    共有シークレット
 *   FEEDBACK_APP_NAME        既定のアプリ名（呼び出し側が省略した場合に使う）
 *   FEEDBACK_FORM_URL        フォームの /exec URL（各画面にリンクを置く用途。無くても動く）
 *   FEEDBACK_OWNER_DISCORD_ID このアプリを開発した人の Discord user ID
 *   DISCORD_BOT_TOKEN        Discord Bot トークン（DM 送信用。webhook では DM できない）
 *   DISCORD_DM_USER_ID       DM の送信先ユーザーID
 *   FEEDBACK_WORKSPACE_DOMAIN シートURLに挟む Workspace ドメイン（未設定なら素URL）
 *   DISCORD_FEEDBACK_WEBHOOK 中継が失敗した場合のフォールバック先（無くても動く）
 *   FEEDBACK_LOG_SS_ID       記録先スプレッドシートID（未設定ならアクティブなスプレッドシート）
 *   FEEDBACK_LOG_SHEET_NAME  記録先シート名（未設定なら既定値 '不具合要望'）
 *
 * 記録先は他に、FeedbackRelay_submitFromForm への payload で
 * logSpreadsheetId / logSheetName を渡しても上書きできる（呼び出し側が明示的に渡すケース用）。
 * 優先順位: payload 指定 > Script Properties > アクティブなスプレッドシート（シートは自動作成）。
 */

var _FEEDBACK_RELAY_MAX_TITLE = 200;
var _FEEDBACK_RELAY_MAX_BODY = 4000;

/** 未認証で開ける投稿フォーム用の 画像/本文 濫用対策の上限（screenshot 8MB 以下と揃える）。 */
var _FEEDBACK_RELAY_FORM_MAX_TITLE = 200;
var _FEEDBACK_RELAY_FORM_MAX_BODY = 4000;
var _FEEDBACK_RELAY_IMG_MAX_BYTES = 8 * 1024 * 1024;
var _FEEDBACK_RELAY_IMG_MAX_TOTAL = 25 * 1024 * 1024;
var _FEEDBACK_RELAY_IMG_MAX_COUNT = 5;

var _FEEDBACK_RELAY_RATE_LIMIT = 5;
var _FEEDBACK_RELAY_RATE_WINDOW_SEC = 10 * 60;

/** 既定の記録先シート名（Script Property FEEDBACK_LOG_SHEET_NAME 未設定時に使う）。 */
var _FEEDBACK_RELAY_DEFAULT_LOG_SHEET_NAME = '不具合要望';

function _FeedbackRelay_config() {
  var props = PropertiesService.getScriptProperties();
  return {
    url: String(props.getProperty('FEEDBACK_RELAY_URL') || ''),
    secret: String(props.getProperty('FEEDBACK_RELAY_SECRET') || ''),
    appName: String(props.getProperty('FEEDBACK_APP_NAME') || ''),
    ownerDiscordId: String(props.getProperty('FEEDBACK_OWNER_DISCORD_ID') || ''),
    webhook: String(props.getProperty('DISCORD_FEEDBACK_WEBHOOK') || ''),
    logSsId: String(props.getProperty('FEEDBACK_LOG_SS_ID') || ''),
    logSheetName: String(props.getProperty('FEEDBACK_LOG_SHEET_NAME') || ''),
    botToken: String(props.getProperty('DISCORD_BOT_TOKEN') || ''),
    dmUserId: String(props.getProperty('DISCORD_DM_USER_ID') || ''),
    workspaceDomain: String(props.getProperty('FEEDBACK_WORKSPACE_DOMAIN') || '')
  };
}

/**
 * 画像添付を保存する専用フォルダ（中継は screenshot を1枚しか受け取らないため、
 * 記録用の全画像 / 通知に載せきれない2枚目以降はここに保存する）。
 * 他アプリへ移植してもそのまま動くよう、この関数だけで完結させる（外部フォルダIDに依存しない）。
 */
function _FeedbackRelay_attachmentFolder(name) {
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
    var folder = _FeedbackRelay_attachmentFolder('FeedbackRelay添付（2枚目以降）');
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
  if (/^\d{17,20}$/.test(String(config.ownerDiscordId || ''))) {
    form.owner_discord_id = String(config.ownerDiscordId);
  }
  if (/^\d{17,20}$/.test(String(payload.submitterDiscordId || ''))) {
    form.submitter_discord_id = String(payload.submitterDiscordId);
  }
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

/**
 * FeedbackRelay_submit(payload) -> { ok, relayed, via: 'relay'|'webhook'|'none', error? }
 * payload = { appName, kind, title, body, submitter, pagePath, sourceUrl, imageBlobs: [Blob] }
 *
 * 例外は投げない。中継が失敗したら Script Property DISCORD_FEEDBACK_WEBHOOK があれば
 * 従来どおり webhook へフォールバックする。設定が何も無ければ { ok:true, relayed:false, via:'none' }。
 * 呼び出し側は via で分岐する必要はない（記録が本体、通知は best-effort）。
 */
/**
 * Discord Bot で DM を送る。webhook はチャンネル投稿しかできず DM できないため Bot API を使う。
 * 失敗は例外にせず false を返す（通知は best-effort、記録を止めない）。
 */
function _FeedbackRelay_postDm(token, userId, content, blobs) {
  try {
    var channelResponse = UrlFetchApp.fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'post', headers: { Authorization: 'Bot ' + token }, contentType: 'application/json',
      payload: JSON.stringify({ recipient_id: String(userId) }), muteHttpExceptions: true
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
      options = { method: 'post', headers: { Authorization: 'Bot ' + token }, contentType: 'application/json',
        payload: JSON.stringify({ content: text }), muteHttpExceptions: true };
    }
    var messageResponse = UrlFetchApp.fetch(
      'https://discord.com/api/v10/channels/' + encodeURIComponent(String(channel.id)) + '/messages', options);
    var messageCode = messageResponse.getResponseCode();
    return messageCode >= 200 && messageCode < 300;
  } catch (e) {
    return false;
  }
}

/**
 * 記録シートの URL。FEEDBACK_WORKSPACE_DOMAIN があれば /a/<domain>/ を挟む
 * （素 URL はブラウザ既定の個人アカウントで開いて「アクセス権が必要です」になる）。
 */
function _FeedbackRelay_sheetUrl(config, ss, sheet) {
  var base = config && config.workspaceDomain
    ? 'https://docs.google.com/a/' + config.workspaceDomain + '/spreadsheets/d/' + ss.getId() + '/edit'
    : ss.getUrl();
  return base + '#gid=' + sheet.getSheetId();
}

/** Discord DM 設定を Script Properties に保存する。トークン値は返さない。 */
function Admin_setFeedbackDiscord(botToken, dmUserId) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DISCORD_BOT_TOKEN', String(botToken || ''));
  props.setProperty('DISCORD_DM_USER_ID', String(dmUserId || ''));
  return { ok: true, set: { botToken: Boolean(botToken), dmUserId: String(dmUserId || '') } };
}

/** 疎通確認: DM を1回実送信する。導入完了はこれで着信を見てから（設定だけで完了と呼ばない）。 */
function FeedbackRelay_testDm() {
  var config = _FeedbackRelay_config();
  if (!(config.botToken && config.dmUserId)) return { ok: false, sent: false, via: 'none', error: 'DM: 未設定' };
  var sent = _FeedbackRelay_postDm(config.botToken, config.dmUserId, '疎通テストです（無視してください）', []);
  return { ok: sent, sent: sent, via: sent ? 'dm' : 'none', error: sent ? undefined : 'DM: 送信失敗' };
}

/** 未対応の毎日プッシュを重複なく1本だけ設置する（GAS のトリガー上限は 20 本）。 */
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

function FeedbackRelay_submit(payload) {
  payload = payload || {};
  try {
    var config = _FeedbackRelay_config();
    var blobs = Array.isArray(payload.imageBlobs) ? payload.imageBlobs : [];
    // (1)中継 -> (2)Bot DM -> (3)webhook。先に成功した1つで止める。
    // 通知先ゼロだと「記録は残るが誰も気づかない」になるため、全滅時は理由を error に残す。
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
function Admin_setFeedbackRelay(url, secret, appName, formUrl, ownerDiscordId) {
  var props = PropertiesService.getScriptProperties();
  if (url !== undefined && url !== null) props.setProperty('FEEDBACK_RELAY_URL', String(url));
  if (secret !== undefined && secret !== null) props.setProperty('FEEDBACK_RELAY_SECRET', String(secret));
  if (appName !== undefined && appName !== null) props.setProperty('FEEDBACK_APP_NAME', String(appName));
  // 各画面に置く「🐛 不具合・要望」リンクの組み立て元。Web アプリの /exec URL をそのまま入れる。
  if (formUrl !== undefined && formUrl !== null) props.setProperty('FEEDBACK_FORM_URL', String(formUrl));
  // 既存の4引数呼び出しでは、設定済みの開発者IDを変更しない。
  if (ownerDiscordId !== undefined && ownerDiscordId !== null) props.setProperty('FEEDBACK_OWNER_DISCORD_ID', String(ownerDiscordId));
  return {
    ok: true,
    set: {
      url: Boolean(url), secret: Boolean(secret),
      appName: String(appName || ''), formUrl: Boolean(formUrl), ownerDiscordId: Boolean(ownerDiscordId)
    }
  };
}

/**
 * Drive 上の JSON ファイルから設定を読み込んで反映する。
 *
 * なぜこれが要るか: 設定にはシークレットが含まれるため、コマンドキューの JSON に直接書くと
 * 「秘密値が会話ログや Drive のコマンドファイルに残る」。ファイルIDだけを渡す形にすれば、
 * 秘密値は自分が管理する1ファイルの中だけに閉じ、使い終わったら消せる。
 *
 * ファイルの中身: { "url": "...", "secret": "...", "appName": "...", "formUrl": "..." }
 * 反映後は呼び出し側でそのファイルを削除すること（この関数は消さない＝取り違えで他人のファイルを消さないため）。
 */
function Admin_setFeedbackRelayFromFile(fileId) {
  if (!fileId) return { ok: false, error: 'fileId は必須' };
  var raw = '';
  try {
    raw = DriveApp.getFileById(String(fileId)).getBlob().getDataAsString('UTF-8');
  } catch (e) {
    return { ok: false, error: '設定ファイルを読めません: ' + e.message };
  }
  var cfg = null;
  try { cfg = JSON.parse(raw); } catch (e) { return { ok: false, error: '設定ファイルが JSON ではありません' }; }
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: '設定ファイルの中身が不正' };
  return Admin_setFeedbackRelay(cfg.url, cfg.secret, cfg.appName, cfg.formUrl, cfg.ownerDiscordId);
}

/** 読み取り専用の疎通確認。値そのものは返さない。 */
function FeedbackRelay_ping() {
  var config = _FeedbackRelay_config();
  return {
    ok: true,
    hasUrl: Boolean(config.url),
    hasSecret: Boolean(config.secret),
    hasOwnerDiscordId: /^\d{17,20}$/.test(config.ownerDiscordId),
    appName: config.appName,
    webhookFallback: Boolean(config.webhook),
    dmConfigured: Boolean(config.botToken && config.dmUserId),
    logSpreadsheet: config.logSsId ? 'configured' : 'active-spreadsheet',
    logSheetName: config.logSheetName || _FEEDBACK_RELAY_DEFAULT_LOG_SHEET_NAME
  };
}

// ---------------------------------------------------------------------------
// 未認証フォーム (doGet ?form=feedback) 用: 濫用対策つきの記録+通知エントリポイント
// ---------------------------------------------------------------------------

/**
 * トークン無しで開けるフォームページを返す。呼び出し元アプリの doGet から
 * token 検証より前に呼ぶ（報告者に token を配れないため。詳細は INSTALL.md）。
 * app / src はテンプレート内で <?= ?>（エスケープあり）にのみ渡す。
 */

/** フォームHTMLのテンプレートを、プロジェクト構成に依存せず読み込む。 */
function _FeedbackRelay_loadFormTemplate() {
  var candidates = [];
  try {
    var explicit = PropertiesService.getScriptProperties().getProperty('FEEDBACK_FORM_TEMPLATE');
    if (explicit) candidates.push(explicit);
  } catch (e) { /* プロパティが読めなくても既定候補で続行する */ }
  candidates.push('ui/FeedbackForm');
  candidates.push('FeedbackForm');
  var lastError = null;
  for (var i = 0; i < candidates.length; i++) {
    try { return HtmlService.createTemplateFromFile(candidates[i]); } catch (e) { lastError = e; }
  }
  throw new Error('FeedbackForm.html が見つかりません（試した名前: ' + candidates.join(', ') + '）'
    + ' Script Property FEEDBACK_FORM_TEMPLATE で明示してください。'
    + (lastError ? ' 詳細: ' + lastError.message : ''));
}

/** Collect every unfinished feedback row, including rows with a response note. */
function FeedbackRelay_nagPending(opts) {
  opts = opts || {};
  try {
    var config = _FeedbackRelay_config();
    var ss = config.logSsId ? SpreadsheetApp.openById(config.logSsId) : SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(config.logSheetName || _FEEDBACK_RELAY_DEFAULT_LOG_SHEET_NAME);
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
    lines.push(_FeedbackRelay_sheetUrl(config, ss, sheet));
    var content = lines.join('\n');
    if (opts.dryRun === true) return { ok: true, count: items.length, items: items, content: content };
    if (config.botToken && config.dmUserId && _FeedbackRelay_postDm(config.botToken, config.dmUserId, content, [])) {
      return { ok: true, count: items.length, sent: true, via: 'dm' };
    }
    if (config.webhook && _FeedbackRelay_postWebhook(config.webhook, content, [])) return { ok: true, count: items.length, sent: true, via: 'webhook' };
    var configured = Boolean((config.botToken && config.dmUserId) || config.webhook);
    return { ok: true, count: items.length, sent: false, via: 'none', reason: configured ? '通知送信失敗' : '通知先未設定' };
  } catch (e) {
    return { ok: false, count: 0, sent: false, via: 'none', reason: String(e && e.message ? e.message : e) };
  }
}

function FeedbackRelay_serveForm(params) {
  var opts = params || {};
  // HTML のファイル名はプロジェクト構成で変わる(src/ui/ 配下 or 平置き)。
  // 決め打ちにすると「ui/FeedbackForm が無い」で落ちるので候補を順に試す。
  // Script Property FEEDBACK_FORM_TEMPLATE で明示指定も可能。
  var template = _FeedbackRelay_loadFormTemplate();
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

/**
 * 記録先スプレッドシートを解決する。
 * 優先順位: payload 指定 (logSpreadsheetId) > Script Property FEEDBACK_LOG_SS_ID >
 * アクティブなスプレッドシート（コンテナバインドのスクリプトのみ取得できる）。
 * どれも無ければ例外を投げる（呼び出し側で捕捉して分かりやすいメッセージに変換すること）。
 */
function _FeedbackRelay_resolveLogSpreadsheet(config, payload) {
  var ssId = String((payload && payload.logSpreadsheetId) || config.logSsId || '');
  if (ssId) return SpreadsheetApp.openById(ssId);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error(
    '記録先スプレッドシートが特定できません。Script Property FEEDBACK_LOG_SS_ID を設定するか、' +
    'このスクリプトをスプレッドシートにコンテナバインドしてください。'
  );
}

/** 記録先シート名を解決する（payload 指定 > Script Property > 既定値）。 */
function _FeedbackRelay_resolveLogSheetName(config, payload) {
  return String((payload && payload.logSheetName) || config.logSheetName || _FEEDBACK_RELAY_DEFAULT_LOG_SHEET_NAME);
}

/** 記録先シートを用意する。無ければ作成しヘッダを揃える（他ファイルの関数には一切依存しない）。 */
function _FeedbackRelay_ensureLogSheet(ss, sheetName) {
  var log = ss.getSheetByName(sheetName);
  if (!log) {
    log = ss.insertSheet(sheetName);
    log.getRange(1, 1, 1, 8).setValues([['日時', '種別', 'タイトル', '内容', '状態', '対応メモ', '画像', '送信元']])
      .setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
    log.setFrozenRows(1);
    log.setColumnWidth(1, 130); log.setColumnWidth(3, 240); log.setColumnWidth(4, 420);
  }
  return log;
}

/**
 * FeedbackRelay_submitFromForm(payload) — google.script.run から呼ばれる、未認証フォームの送信口。
 * payload = { company(honeypot), kind, title, body, submitter, submitterDiscordId?, appName, sourceUrl, pagePath,
 *             images: [{name, mimeType, base64}], logSpreadsheetId?, logSheetName? }
 *
 * 濫用対策（常時有効）: honeypot / レート制限(10分5件) / 文字数切り詰め / 画像上限。
 * 処理順: ①記録（記録先シートに append → 読み戻して照合）→ ②通知。
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
  var submitterDiscordId = /^\d{17,20}$/.test(String(payload.submitterDiscordId || '').trim())
    ? String(payload.submitterDiscordId).trim() : '';
  var sourceUrl = String(payload.sourceUrl || '').trim();
  var pagePath = String(payload.pagePath || '').trim();

  var candidates = _FeedbackRelay_decodeImages(payload.images);
  var selected = _FeedbackRelay_selectImages(candidates);

  // ①記録: 記録先シートへ append → 読み戻して照合
  var config = _FeedbackRelay_config();
  var ss;
  try {
    ss = _FeedbackRelay_resolveLogSpreadsheet(config, payload);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  var sheetName = _FeedbackRelay_resolveLogSheetName(config, payload);
  var log = _FeedbackRelay_ensureLogSheet(ss, sheetName);
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var imageUrls = [];
  if (candidates.length) {
    var folder = _FeedbackRelay_attachmentFolder('FeedbackRelay添付');
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
  var logHeaders = log.getRange(1, 1, 1, log.getLastColumn()).getValues()[0]
    .map(function (value) { return String(value || '').trim(); });
  var valuesByHeader = {
    '日時': now, '種別': kindLabel, 'タイトル': title, '内容': body, '状態': 'new',
    '対応メモ': '', '画像': imageUrls.join('\n'), '送信元': source, '提出者ID': submitterDiscordId
  };
  var logRow = logHeaders.map(function (header) {
    return Object.prototype.hasOwnProperty.call(valuesByHeader, header) ? valuesByHeader[header] : '';
  });
  var lastRow = log.getLastRow() + 1;
  log.getRange(lastRow, 1, 1, logRow.length).setValues([logRow]);
  SpreadsheetApp.flush();
  var titleColumn = logHeaders.indexOf('タイトル');
  var readBack = titleColumn >= 0 ? String(log.getRange(lastRow, titleColumn + 1).getValue() || '') : '';
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
      submitterDiscordId: submitterDiscordId,
      pagePath: pagePath,
      sourceUrl: sourceUrl,
      imageBlobs: selected.map(function (item) { return item.blob; })
    });
  } catch (e) { /* 通知は best-effort */ }

  return { ok: true, logged: true, images: candidates.length, notified: notify.via !== 'none' };
}
