/**
 * weekly-photo-list Setup
 *
 * 初回準備: setupOnce() だけを実行する。
 * 以降は CommandQueue 経由で設定・操作する。
 */

// ---- 設定の既定値 ----
var CMD_FOLDER_NAME_ = 'claude-weekly-photo-list-cmds';
var TRIGGER_HANDLER_ = 'processCommandQueue';

/**
 * 初回セットアップ。
 * Script Properties の初期化 + コマンドキューインストール。
 * kim が clasp push 後に ▶実行するのはこの関数だけ。
 */
function setupOnce() {
  var props = PropertiesService.getScriptProperties();

  // フォルダID（未設定なら空。後で CommandQueue の setPhotoFolder で設定）
  if (!props.getProperty('PHOTO_FOLDER_ID')) {
    props.setProperty('PHOTO_FOLDER_ID', '');
  }
  // 送信先メールアドレス（カンマ区切り。後で CommandQueue の setRecipients で設定）
  if (!props.getProperty('RECIPIENT_EMAILS')) {
    props.setProperty('RECIPIENT_EMAILS', '');
  }
  // 送信時刻（HH:mm 形式、既定 月曜 08:00）
  if (!props.getProperty('SEND_TIME')) {
    props.setProperty('SEND_TIME', '08:00');
  }

  installCommandQueue();

  console.log('weekly-photo-list setupOnce OK');
  console.log('PHOTO_FOLDER_ID: ' + (props.getProperty('PHOTO_FOLDER_ID') || '(未設定)'));
  console.log('RECIPIENT_EMAILS: ' + (props.getProperty('RECIPIENT_EMAILS') || '(未設定)'));
  console.log('SEND_TIME: ' + props.getProperty('SEND_TIME'));
}