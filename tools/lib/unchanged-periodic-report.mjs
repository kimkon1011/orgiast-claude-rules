// Fail closed: short answers alone are not evidence of an unchanged periodic report.
// Only prompt headers identify the automatic turn; mentioning cron in prose does not.
export function isUnchangedPeriodicReport({ lastUserPrompt, assistantText } = {}) {
  if (typeof lastUserPrompt !== 'string' || typeof assistantText !== 'string') return false;
  const prompt = lastUserPrompt.trimStart();
  const periodic = /^(?:【定期の進捗確認|【定期確認|\[(?:cron|scheduled task)\](?:\s|$)|<(?:cron-trigger|scheduled-task)(?:\s[^>]*|)>)/i.test(prompt);
  const text = assistantText.trim();
  if (!periodic || !text || [...text].length > 300) return false;
  if (!/(?:(?:変化|変更|進展|更新)(?:は|が)?(?:なし|ありません)|変わり(?:は)?ありません|変わっていません|\bno (?:change|updates?))(?=[。.!！、,\s]|$)/i.test(text)) return false;
  // Include bare domains, Markdown links, commands, questions and implicit handoffs.
  if (/(?:[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}(?:[\/:?#]|\b)|\]\s*\(|`|~~~)/i.test(text)) return false;
  if (/次に\s*kim\s*がすること|[?？]|ください|下さい|お願い|依頼|もらえ|いただけ|頂け|ませんか|ましょう|してほしい|して欲しい|必要です|要確認|要対応|要承認|確認事項|手順|手渡し判定|確認用の全文|返信案|回答案|送信本文|(?:kim|user|ユーザー).{0,15}(?:操作|確認|承認|返信|送信|実行)|\b(?:please|could you|can you|need you|must|should)\b/i.test(text)) return false;
  if (/(?:して|んで|いて)(?:ね|下さい)?(?:[。!！\s]|$)|(?:確認|承認|返信|送信|操作|実行|ログイン)を(?:[。!！\s]|$)/.test(text)) return false;
  if (/(?:^|\n)\s*(?:[-*]\s|\d+[.)]\s|[①-⑳])|を(?:開く|押す|選ぶ|選択する|実行する|送信する|承認する)/.test(text)) return false;
  return true;
}
