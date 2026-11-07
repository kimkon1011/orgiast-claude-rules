// Keep in sync with claude-mobile/lib/schedule-candidate.mjs (same test vectors).
export function isScheduleCandidate(value) {
  const text = String(value ?? '').normalize('NFKC');
  if (/(\[notification|\{notification|\[not_|\{not_)/iu.test(text)) return false;
  return /\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}時|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|明日|明後日|あさって|(?:再来週|来週|今週)|[月火水木金土日]曜/u.test(text);
}
