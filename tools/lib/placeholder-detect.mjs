// 送信本文に含まれてはいけない伏せ字・プレースホルダを検出する。
// discord-dm.mjs / mail-send-approval-gate.mjs / send-context-check.mjs から共用する。
// 事故: 2026-11-09 無人セッションが [REDACTED] を含む本文を DM 送信した。

// 検出パターン: 送信前に本文に残っていてはいけない文字列。
// URL・トークン類は webhook-health.mjs の redactSecrets が除去した残骸として現れる。
const PLACEHOLDER_PATTERNS = [
  // redact.mjs / safeContent 由来の伏せ字
  /\[REDACTED\]/,
  /<redacted>/i,
  // URL 内の伏せ字（https://.../***/... の *** 部分）
  /https?:\/\/[^\s]*\*{3,}[^\s]*/,
  // 未置換の波かっこ変数（テンプレートリテラルで残った {VAR_NAME}）
  /\{[A-Z_][A-Z0-9_]+\}/,
  // 「別途お伝えします」型の空欄プレースホルダ
  /\([^)]*別途[^)]*\)/,
  /「[^」]*別途[^」]*」/,
  // 空の波かっこ
  /\{\s*\}/,
  // TODO / FIXME が本文に残っている
  /\bTODO\b/i,
  /\bFIXME\b/i,
  // unset / unknown のプレースホルダ
  /\b(?:to_be_set|tbd|placeholder|insert_text_here)\b/i,
];

/**
 * 本文に伏せ字・プレースホルダが残っているか検査する。
 * @param {string} body - 送信しようとしている本文
 * @returns {{ hasPlaceholder: boolean, matches: string[] }}
 *   hasPlaceholder: 検出した場合 true
 *   matches: 検出したパターンの抜粋（最大5件）
 */
export function detectPlaceholders(body) {
  const text = String(body ?? '');
  const matches = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // マッチした文字列を安全に短く切り詰める
      const snippet = match[0].length > 60 ? match[0].slice(0, 57) + '...' : match[0];
      matches.push(snippet);
      if (matches.length >= 5) break;
    }
  }
  return { hasPlaceholder: matches.length > 0, matches };
}