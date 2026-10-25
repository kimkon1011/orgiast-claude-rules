const WARNING_OR_REMINDER = /⚠️|警告|リマインド|督促|期限|障害|停止中|滞留/iu;
const MERGE_REQUEST = /please\s+merge\b/iu;
const JAPANESE_REQUEST = /(?:マージ.{0,20}(?:お願い|してください|して下さい|して欲しい|してほしい|依頼)|(?:お願い|依頼).{0,20}マージ)/u;

/** kim 宛 Discord DM のうち、fleet-mail に回すべきマージ依頼だけを止める。 */
export function classifyKimDm(text) {
  const body = String(text ?? '');
  if (WARNING_OR_REMINDER.test(body)) {
    return { allowed: true, category: 'warning-or-reminder', reason: '警告・リマインドが明示されています' };
  }
  if (MERGE_REQUEST.test(body) || JAPANESE_REQUEST.test(body)) {
    return { allowed: false, category: 'merge-request', reason: 'PR のマージ依頼は fleet-mail で扱います' };
  }
  return { allowed: true, category: 'other', reason: 'マージ依頼ではありません' };
}
