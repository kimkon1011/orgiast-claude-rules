/** Calendar の書き込みと通知先には社内ドメインだけを使う。 */
export function isInternalEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@orgiast\.jp$/i.test(email.trim());
}

export function sanitizeAttendees(attendees, { log = console.warn } = {}) {
  if (!Array.isArray(attendees)) return [];
  const dropped = [];
  const kept = attendees.filter(attendee => {
    if (isInternalEmail(attendee?.email)) return true;
    if (attendee?.email) dropped.push(attendee.email);
    return false;
  });
  if (dropped.length) log(`[calendar] 社外アドレスを attendees から除外: ${dropped.join(', ')}`);
  return kept.map(attendee => ({ ...attendee, email: attendee.email.trim().toLowerCase() }));
}

export function isAcademicGroup(group) {
  return typeof group === 'string' && /nxa|学会/iu.test(group);
}

export const GAKKAI_CALENDAR = 'seisaku-team@orgiast.jp';
export const PREPARATION_PREFIX = '📋 準備: ';

export function isAcademicEvent(summary) {
  const title = summary?.startsWith(PREPARATION_PREFIX) ? summary.slice(PREPARATION_PREFIX.length) : summary;
  return isAcademicGroup(title?.match(/^【自動】【([^】]+)】/)?.[1]);
}

function calendarTimeMs(time) {
  return Date.parse(time?.dateTime || (time?.date ? `${time.date}T00:00:00+09:00` : ''));
}

export function calendarStartMs(event) {
  return calendarTimeMs(event.start);
}

export function calendarEndMs(event) {
  return calendarTimeMs(event.end);
}
