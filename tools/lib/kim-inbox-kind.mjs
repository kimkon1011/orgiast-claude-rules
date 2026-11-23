/**
 * kim-inbox の kind 判定に関する共通ロジックを提供するモジュール
 */

/**
 * 本文が承認を要求しているかどうかを判定する
 * @param {string} text - 判定対象のテキスト
 * @returns {boolean} 承認を要求している場合は true、そうでない場合は false
 */
export function looksLikeApprovalRequest(text) {
  return /承認|判断|どちら|YES|決めて/.test(text || '');
}
