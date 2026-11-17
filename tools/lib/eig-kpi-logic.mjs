export const DEADLINES = [
  ['2026-11-20', { positiveCompanies: 1 }],
  ['2026-11-21', { registrations: 5 }],
  ['2026-11-24', { positiveCompanies: 2, registrations: 10 }],
  ['2026-11-26', { confirmedCompanies: 3, cafe212: 1 }],
  ['2026-11-27', { registrations: 15 }],
  ['2026-12-01', { registrations: 20 }],
  ['2026-12-04', { registrations: 25, submissions: 5 }],
  ['2026-12-07', { registrations: 30, presenters: 10 }],
];
export const LABELS = { positiveCompanies: '企業の前向き返事', confirmedCompanies: '企業確定', cafe212: 'Cafe 212確定', registrations: '申込', submissions: '資料提出', presenters: '登壇申込' };
export const jstDay = (now = new Date()) => new Date(new Date(now).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
export function evaluateKpi(day, metrics, errors = []) {
  if (!/^2026-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid KPI date');
  const targets = {};
  for (const [due, goals] of DEADLINES) if (due <= day) for (const [key, target] of Object.entries(goals)) targets[key] = { target, due };
  const deficits = [], unknown = [];
  for (const [key, { target, due }] of Object.entries(targets)) {
    const actual = metrics[key];
    if (!Number.isSafeInteger(actual) || actual < 0) unknown.push(key);
    else if (actual < target) deficits.push({ key, due, target, actual, missing: target - actual });
  }
  return { status: deficits.length ? '遅れ' : unknown.length || errors.length ? '要確認' : Object.keys(targets).length ? '順調' : '期限前', targets, deficits, unknown,
    next: DEADLINES.find(([due]) => due > day) ?? null };
}
export function alertKey(day, kind = 'delay') { return `eig-kpi-watch:${day}:${kind}`; }
export const normalizeCompany = name => String(name).normalize('NFKC').toLowerCase().replace(/株式会社|有限会社|合同会社|[\s・（）()]/g, '');
export const emailAddress = text => String(text).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/)?.[0] || '';
export function isHumanExternal(message) {
  const from = emailAddress(message.from);
  return !!from && !/@(?:[\w-]+\.)?orgiast\.jp$/.test(from)
    && !/(?:no-?reply|mailer-daemon|postmaster|notifications?|comments-)/i.test(from)
    && !/@(?:.*\.)?(?:google\.com|peatix\.com)$/.test(from)
    && !/auto-replied|auto-generated/i.test(message.autoSubmitted || '')
    && !/bulk|list|junk/i.test(message.precedence || '')
    && !message.listUnsubscribe && !message.labels?.includes('SENT') && !message.labels?.includes('DRAFT');
}
const filled = value => value !== undefined && value !== null && !/^(?:\s*|false|未返信|返信なし|なし|未送信|未打診|—|-)$/i.test(String(value).trim());
export function masterRows(values, kind) {
  const header = values[0] || [];
  const required = ['送信日', '返信', '状態', kind === 'company' ? '会社名' : '団体名'];
  if (!required.every(h => header.includes(h))) throw new Error('Master headers changed');
  const get = (row, name) => row[header.indexOf(name)] ?? '';
  const rows = values.slice(1).filter(row => filled(get(row, required[3]))).map(row => ({
    name: String(get(row, required[3])), email: emailAddress(get(row, kind === 'company' ? 'メール' : '連絡先')),
    sent: filled(get(row, '送信日')), reply: String(get(row, '返信')), status: String(get(row, '状態')),
  }));
  const states = {};
  for (const row of rows) { const s = row.status.trim() || '未入力'; states[s] = (states[s] || 0) + 1; }
  return { rows, total: rows.length, sent: rows.filter(r => r.sent).length, replies: rows.filter(r => filled(r.reply)).length, states };
}
export function deterministicClass(text) {
  const value = String(text).trim();
  if (!filled(value) || /^(未打診|送信済み|返信待ち|未入力)$/.test(value)) return 'other';
  if (/^(確定|参加確定|課題提供確定|承諾済み)$/.test(value)) return 'confirmed';
  if (/^(前向き|前向き検討|前向き検討中|参加希望)$/.test(value)) return 'positive';
  if (/^(辞退|見送り|不参加|お断り)$/.test(value)) return 'declined';
  return null;
}
