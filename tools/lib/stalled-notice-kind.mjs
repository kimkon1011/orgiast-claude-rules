#!/usr/bin/env node
// 停滞セッション通知の kind（ask/info）を判定する純関数。
// kim の操作が必要な理由は ask、第三者待ち・他セッション着手中・単なる時間切れは info。
// 判定に迷うものは安全側で ask にする。

// kim の操作語 — ひとつでも含まれていたら無条件で ask
const KIM_ACTION_TERMS = [
  /承認/u,
  /許可/u,
  /可否/u,
  /支払/u,
  /入金/u,
  /課金/u,
  /残高/u,
  /クレジット/u,
  /ログイン/u,
  /認証/u,
  /権限/u,
  /招待/u,
  /購入/u,
  /契約/u,
  /発注/u,
  /決裁/u,
  /要否の判断/u,
  /判断してください/u,
  /指示が必要/u,
  /削除してよい/u,
  /送信してよい/u,
];

// info にしてよいパターン
const INFO_PATTERNS = [
  // (a) 第三者からの返答待ち
  /(?:さん|様|先方|お客様|取引先|クライアント)[^。\n]{0,20}(?:返信|返答|回答|連絡)/u,
  // (b) 他セッションが着手中
  /(?:他|別)の[^。\n]{0,12}セッション(?:.*(?:着手|進行|claim|担当))/u,
  // (c) 単なる作業途中・時間切れ
  /(?:作業(?:が)?途中|時間切れ|期限(?:を)?超過|続きから|未完了のまま|途中で止ま)/u,
];

export function decideStalledNoticeKind({ reason = '', nextStep = '' }) {
  const text = `${reason} ${nextStep}`;

  // kim の操作語がひとつでも含まれていたら無条件で ask
  for (const term of KIM_ACTION_TERMS) {
    if (term.test(text)) return 'ask';
  }

  // info にしてよいパターン
  for (const pattern of INFO_PATTERNS) {
    if (pattern.test(text)) return 'info';
  }

  // 既定は安全側で ask
  return 'ask';
}