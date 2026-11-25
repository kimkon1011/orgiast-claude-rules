// 末尾の prompt-journal-answered 行（複数可・間の空行可）を判定前に取り除く。
// UserPromptSubmit hook が3行フッターの後ろに独立行として書くため、FOOTER_PATTERN の末尾 `$`
// 固定判定が外れ、後段の APPROVAL-INLINE が未評価になる事故を防ぐ（2026-11-25 015CAFE）。

const JOURNAL_LINE = /^\s*prompt-journal-answered:\s*[a-f0-9-]{36}\s*$/i;

/**
 * 末尾から空行と prompt-journal-answered: <uuid> 行だけを取り除いたテキストを返す。
 * ジャーナル行が無い場合は末尾空白のみ trimEnd 相当（末尾の空行除去）になる。
 */
export function stripTrailingJournalAnswers(text) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line.trim() === '' || JOURNAL_LINE.test(line)) {
      end -= 1;
      continue;
    }
    break;
  }
  if (end === lines.length) return source;
  return lines.slice(0, end).join('\n');
}
