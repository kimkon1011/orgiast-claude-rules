// 学会スマホ所在確認 の判定・整形ロジック（テスト可能な純関数）
// 本体 (gakkai-phone-digest.mjs) とテストから共有する

export const TARGET_PHONES = ['S002', 'S003', 'S004', 'S005', 'S006', 'S007', 'S008'];

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

// 端末状態:
//   operating           → 稼働中（最後の信号が24時間以内）
//   recent              → 24時間超〜2日未満（要確認にするには早い。警告なし・一覧に出すだけ）
//   needs-confirmation  → 要確認（2日以上〜14日以内）
//   gap14to30           → 14日超〜30日以内（警告なし・「最終信号から◯日」と一覧に出すだけ）
//   storage             → 保管中（30日超 または 一度も信号なし。警告にしない）
export function classifyPhone(now, signal) {
  if (!signal) return 'storage';
  const ageMs = now.getTime() - signal.timestamp.getTime();
  const d = Math.floor(ageMs / DAY_MS);
  if (ageMs <= 24 * HOUR_MS) return 'operating';
  if (d <= 1) return 'recent';
  if (d <= 14) return 'needs-confirmation';
  if (d <= 30) return 'gap14to30';
  return 'storage';
}

// 日本時間 (Asia/Tokyo) で「2026-11-07 09:07」形式
export function formatJST(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : ''; };
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

// JST で月曜日かどうか
export function isMondayJST(now) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'long' }).format(now) === 'Monday';
}

export function parsePhoneMessage(content) {
  // Format: PHONE S003 | 35.123456,135.123456 | 12m | 85% | 2026-11-07T10:00:00.000Z
  const m = content.match(/^PHONE\s+(S\d{3,4})\s*\|\s*([\d.]+),([\d.]+)\s*\|\s*([\d.]+)m?\s*\|\s*(\d+)%\s*\|\s*(.+)$/);
  if (!m) return null;
  return {
    phone: m[1],
    lat: parseFloat(m[2]),
    lng: parseFloat(m[3]),
    accuracy: parseInt(m[4], 10),
    battery: parseInt(m[5], 10),
    timestamp: new Date(m[6].trim()),
  };
}

function mapsLink(signal) {
  return `https://www.google.com/maps?q=${signal.lat},${signal.lng}`;
}

// 名前があるとき: 「S003（学A②）」、ないとき: 「S006 」（行の区切りスペースを兼ねる）
function idPart(pid, loc) {
  const name = loc && loc.location ? loc.location : '';
  return name ? `${pid}（${name}）` : `${pid} `;
}

// 一般行: ・S003（学A②）最終 2026-11-05 09:07／電池 85%／<地図リンク>
function normalLine(pid, loc, signal) {
  return `・${idPart(pid, loc)}最終 ${formatJST(signal.timestamp)}／電池 ${signal.battery}%／${mapsLink(signal)}`;
}

// 14日超〜30日以内の行: 最終信号から◯日
function gapLine(pid, loc, signal, now) {
  const d = Math.floor((now.getTime() - signal.timestamp.getTime()) / DAY_MS);
  return `・${idPart(pid, loc)}最終信号から${d}日／電池 ${signal.battery}%／${mapsLink(signal)}`;
}

// 本文を組み立て、投稿条件とその理由も返す
// signals: { phone -> parsePhoneMessage の結果 }
// locations: { phone -> { location } }
export function buildDigest({ now, signals, locations }) {
  // groups のキーは classifyPhone の戻り値（'needs-confirmation', 'gap14to30'）と一致させる
  const groups = { operating: [], recent: [], 'needs-confirmation': [], gap14to30: [], storage: [] };
  for (const pid of TARGET_PHONES) {
    const cat = classifyPhone(now, signals[pid]);
    groups[cat].push(pid);
  }

  const shouldPost = groups['needs-confirmation'].length > 0 || groups.operating.length > 0 || isMondayJST(now);

  const reasonParts = [];
  if (groups['needs-confirmation'].length) reasonParts.push(`要確認 ${groups['needs-confirmation'].length}台`);
  if (groups.operating.length) reasonParts.push(`稼働中 ${groups.operating.length}台`);
  if (isMondayJST(now)) reasonParts.push('月曜日');
  const reason = shouldPost
    ? `${reasonParts.join(' / ')} → 投稿する`
    : '要確認・稼働中なし／月曜以外 → 投稿しない';

  const parts = [`# 学会スマホ所在確認（${formatJST(now)}）`, ''];
  if (groups['needs-confirmation'].length) {
    parts.push('## 🔴 要確認');
    for (const pid of groups['needs-confirmation']) {
      const loc = locations[pid];
      parts.push(normalLine(pid, loc, signals[pid]));
      parts.push('→ 最後の場所に置き忘れていないか／倉庫の戻り報告にこの番号があるか確認');
    }
    parts.push('');
  }
  if (groups.operating.length) {
    parts.push('## 稼働中');
    for (const pid of groups.operating) parts.push(normalLine(pid, locations[pid], signals[pid]));
    parts.push('');
  }
  if (groups.recent.length || groups.gap14to30.length) {
    parts.push('## 一覧');
    for (const pid of groups.recent) parts.push(normalLine(pid, locations[pid], signals[pid]));
    for (const pid of groups.gap14to30) parts.push(gapLine(pid, locations[pid], signals[pid], now));
    parts.push('');
  }
  if (groups.storage.length) {
    parts.push(`保管中: ${groups.storage.join(' ')}`);
  }

  return {
    shouldPost,
    reason,
    text: parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(),
    categories: Object.fromEntries(TARGET_PHONES.map((pid) => [pid, classifyPhone(now, signals[pid])])),
  };
}