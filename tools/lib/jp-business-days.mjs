// 日本の祝日・会社休業日と営業日の計算（無LLM・外部API不要）。
// schedule-autopilot が「連休の前は金曜の朝に前倒しで知らせる」判定に使う。
// 祝日法の規則（固定日・ハッピーマンデー・春分/秋分・振替休日・国民の休日）を計算で出す。
// 会社休業日（年末年始など）は closed で足す。日付はすべて JST の 'YYYY-MM-DD'。
const DAY = 86_400_000;
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const toUtc = date => Date.parse(`${date}T00:00:00Z`);
const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date, n) => fromUtc(toUtc(date) + n * DAY);
export const weekday = date => new Date(toUtc(date)).getUTCDay();
function nthMonday(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return iso(year, month, 1 + ((8 - first) % 7) + (n - 1) * 7);
}
export function equinoxDays(year) {
  const k = year - 1980, leap = Math.floor(k / 4);
  return { spring: Math.floor(20.8431 + 0.242194 * k - leap), autumn: Math.floor(23.2488 + 0.242194 * k - leap) };
}
const cache = new Map();
export function jpHolidays(year) {
  if (cache.has(year)) return cache.get(year);
  const names = new Map();
  const put = (date, name) => names.set(date, name);
  put(iso(year, 1, 1), '元日'); put(nthMonday(year, 1, 2), '成人の日');
  put(iso(year, 2, 11), '建国記念の日'); put(iso(year, 2, 23), '天皇誕生日');
  const { spring, autumn } = equinoxDays(year);
  put(iso(year, 3, spring), '春分の日'); put(iso(year, 4, 29), '昭和の日');
  put(iso(year, 5, 3), '憲法記念日'); put(iso(year, 5, 4), 'みどりの日'); put(iso(year, 5, 5), 'こどもの日');
  put(nthMonday(year, 7, 3), '海の日'); put(iso(year, 8, 11), '山の日');
  put(nthMonday(year, 9, 3), '敬老の日'); put(iso(year, 9, autumn), '秋分の日');
  put(nthMonday(year, 10, 2), 'スポーツの日'); put(iso(year, 11, 3), '文化の日'); put(iso(year, 11, 23), '勤労感謝の日');
  // 国民の休日: 前日と翌日が祝日の平日（日曜以外）。
  for (const date of [...names.keys()]) {
    const next = addDays(date, 2), middle = addDays(date, 1);
    if (names.has(next) && !names.has(middle) && weekday(middle) !== 0) put(middle, '国民の休日');
  }
  // 振替休日: 日曜の祝日の後の最初の祝日でない日。
  for (const date of [...names.keys()].sort()) {
    if (weekday(date) !== 0) continue;
    let day = addDays(date, 1);
    while (names.has(day)) day = addDays(day, 1);
    put(day, '振替休日');
  }
  cache.set(year, names);
  return names;
}
export const DEFAULT_CLOSED = ['12-29', '12-30', '12-31', '01-02', '01-03'];
export function holidayName(date, { closed = DEFAULT_CLOSED } = {}) {
  const name = jpHolidays(Number(date.slice(0, 4))).get(date);
  if (name) return name;
  return closed.includes(date.slice(5)) ? '会社休業日' : null;
}
export function isBusinessDay(date, options) {
  const w = weekday(date);
  return w !== 0 && w !== 6 && !holidayName(date, options);
}
export function lastBusinessDayOnOrBefore(date, options) {
  let day = date;
  while (!isBusinessDay(day, options)) day = addDays(day, -1);
  return day;
}
export function nextBusinessDay(date, options) {
  let day = addDays(date, 1);
  while (!isBusinessDay(day, options)) day = addDays(day, 1);
  return day;
}
export function prevBusinessDay(date, options) {
  return lastBusinessDayOnOrBefore(addDays(date, -1), options);
}
export function addBusinessDays(date, n, options) {
  let day = isBusinessDay(date, options) ? date : lastBusinessDayOnOrBefore(date, options);
  for (let i = 0; i < Math.abs(n); i++) day = n < 0 ? prevBusinessDay(day, options) : nextBusinessDay(day, options);
  return day;
}
// date の翌日から続く休み（土日祝・休業日）の日数。金曜→土日の2、11/20(金)→土日月祝の3。
export function closedStreakAfter(date, options) {
  let n = 0, day = addDays(date, 1);
  while (!isBusinessDay(day, options)) { n++; day = addDays(day, 1); }
  return n;
}
