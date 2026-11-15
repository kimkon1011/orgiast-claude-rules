// 【受信箱】節を他の Stop ゲートの走査対象から除外する共通ヘルパー。
// 受信箱節は【受信箱】見出しから次の見出し／末尾3行までの範囲。
// kim-inbox-relay 以外の本文を走査するゲートは、このヘルパーで受信箱節を除去したテキストを使う。

const INBOX_HEADING = /^.*【受信箱】.*$/m;

/**
 * テキストから【受信箱】節を除去したコピーを返す。
 * 【受信箱】見出しから次の `#` / `**` / 太字見出し / 末尾3行 までを除外する。
 * 受信箱節が無い場合は元のテキストをそのまま返す。
 */
export function stripInboxSection(text) {
  const match = INBOX_HEADING.exec(text);
  if (!match) return text;
  const afterHeading = text.slice(match.index + match[0].length);
  // 次の見出し（# または **【）または「次に kim がすること:」「この後の自動進行:」「このセッション:」の前までが受信箱節
  const endMatch = afterHeading.search(/\n\s*(?:#{1,6}\s|(?:\*\*)?【(?!受信箱)|次に kim がすること:|この後の自動進行:|このセッション:)/);
  const end = endMatch >= 0 ? match.index + match[0].length + endMatch : text.length;
  // 末尾3行を超えない
  const lines = text.split(/\r?\n/);
  const lineStart = text.slice(0, end).split(/\r?\n/).length;
  const tailStart = Math.max(0, lines.length - 3);
  const actualEnd = lineStart > tailStart ? text.split('\n').slice(0, tailStart).join('\n').length : end;
  return text.slice(0, match.index) + text.slice(actualEnd);
}

/**
 * テキストからコードブロック・引用・**受信箱節**を除去したプレーンテキストを返す。
 * deliverable-drive-link-gate など stripQuoted と併用するゲート向け。
 */
export function stripInboxAndQuoted(text) {
  return stripInboxSection(String(text || '').replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '').replace(/^[ \t]*>.*$/gm, ''));
}

/** テスト用: 受信箱節の有無・範囲を検証する。 */
export function inboxSectionRange(text) {
  const match = INBOX_HEADING.exec(text);
  if (!match) return null;
  const afterHeading = text.slice(match.index + match[0].length);
  const endMatch = afterHeading.search(/\n\s*(?:#{1,6}\s|(?:\*\*)?【(?!受信箱)|次に kim がすること:|この後の自動進行:|このセッション:)/);
  const end = endMatch >= 0 ? match.index + match[0].length + endMatch : text.length;
  return { start: match.index, end };
}