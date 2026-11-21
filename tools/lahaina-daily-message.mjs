export function tokyoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function weekdayJa(date) {
  const index = new Date(`${date}T00:00:00Z`).getUTCDay();
  return '日月火水木金土'[index];
}

export function findEntry(calendar, date) {
  return calendar.find((entry) => entry.date === date);
}

export function formatMessage(entry) {
  const [, month, day] = entry.date.split('-').map(Number);
  return `【今日のインスタ用 写真のお願い】${month}/${day}（${weekdayJa(entry.date)}）\n` +
    `テーマ：${entry.theme}\n` +
    `お願い：${entry.ask}\n\n` +
    'このグループに、写真1〜3枚と一言コメント（20字くらい）をお昼12時までに送ってください。\n' +
    '写真の明るさ調整と投稿文はこちらで作ります。お客様のお顔・車のナンバーは写さないでください。';
}

export function wasSent(sentText, date) {
  return sentText.split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const record = JSON.parse(line);
      return record.date === date && record.failed !== true;
    } catch { return false; }
  });
}

