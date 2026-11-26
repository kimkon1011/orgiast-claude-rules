#!/usr/bin/env node
// 停滞セッション通知の kind（ask/info）を判定する純関数。
// kim 本人にしかできない操作・判断だけを ask とし、迷うものも安全側で ask にする。

const THIRD_PARTY_OR_DELEGATED_PATTERNS = [
  /PRの競合解消には担当者のレビュー・マージ指示が必要/u,
  /(?:さん|様|先方|お客様|取引先|クライアント)[^。\n]{0,40}(?:返信|返答|回答|連絡|フリガナ|未確定|権限|復旧|依頼)/u,
  /(?:担当者|レビュアー|第三者)[^。\n]{0,40}(?:レビュー|マージ|返信|情報|対応|依頼)/u,
  /(?:他|別)の[^。\n]{0,20}セッション.*(?:着手|進行|claim|担当)/u,
  /(?:並行|競合).*?セッション/u,
];

const CONTINUABLE_PATTERNS = [
  /(?:作業(?:が)?途中|時間切れ|期限(?:を)?超過|続きから|未完了のまま|途中で止ま|検証が未完了|原因調査が途中)/u,
  /(?:Codex|Claude)[^。\n]{0,40}(?:バックグラウンド実行|実行中|実装結果|read-back|自動進行)/iu,
  /(?:実行結果の確認|テスト|検証|原因調査|read-back|PR の着地).*?(?:必要|未完了)/u,
  /委譲ゲート/u,
  /引き継ぎの判断が必要/u,
  /依存パッケージのインストールには権限が必要/u,
];

const EXTERNAL_CAPACITY_PATTERNS = [
  /(?:API|サービス)?[^。\n]{0,20}(?:利用制限|利用上限|枠|残高)[^。\n]{0,30}(?:到達|達した|不足|回復待ち|解除されるまで待機)/u,
  /利用上限到達で停止/u,
];

const PAYMENT_OR_ACCOUNT_PATTERNS = [
  /(?:入金|支払|課金|購入|発注|契約|決裁)/u,
  /(?:ログイン|再認証|別アカウント|アカウント作成)/u,
];

const SENSITIVE_ACTION_PATTERNS = [
  /(?:削除してよい|削除可否|削除承認|削除OK|削除の可否)/u,
  /(?:社外送信|公開範囲変更|公開の最終|送信してよい)/u,
  /(?:権限|共有|サンドボックス)(?:や|・|の)?(?:設定)?変更/u,
];

const KIM_DECISION_PATTERNS = [
  /kim(?:\s*本人)?(?:の|に|が|へ|を)[^。\n]{0,50}(?:承認|許可|可否|判断|同意|返事|返信|回答|選択|決裁)/iu,
  /金さん(?:の|に|が|へ|を)[^。\n]{0,50}(?:承認|許可|可否|判断|同意|返事|返信|回答|選択|決裁)/u,
  /(?:kim|金さん)[^。\n]{0,20}(?:A\s*[／/]\s*B|どれか|入金する|削除OK|残す)/iu,
  /(?:承認待ち|明示的な同意が必要)/u,
];

export function decideStalledNoticeKind({ reason = '', nextStep = '' }) {
  const text = `${reason} ${nextStep}`;

  if (PAYMENT_OR_ACCOUNT_PATTERNS.some(pattern => pattern.test(text))) return 'ask';
  if (THIRD_PARTY_OR_DELEGATED_PATTERNS.some(pattern => pattern.test(reason))) return 'info';
  if (EXTERNAL_CAPACITY_PATTERNS.some(pattern => pattern.test(reason))) return 'info';
  if (CONTINUABLE_PATTERNS.some(pattern => pattern.test(reason))) return 'info';
  if (SENSITIVE_ACTION_PATTERNS.some(pattern => pattern.test(text))) return 'ask';
  if (KIM_DECISION_PATTERNS.some(pattern => pattern.test(text))) return 'ask';

  return 'ask';
}
