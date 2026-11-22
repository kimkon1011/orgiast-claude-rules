// フッターとタイトルは PC のローカル時刻を使う。日付だけの納期は当日 23:59。
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const TIME = '\\d{2}:\\d{2}';
const WAIT = new RegExp(`^(?:まだ閉じない（[^・\\r\\n]*|/session-close をして（まだ閉じない)・(${DATE} ${TIME}) まで待つ(?:／([^\\r\\n]+))?）$`);
const DUE = new RegExp(`^納期 (${DATE}(?: ${TIME})?)・残り作業 (\\d+(?:\\.\\d+)?)(分|時間|日)$`);
const UNIT_MS = { 分: 60_000, 時間: 3_600_000, 日: 86_400_000 };

function localDateTime(value) {
  const [year, month, day, hour = 23, minute = 59] = value.split(/[- :]/).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day &&
    date.getHours() === hour && date.getMinutes() === minute ? date : null;
}

export function parseWaitFooter(text) {
  const result = { waitUntil: null, due: null, remainingMs: null, noDueReason: null };
  const source = String(text ?? '').trim();
  const sessionLines = [...source.matchAll(/^(?:\*\*)?このセッション[:：](?:\*\*)?[ \t]*([^\r\n]+)$/gm)];
  const match = WAIT.exec(sessionLines.at(-1)?.[1].trim() ?? source);
  if (!match) return result;
  result.waitUntil = localDateTime(match[1]);
  if (!result.waitUntil) return result;
  const suffix = match[2] ?? '';
  const due = DUE.exec(suffix);
  if (due) {
    const remainingMs = Number(due[2]) * UNIT_MS[due[3]];
    const date = localDateTime(due[1]);
    if (date && Number.isFinite(remainingMs)) {
      result.due = date;
      result.remainingMs = remainingMs;
    }
  } else {
    const reason = /^納期なし[:：][ \t]*(.+)$/.exec(suffix)?.[1].trim();
    if (reason && [...reason].length >= 5) result.noDueReason = reason;
  }
  return result;
}

export function latestSafeStart(due, remainingMs, bufferRatio = 0.2) {
  if (!(due instanceof Date) || !Number.isFinite(remainingMs) || remainingMs < 0) return null;
  const date = new Date(due.getTime() - remainingMs - Math.max(3_600_000, remainingMs * bufferRatio));
  return Number.isFinite(date.getTime()) ? date : null;
}
