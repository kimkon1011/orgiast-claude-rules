export const COLLECTIONS = Object.freeze(['goals', 'tasks', 'leaves', 'expenses', 'oneOnOnes']);
const profileKeys = ['employeeId', 'name', 'kana', 'department', 'role', 'joinedAt', 'email', 'phone', 'location'];
const fields = {
  goals: ['period', 'title', 'dueDate', 'note'], tasks: ['title', 'dueDate', 'source'],
  leaves: ['date', 'note'], expenses: ['date', 'item', 'note'],
  oneOnOnes: ['date', 'partner', 'topic', 'decision', 'nextAction'],
};
const enums = {
  goals: { status: ['planned', 'active', 'achieved', 'dropped'] },
  tasks: { priority: ['high', 'middle', 'low'], status: ['todo', 'doing', 'done'] },
  leaves: { type: ['paid', 'substitute', 'special', 'other'] },
  expenses: { status: ['draft', 'submitted', 'approved', 'rejected'] }, oneOnOnes: {},
};
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = v => typeof v === 'string' ? v : '';
const integer = (v, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0;
function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function checkCollection(c) { if (!COLLECTIONS.includes(c)) throw new RangeError('不明なコレクションです。'); }
function normalizeItem(c, raw, id) {
  const item = { id };
  for (const key of fields[c]) item[key] = key === 'date' || key === 'dueDate' ? (validDate(raw[key]) ? raw[key] : '') : string(raw[key]);
  for (const [key, choices] of Object.entries(enums[c])) item[key] = choices.includes(raw[key]) ? raw[key] : (key === 'priority' ? 'middle' : choices[0]);
  if (c === 'goals') item.progress = integer(raw.progress, 100);
  if (c === 'expenses') item.amount = integer(raw.amount);
  return item;
}
export function createEmptyData() {
  return { version: 1, profile: { ...Object.fromEntries(profileKeys.map(k => [k, ''])), skills: [], qualifications: [] },
    ...Object.fromEntries(COLLECTIONS.map(c => [c, []])), updatedAt: '' };
}
export function normalizeData(raw) {
  const data = createEmptyData();
  if (!record(raw)) return data;
  const p = record(raw.profile) ? raw.profile : {};
  for (const key of profileKeys) data.profile[key] = string(p[key]);
  if (!validDate(data.profile.joinedAt)) data.profile.joinedAt = '';
  for (const key of ['skills', 'qualifications']) data.profile[key] = Array.isArray(p[key]) ? p[key].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : [];
  data.updatedAt = string(raw.updatedAt);
  for (const c of COLLECTIONS) {
    const rows = Array.isArray(raw[c]) ? raw[c].filter(record) : [];
    const reserved = new Set(rows.map(v => string(v.id)).filter(v => v.trim()));
    const seen = new Set();
    for (const row of rows) {
      let id = string(row.id);
      if (!id.trim() || seen.has(id)) {
        let n = 1;
        while (reserved.has(`${c}-${n}`) || seen.has(`${c}-${n}`)) n++;
        id = `${c}-${n}`;
      }
      seen.add(id);
      data[c].push(normalizeItem(c, row, id));
    }
  }
  return data;
}
export function parseData(jsonText) {
  try {
    if (typeof jsonText !== 'string') throw new TypeError();
    const raw = JSON.parse(jsonText);
    if (!record(raw) || (raw.version !== undefined && raw.version !== 1) ||
      COLLECTIONS.some(c => raw[c] !== undefined && !Array.isArray(raw[c])) ||
      (raw.profile !== undefined && !record(raw.profile))) throw new TypeError();
    return { data: normalizeData(raw), recovered: false };
  } catch { return { data: createEmptyData(), recovered: true }; }
}
export function serializeData(data) { return JSON.stringify(normalizeData(data)); }
// UUID生成のみ非決定的。nowは呼び出し側が渡し、入力は変更しない。
export function upsertItem(data, collection, item, now) {
  checkCollection(collection);
  const next = normalizeData(data);
  const raw = record(item) ? item : {};
  let id = string(raw.id);
  if (!id.trim()) {
    if (!globalThis.crypto?.randomUUID) throw new Error('この環境ではIDを生成できません。localhostまたはHTTPSで開いてください。');
    do { id = globalThis.crypto.randomUUID(); } while (next[collection].some(v => v.id === id));
  }
  const value = normalizeItem(collection, raw, id);
  const index = next[collection].findIndex(v => v.id === id);
  if (index === -1) next[collection].push(value); else next[collection][index] = value;
  next.updatedAt = typeof now === 'string' ? now : next.updatedAt;
  return next;
}
export function removeItem(data, collection, id) {
  checkCollection(collection);
  const next = normalizeData(data);
  next[collection] = next[collection].filter(v => v.id !== id);
  return next;
}
export function validateItem(collection, item) {
  const errors = [];
  if (!COLLECTIONS.includes(collection)) return { ok: false, errors: ['不明なコレクションです。'] };
  const v = record(item) ? item : {};
  const required = { goals: 'title', tasks: 'title', leaves: 'date', expenses: 'item', oneOnOnes: 'partner' }[collection];
  if (!string(v[required]).trim()) errors.push('必須項目を入力してください。');
  for (const key of fields[collection].filter(k => k === 'date' || k === 'dueDate')) {
    if (v[key] !== undefined && v[key] !== '' && !validDate(v[key])) errors.push('日付は実在する日付をYYYY-MM-DD形式で入力してください。');
  }
  for (const [key, choices] of Object.entries(enums[collection])) if (v[key] !== undefined && !choices.includes(v[key])) errors.push('選択項目の値が不正です。');
  if (collection === 'expenses' && (!Number.isSafeInteger(v.amount) || v.amount < 0)) errors.push('金額は0以上の整数で入力してください。');
  if (collection === 'goals' && v.progress !== undefined && (!Number.isInteger(v.progress) || v.progress < 0 || v.progress > 100)) errors.push('進捗は0〜100の整数で入力してください。');
  return { ok: errors.length === 0, errors };
}
export function dueLabel(dueDate, today) {
  if (!validDate(dueDate) || !validDate(today)) return 'none';
  const days = (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
  return days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 7 ? 'soon' : 'later';
}
export function taskStats(tasks, today) {
  const result = { total: tasks.length, todo: 0, doing: 0, done: 0, overdue: 0, dueSoon: 0 };
  for (const t of tasks) {
    if (['todo', 'doing', 'done'].includes(t.status)) result[t.status]++;
    if (t.status === 'done') continue;
    const label = dueLabel(t.dueDate, today);
    if (label === 'overdue') result.overdue++;
    if (label === 'today' || label === 'soon') result.dueSoon++;
  }
  return result;
}
export function goalStats(goals) {
  const r = { total: goals.length, planned: 0, active: 0, achieved: 0, dropped: 0, averageProgress: 0 };
  for (const g of goals) if (enums.goals.status.includes(g.status)) r[g.status]++;
  r.averageProgress = goals.length ? Math.round(goals.reduce((sum, g) => sum + integer(g.progress, 100), 0) / goals.length * 10) / 10 : 0;
  return r;
}
export function expenseStats(expenses) {
  const r = { count: expenses.length, totalAmount: 0, pendingCount: 0, pendingAmount: 0, approvedAmount: 0, rejectedCount: 0 };
  for (const e of expenses) {
    const amount = integer(e.amount); r.totalAmount += amount;
    if (['draft', 'submitted'].includes(e.status)) { r.pendingCount++; r.pendingAmount += amount; }
    if (e.status === 'approved') r.approvedAmount += amount;
    if (e.status === 'rejected') r.rejectedCount++;
  }
  return r;
}
// 今日の既定値のみ端末時計を使用。第4引数で基準日を固定できる。
export function leaveStats(leaves, year, allowance, today = localToday()) {
  const r = { usedDays: 0, plannedDays: 0, remainingDays: 0, byType: { paid: 0, substitute: 0, special: 0, other: 0 } };
  for (const l of leaves) {
    if (!validDate(l.date) || l.date.slice(0, 4) !== String(year)) continue;
    const type = enums.leaves.type.includes(l.type) ? l.type : 'other';
    r.byType[type]++;
    if (type !== 'other') r.usedDays++;
    if (validDate(today) && l.date >= today) r.plannedDays++;
  }
  r.remainingDays = (typeof allowance === 'number' && Number.isFinite(allowance) ? allowance : 0) - r.usedDays;
  return r;
}
export function profileCompleteness(profile) {
  const p = record(profile) ? profile : {};
  const keys = ['name', 'kana', 'department', 'role', 'joinedAt', 'email', 'phone', 'location', 'employeeId', 'skills', 'qualifications'];
  const missing = keys.filter(k => ['skills', 'qualifications'].includes(k) ? !Array.isArray(p[k]) || p[k].length === 0 : !string(p[k]).trim());
  const filled = keys.length - missing.length;
  return { filled, total: keys.length, percent: Math.round(filled / keys.length * 100), missing };
}
const labels = { employeeId: '社員番号', name: '氏名', kana: 'ふりがな', department: '部署', role: '役職', joinedAt: '入社日', email: 'メール', phone: '電話', location: '勤務地', skills: 'スキル', qualifications: '資格', period: '期間', title: 'タイトル', dueDate: '期限', progress: '進捗（%）', status: '状態', note: 'メモ', priority: '優先度', source: '出所', date: '日付', type: '種類', item: '費目', amount: '金額（円）', partner: '相手', topic: '話題', decision: '決定事項', nextAction: '次の行動' };
const values = { planned: '予定', active: '進行中', achieved: '達成', dropped: '中止', high: '高', middle: '中', low: '低', todo: '未着手', doing: '進行中', done: '完了', paid: '有給', substitute: '代休', special: '特別休暇', other: 'その他', draft: '下書き', submitted: '申請済み', approved: '承認', rejected: '却下' };
function md(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>'); }
export function toMarkdown(data, today) {
  const d = normalizeData(data);
  const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n');
  const output = [`# 社員マイページ: ${md(d.profile.name)}`, '## プロフィール', table(['項目', '内容'], Object.entries(d.profile).map(([k, v]) => [labels[k], md(Array.isArray(v) ? v.join('、') : v)]))];
  const titles = ['目標', 'タスク', '休暇', '経費', '1on1'];
  const columns = { goals: ['period', 'title', 'dueDate', 'progress', 'status', 'note'], tasks: ['title', 'priority', 'dueDate', 'status', 'source'], leaves: ['date', 'type', 'note'], expenses: ['date', 'item', 'amount', 'status', 'note'], oneOnOnes: fields.oneOnOnes };
  COLLECTIONS.forEach((c, i) => {
    output.push(`## ${titles[i]}`);
    output.push(d[c].length ? table(columns[c].map(k => labels[k]), d[c].map(row => columns[c].map(k => {
      let value = row[k];
      if (['status', 'priority', 'type'].includes(k)) value = values[value];
      if (k === 'amount') value = value.toLocaleString('ja-JP');
      if (c === 'tasks' && k === 'dueDate') value = `${({ overdue: '⚠', today: '●', soon: '・' })[dueLabel(value, today)] || ''}${value}`;
      return md(value);
    }))) : '（登録なし）');
  });
  return output.join('\n\n') + '\n';
}
