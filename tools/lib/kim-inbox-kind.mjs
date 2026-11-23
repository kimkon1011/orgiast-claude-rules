/**
 * kim-inbox の kind 判定に関する共有ユーティリティ。
 * --sweep-info の除外判定と --add 時の kind 自動昇格で同じロジックを使う。
 */

/**
 * 本文が kim に承認・判断を求めているように見えるかを判定する。
 * これに該当する info は自動 seen の対象外であり、登録時には ask へ昇格すべき。
 * @param {string} text - 項目の本文
 * @returns {boolean}
 */
export function looksLikeApprovalRequest(text) {
  return /承認|判断|どちら|YES|決めて/.test(String(text ?? ''));
}