// Bot DM 例外の判定は isAutoreplyCategory の2カテゴリだけ。
// classifyKimDm の旧分類はマージ依頼を fleet-mail へ回すために残す（DM 許可ではない）。
const WARNING_OR_REMINDER = /⚠️|警告|リマインド|督促|期限|障害|停止中|滞留/iu;
const MERGE_REQUEST = /please\s+merge\b/iu;
const JAPANESE_REQUEST = /(?:マージ.{0,20}(?:お願い|してください|して下さい|して欲しい|してほしい|依頼)|(?:お願い|依頼).{0,20}マージ)/u;

/** kim 宛 Discord DM のうち、fleet-mail に回すべきマージ依頼だけを止める。 */
// Explicit caller category, never inferred from message text or a local allowlist.
export function isAutoreplyCategory(category) {
  return category === 'autoreply-decision' || category === 'autoreply-sent';
}
export function classifyKimDm(text, { category } = {}) {
  if (isAutoreplyCategory(category)) return { allowed: true, category, reason: 'Discord 自動返信の承認済み報告' };
  const body = String(text ?? '');
  if (WARNING_OR_REMINDER.test(body)) {
    return { allowed: true, category: 'warning-or-reminder', reason: '警告・リマインドが明示されています' };
  }
  if (MERGE_REQUEST.test(body) || JAPANESE_REQUEST.test(body)) {
    return { allowed: false, category: 'merge-request', reason: 'PR のマージ依頼は fleet-mail で扱います' };
  }
  return { allowed: true, category: 'other', reason: 'マージ依頼ではありません' };
}

export const KIM_DISCORD_USER_ID = '715210673642012733';
export function isKimRecipient({ id, name, owner, defaultKim = false } = {}) {
  return defaultKim || String(id ?? '').trim() === KIM_DISCORD_USER_ID
    || ['kim', 'kimkon.', '金功勇', 'kim@orgiast.jp'].includes(String(name ?? '').trim().toLowerCase())
    || String(owner ?? '').trim().toLowerCase() === 'kim@orgiast.jp';
}
