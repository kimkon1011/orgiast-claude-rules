/**
 * ai-sales-sync Setup
 *
 * 毎朝Slackに売上レポートを自動投稿する GAS。
 * 案件管理シート（container-bound）から売上を集計し、
 * Slack Incoming Webhook へ JSON POST する。
 *
 * 初回準備: setupOnce() だけを実行する。
 * 以降は CommandQueue 経由で設定・操作する。
 */

// ---- 設定の既定値 ----
var CMD_FOLDER_NAME_ = 'claude-ai-sales-sync-cmds';
var TRIGGER_HANDLER_ = 'processCommandQueue';

/**
 * 初回セットアップ。
 * Script Properties の初期化 + コマンドキューインストール。
 * kim が clasp push 後に ▶実行するのはこの関数だけ。
 */
function setupOnce() {
  var props = PropertiesService.getScriptProperties();

  // Slack Webhook URL（後で setSlackWebhook で設定）
  if (!props.getProperty('SLACK_WEBHOOK_URL')) {
    props.setProperty('SLACK_WEBHOOK_URL', '');
  }

  // 案件管理シートのシート名（既定）
  if (!props.getProperty('SHEET_NAME')) {
    props.setProperty('SHEET_NAME', '案件一覧');
  }

  // 日付列のカラムインデックス（1始まり / A=1, B=2, ...）
  // 既定: G列(7) = 初回連絡日
  if (!props.getProperty('DATE_COLUMN_INDEX')) {
    props.setProperty('DATE_COLUMN_INDEX', '7');
  }

  // ステータス列のカラムインデックス（1始まり）
  // 既定: C列(3)
  if (!props.getProperty('STATUS_COLUMN_INDEX')) {
    props.setProperty('STATUS_COLUMN_INDEX', '3');
  }

  // 売上金額列のカラムインデックス（1始まり）
  // 既定: S列(19) — 売上/利益 の合算列
  if (!props.getProperty('SALES_COLUMN_INDEX')) {
    props.setProperty('SALES_COLUMN_INDEX', '19');
  }

  // 売上集計対象のステータス（カンマ区切り）
  // 既定: 受注,請求済,入金済
  if (!props.getProperty('TARGET_STATUSES')) {
    props.setProperty('TARGET_STATUSES', '受注,請求済,入金済');
  }

  // デフォルトの集計日数（直近日数）
  // 既定: 7（直近7日間）
  if (!props.getProperty('DEFAULT_DAYS')) {
    props.setProperty('DEFAULT_DAYS', '7');
  }

  // 送信時刻（HH:mm 形式）
  if (!props.getProperty('SEND_TIME')) {
    props.setProperty('SEND_TIME', '09:00');
  }

  installCommandQueue();

  console.log('ai-sales-sync setupOnce OK');
  console.log('SHEET_NAME: ' + props.getProperty('SHEET_NAME'));
  console.log('TARGET_STATUSES: ' + props.getProperty('TARGET_STATUSES'));
  console.log('DEFAULT_DAYS: ' + props.getProperty('DEFAULT_DAYS'));
  console.log('SEND_TIME: ' + props.getProperty('SEND_TIME'));
  console.log('SLACK_WEBHOOK_URL: ' + (props.getProperty('SLACK_WEBHOOK_URL') ? '(設定済み)' : '(未設定)'));
}