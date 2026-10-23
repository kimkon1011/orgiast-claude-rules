import { createHash } from 'node:crypto';
import { DAY, maskNumbers, auditError } from './common.mjs';
import { genericPartner, normalizeAccount, corporateAccount, corporatePartner } from './rules-payments.mjs';
import { sheetDate } from './sheets-source.mjs';
const sum = rows => rows.reduce((s, r) => s + r.amount, 0);
const text = v => maskNumbers(String(v ?? '').normalize('NFKC')).trim();
const identity = v => normalizeAccount(String(v ?? '').replace(/\s+([\u3099\u309a])/g, '$1').normalize('NFC')).replace(/[ァィゥェォャュョッヮ]/g, c => ({ァ:'ア',ィ:'イ',ゥ:'ウ',ェ:'エ',ォ:'オ',ャ:'ヤ',ュ:'ユ',ョ:'ヨ',ッ:'ツ',ヮ:'ワ'})[c]);
const corporateName = v => corporateAccount(String(v ?? '').normalize('NFKC').replace(/シヤ/g, 'シャ')) || corporatePartner(v);
export function extractPayee(description) {
  let s = String(description ?? '').normalize('NFKC').trim();
  if (/WEB\s*総振|総合振込|手数料|振込料金/i.test(s)) return '';
  s = s.replace(/^(?:振込|振り込み|振替|送金|振込出金)[\s:：-]*/u, '')
    .replace(/(?:\((?:カ|ユ|ド|シャ|シヤ|ザイ|トクヒ)\)?|(?:カ|ユ|ド|シャ|シヤ|ザイ|トクヒ)\))/g, '')
    .replace(/株式会社|有限会社|合同会社/g, '').trim();
  if (!s || /^(?:振込|振替|出金|入金|支払|WEB|総振|フリコミ|振込出金)$/i.test(s) || !/[\p{L}]/u.test(s)) return '';
  return text(s);
}
export async function collectPurchasing({ databaseUrl, query } = {}) {
  let sql;
  if (!query) {
    if (!databaseUrl) throw auditError('購買DB 接続設定なし');
    const { default: postgres } = await import('postgres');
    sql = postgres(databaseUrl, { max: 1, ssl: 'require', connect_timeout: 15, idle_timeout: 5,
      connection: { default_transaction_read_only: 'on', statement_timeout: 20000 }, onnotice: () => {} });
    query = statement => sql.unsafe(statement);
  }
  try {
    const result = {};
    for (const [table, columns] of Object.entries({
      cases: 'id, requester, item_summary, budget, assignee_user_id, status, self_purchase_approved_by, self_purchase_approved_at, purchase_date, complete_at, created_at',
      purchase_records: 'id, case_id, vendor_name, item_name, amount, created_by, created_at',
      approvals: 'case_id, status, decided_at', users: 'id, email, name, app_role',
    })) {
      const rows = await query(`SELECT ${columns} FROM ${table}`);
      if (!Array.isArray(rows)) throw auditError(`購買DB ${table}: 応答不正`);
      result[table] = rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
        ['amount', 'budget'].includes(k) ? Number(v) : v instanceof Date ? v.toISOString() : typeof v === 'string' && !['id','case_id','created_by','assignee_user_id'].includes(k) ? text(v) : v])));
    }
    return result;
  } finally { if (sql) await sql.end({ timeout: 5 }); }
}
export function closest(rows, payment, days) {
  const candidates = rows.map((r, index) => ({ ...r, distance: Math.abs(Date.parse(r.date) - Date.parse(payment.date)), index }))
    .filter(r => r.name && r.amount === payment.amount && r.distance <= days * DAY)
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
  if (!candidates.length) return null;
  const { distance, index, ...first } = candidates[0];
  return { ...first, ambiguous: candidates.length > 1, candidateCount: candidates.length, distanceDays: distance / DAY };
}
export function resolvePayees(snapshot, { patterns, sheetRows = [], purchasing = {}, staff = snapshot.staff || [], sources = {} } = {}) {
  const users = purchasing.users || [], byId = new Map(users.map(u => [String(u.id), u]));
  const members = new Set([...staff.flatMap(m => [...m.names || [], ...m.emails || []]), ...users.flatMap(u => [u.name, u.email])].map(identity).filter(Boolean));
  const aliases = new Map();
  for (const r of sheetRows) if (r.source === 'old' && r.bankName && r.name) {
    const key = identity(r.bankName), names = aliases.get(key) || new Map();
    names.set(identity(r.name), { name: r.name, source: r.source, tab: r.tab, row: r.row }); aliases.set(key, names);
  }
  const transfers = sheetRows.filter(r => r.source !== 'form').map(r => ({ ...r, corporate: corporateName(r.name), resolved_by: 'a' }));
  const wallets = (snapshot.wallet_txns || []).map(w => ({ date: w.date, amount: w.amount, name: extractPayee(w.description), corporate: corporateName(w.description), resolved_by: 'b', source: 'wallet_txns', row: w.id }));
  const dbRows = [
    ...(purchasing.purchase_records || []).map(r => ({ date: sheetDate(r.created_at), amount: r.amount, name: text(r.vendor_name || r.item_name), handler: byId.get(String(r.created_by))?.name || '', category: r.vendor_name ? '支払請求書' : '品名のみ・支払先要確認', corporate: corporatePartner(r.vendor_name), source: 'purchase_records', row: r.id, resolved_by: 'c' })),
    ...(purchasing.cases || []).filter(c => c.status !== 'cancelled').map(c => ({ date: sheetDate(c.purchase_date || c.complete_at), alternateDate: sheetDate(c.complete_at), amount: c.budget, name: text(c.requester || c.item_summary), category: '購買申請・支払先要確認', source: 'cases', row: c.id, resolved_by: 'c' })),
  ];
  const forms = sheetRows.filter(r => r.source === 'form').map(r => ({ ...r, category: '購買依頼・依頼者/対応者', resolved_by: 'd' }));
  const generic = new Map(snapshot.partners.filter(p => genericPartner(p.name, patterns)).map(p => [String(p.id), p]));
  const payments = snapshot.payments.filter(p => generic.has(String(p.partner_id)) && p.date >= snapshot.window.start && p.date <= snapshot.window.end && p.amount > 0);
  const resolved = payments.map(p => {
    const c = closest(transfers, p, 7) || closest(wallets, p, 5) || closest(dbRows.map(r => r.alternateDate && Math.abs(Date.parse(r.alternateDate)-Date.parse(p.date)) < Math.abs(Date.parse(r.date)-Date.parse(p.date)) ? { ...r, date: r.alternateDate } : r), p, 14) || closest(forms, p, 14);
    if (!c) return { ...p, genericName: generic.get(String(p.partner_id)).name, status: 'unresolved', resolved_by: 'unresolved' };
    const named = aliases.get(identity(c.name));
    const alias = named?.size === 1 ? [...named.values()][0] : null;
    if (alias) { c.originalName = c.name; c.name = alias.name; }
    const internal = /当月払い|立替経費|給与|社員|アシスタント/.test(c.category || '') || !c.corporate && members.has(identity(c.name));
    const classification = internal ? '社内の人への支払い' : c.corporate || /支払請求書/.test(c.category || '') ? '業者' : '区分未確認';
    const name = text(c.name), payeeId = `payee:${createHash('sha256').update(`${c.corporate ? 'corporate:' : ''}${identity(name)}`).digest('hex').slice(0, 24)}`;
    return { ...p, genericName: generic.get(String(p.partner_id)).name, name, payeeId, status: 'resolved', resolved_by: c.resolved_by,
      category: c.category || classification, classification, classificationReason: internal ? (members.has(identity(c.name)) ? '購買DB users / Discord 名簿の名前・メール一致' : '業務内容の区分') : c.corporate ? '法人名・法人略号' : c.category || '所属・区分を確認できない',
      ambiguous: c.ambiguous, candidateCount: c.candidateCount, distanceDays: c.distanceDays,
      evidence: { source: c.source, tab: c.tab, row: c.row, date: c.date, handler: c.handler || '', ...(alias ? { bankName: c.originalName, nameReference: alias } : {}) } };
  });
  const groups = new Map();
  for (const r of resolved.filter(r => r.status === 'resolved')) {
    const g = groups.get(r.payeeId) || { id: r.payeeId, name: r.name, count: 0, amount: 0, categories: [], classifications: [], resolved_by: [], ambiguous: false };
    g.count++; g.amount += r.amount; g.ambiguous ||= r.ambiguous;
    for (const [k, v] of [['categories', r.category], ['classifications', r.classification], ['resolved_by', r.resolved_by]]) if (!g[k].includes(v)) g[k].push(v);
    groups.set(r.payeeId, g);
  }
  const payees = [...groups.values()].map(g => ({ ...g, internal: g.classifications.every(c => c === '社内の人への支払い') })).sort((a, b) => b.amount - a.amount);
  const summary = [...generic.values()].map(p => {
    const rows = resolved.filter(r => String(r.partner_id) === String(p.id)), missing = rows.filter(r => r.status === 'unresolved');
    return { name: p.name, count: rows.length, amount: sum(rows), resolvedCount: rows.length - missing.length, unresolvedCount: missing.length, unresolvedAmount: sum(missing),
      methods: Object.fromEntries(['a','b','c','d'].map(k => [k, rows.filter(r => r.resolved_by === k).length])) };
  }).filter(r => r.count);
  return { payments: resolved, payees, summary, sources };
}
export function runPayeeRules(snapshot, patterns) {
  const resolution = snapshot.payeeResolution, findings = [], unverified = [];
  if (!resolution) return { findings, unverified };
  const add = (rule, severity, subject, detail, extra = {}) => findings.push({ rule, severity, subject, detail, ...extra });
  const missing = resolution.payments.filter(p => p.status === 'unresolved');
  const sources = resolution.sources || {}, failed = Object.entries(sources).filter(([, s]) => s.status === 'failed');
  const complete = ['payee-sheet:old','payee-sheet:paypay','payee-sheet:form','purchasing'].every(k => ['ok','partial'].includes(sources[k]?.status));
  const positive = resolution.payments.some(p => p.status === 'resolved');
  if (!complete || !positive) unverified.push({ rule: 'R16', subject: '汎用取引先', detail: `未解決${missing.length}件。取得失敗/対照不足のため「該当なし」を確定しない。${failed.map(([k]) => k).join(', ')}` });
  else {
    for (const p of missing.filter(p => p.amount >= patterns.thresholds.unregistered_min)) add('R16', 'medium', p.genericName,
      `汎用取引先の支払いに振込一覧・申請記録・口座明細のいずれにも該当なし: ${p.date} ${p.amount}円（取得・照合範囲内）`, { kind: 'generic-unresolved', amount: p.amount, paymentId: p.id });
    const small = missing.filter(p => p.amount < patterns.thresholds.unregistered_min);
    if (small.length) add('R16', 'info', '汎用取引先・少額未解決', `${small.length}件 / 合計 ${sum(small)}円`, { kind: 'generic-unresolved' });
  }
  for (const p of resolution.payees.filter(p => !p.internal)) {
    const fp = ['gmail','drive','discord'].map(k => snapshot.footprint?.[p.id]?.[k]);
    if (fp.some(r => r?.count > 0)) continue;
    if (!p.ambiguous && fp.every(r => r?.status === 'ok' && r.controlVerified && r.count === 0)) add('R02', p.amount >= patterns.thresholds.no_footprint_high ? 'high' : 'medium', p.name, `解決済み業者: 3ソースの形跡なし（検証済みの検索範囲内）: ${p.amount}円`, { partnerId: p.id });
    else unverified.push({ rule: 'R02', subject: p.name, detail: p.ambiguous ? '同額候補が複数あり実名の確定前。形跡なしを確定しない' : '解決済み支払先の形跡未照合: skip/失敗/対照未確認' });
  }
  const db = snapshot.purchasing || {}, users = db.users || [];
  const canonical = value => {
    const v = identity(value); if (!v) return '';
    const u = users.find(u => [u.id,u.name,u.email].some(n => identity(n) === v));
    return u ? String(u.id) : v;
  };
  const inWindow = value => { const d = sheetDate(value); return d && d >= snapshot.window.start && d <= snapshot.window.end; };
  for (const c of db.cases || []) if (c.self_purchase_approved_by && canonical(c.self_purchase_approved_by) === canonical(c.requester) && inWindow(c.self_purchase_approved_at || c.purchase_date || c.complete_at || c.created_at))
    add('R17', 'medium', text(c.requester), `購買申請の依頼者と自己購入承認者が同一: ${text(c.item_summary)}`, { kind: 'self-approval', caseId: c.id });
  const approvals = new Set((db.approvals || []).map(a => String(a.case_id)));
  for (const r of db.purchase_records || []) if (!approvals.has(String(r.case_id)) && r.amount >= 100000 && inWindow(r.created_at))
    add('R17', 'info', text(r.vendor_name || r.item_name), `承認記録のない購買実績: ${r.amount}円`, { kind: 'approval-missing', caseId: r.case_id });
  const months = new Map();
  for (const r of snapshot.payeeSheetRows || []) if (r.doubleCheck === '' && r.amount >= 100000 && inWindow(r.date)) {
    const m = r.date.slice(0, 7), rows = months.get(m) || []; rows.push(r); months.set(m, rows);
  }
  if (!(snapshot.payeeSheetRows || []).some(r => r.doubleCheck !== null && r.doubleCheck !== undefined && inWindow(r.date)))
    unverified.push({ rule: 'R18', subject: '二重チェック', detail: '対象期間に二重チェック列を持つ振込明細を取得できていません。0件はチェック漏れなしを意味しません' });
  for (const [month, rows] of months) add('R18', 'info', month, `振込予定一覧の二重チェック未入力: ${rows.length}件 / 合計 ${sum(rows)}円`, { kind: 'double-check-missing' });
  return { findings, unverified };
}
