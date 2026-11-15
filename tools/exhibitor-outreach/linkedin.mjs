const DAY_MS = 24 * 60 * 60 * 1000;

function parseUtcDay(value) {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const timestamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(timestamp);
    if (
      parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day
    ) return null;
    return timestamp;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }

  return null;
}

export function classifyFreshness(posts, referenceDate) {
  if (referenceDate === undefined) throw new TypeError('referenceDate is required');
  const referenceTimestamp = parseUtcDay(referenceDate);
  if (referenceTimestamp === null) throw new TypeError('referenceDate must be a valid Date or YYYY-MM-DD');

  const timestamps = (Array.isArray(posts) ? posts : [])
    .slice(0, 5)
    .map((post) => parseUtcDay(post?.date))
    .filter((timestamp) => timestamp !== null);

  if (timestamps.length === 0) return { eligible: false, daysSinceLatest: null };

  const latestTimestamp = Math.max(...timestamps);
  const daysSinceLatest = (referenceTimestamp - latestTimestamp) / DAY_MS;
  return { eligible: daysSinceLatest <= 60, daysSinceLatest };
}

export function selectFullProfileTargets(profiles, referenceDate) {
  return profiles
    .filter((profile) => classifyFreshness(profile?.posts, referenceDate).eligible)
    .map((profile) => profile.name);
}
