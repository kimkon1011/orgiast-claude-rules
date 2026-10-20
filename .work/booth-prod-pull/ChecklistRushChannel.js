/**
 * feedback-kit 1.0.0 導入で FeedbackRelay.js から外れた Discord チャンネル投稿系の後方互換。
 *
 * 当日チェックリスト（src/Checklist.js）の「🚨 倉庫へ緊急依頼」が
 * _FeedbackRelay_postToChannel / _FeedbackRelay_replyInChannel を直接呼ぶため、
 * 旧 FeedbackRelay.js（origin/master 時点）の実装を本文そのままここへ移した。
 * kit が置いた src/FeedbackRelay.js は編集しない（verify が検査する）。
 *
 * 依存は GAS の全ファイル共有スコープで解決する:
 * - _ES_validateDestination は src/EventShipping.js に定義済み（重複定義しない）
 * - DISCORD_WAREHOUSE_CHANNEL_ID は Script Properties の既存キー
 */

/**
 * 2 枚目以降の画像を保存する専用フォルダ（中継は screenshot を1枚しか受け取らないため）。
 * 他アプリへ移植してもそのまま動くよう、この関数だけで完結させる（外部フォルダIDに依存しない）。
 */
function _FeedbackRelay_extraImageFolder() {
  var name = 'FeedbackRelay添付（2枚目以降）';
  var folders = DriveApp.getRootFolder().getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.getRootFolder().createFolder(name);
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
    // 発送と共通の宛先検証を通す。取得には投稿と同じBotを使い、発送モードには依存しない。
    _ES_validateDestination(String(channelId), { kind: 'warehouse' }, function (id) {
      var current = UrlFetchApp.fetch('https://discord.com/api/v10/channels/' + encodeURIComponent(id), {
        method: 'get', headers: { Authorization: 'Bot ' + token }, muteHttpExceptions: true
      });
      var status = current.getResponseCode();
      if (status < 200 || status >= 300) throw new Error('Discord 宛先取得失敗 HTTP ' + status);
      return JSON.parse(current.getContentText());
    });
    var response = UrlFetchApp.fetch('https://discord.com/api/v10/channels/' + encodeURIComponent(String(channelId)) + '/messages', options);
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) return { ok: false, messageId: "", error: "Discord 投稿失敗 HTTP " + code };
    var body = {};
    try { body = JSON.parse(response.getContentText() || "{}"); } catch (parseError) { body = {}; }
    return { ok: true, messageId: String(body.id || "") };
  } catch (e) {
    return { ok: false, messageId: "", error: String(e && e.message ? e.message : e) };
  }
}

/** 倉庫の Discord チャンネル ID を Script Properties に保存する。 */
function Admin_setChecklistRushChannel(channelId) {
  var id = String(channelId || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, error: 'チャンネル ID が不正です' };
  PropertiesService.getScriptProperties().setProperty('DISCORD_WAREHOUSE_CHANNEL_ID', id);
  return { ok: true, channelId: id };
}
