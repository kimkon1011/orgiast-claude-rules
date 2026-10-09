import { DAY, normalize } from './common.mjs';
export function normalizeAccount(value) {
  return normalize(String(value ?? '').normalize('NFKC').replace(/(?:\(?)(?:カ|ユ|ド|シャ|ザイ|トクヒ)(?:\)|\()/g, '').replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)));
}
export const corporateAccount = value => /(?:カ|ユ|ド|シャ|ザイ|トクヒ)[)(]|[(](?:カ|ユ|ド|シャ|ザイ|トクヒ)|株式会社|有限会社|合同会社/.test(String(value ?? '').normalize('NFKC'));
export function runPaymentRules(snapshot, footprint = {}, patterns) {
  const t = patterns.thresholds, end = snapshot.window.end, start = snapshot.window.start;
  const now = Date.parse(end), findings = [], unverified = [];
  const payments = (snapshot.payments || []).filter(p => p.date >= start && p.date <= end && Number.isFinite(p.amount) && p.amount > 0);
  const grouped = new Map();
  for (const p of payments) { if (!grouped.has(p.partner_id)) grouped.set(p.partner_id, []); grouped.get(p.partner_id).push(p); }
  const add = (rule, severity, p, detail) => findings.push({ rule, severity, partnerId: p?.id || '', subject: p?.name || '全体', detail });
  const unknown = (rule, p, detail) => unverified.push({ rule, partnerId: p?.id || '', subject: p?.name || '全体', detail });
  const allow = new Set((patterns.allowlist_partners || []).map(String));
  for (const p of snapshot.partners || []) {
    const rows = (grouped.get(String(p.id)) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) continue;
    const sum = rows.reduce((s, r) => s + r.amount, 0), bank = p.bank || {}, fp = footprint[String(p.id)] || {};
    const known = snapshot.baseline?.knownPartnerIds;
    const recentFirst = now - Date.parse(rows[0].date) <= t.new_partner_days * DAY;
    if (sum >= t.new_partner_amount && recentFirst) {
      if (known ? !known.includes(String(p.id)) : p.created_at && now - Date.parse(p.created_at) <= t.new_partner_days * DAY && Date.parse(p.created_at) <= now)
        add('R01', 'medium', p, `新規業者: 初回支払 ${rows[0].date}、期間合計 ${sum}円`);
      else if (!known && !p.created_at) unknown('R01', p, '初回実行: created_at がなく新規判定不能');
    }
    if (!allow.has(String(p.id))) {
      const sources = ['gmail', 'drive', 'discord'].map(k => fp[k]);
      if (!sources.some(s => s?.count > 0)) {
        if (sources.every(s => s?.status === 'ok' && s.controlVerified === true && s.count === 0)) add('R02', sum >= t.no_footprint_high ? 'high' : 'medium', p, `3ソースの形跡なし（検証済みの検索範囲内）: ${sum}円`);
        else unknown('R02', p, '形跡未照合: skip/失敗/対照未確認のソースあり');
      }
      if (sum >= t.name_mismatch_amount && bank.account_name) {
        const a = normalizeAccount(bank.account_name), b = normalizeAccount(p.name_kana || p.name);
        if (!p.name_kana && !/^[\p{Script=Katakana}a-z\sーｰ]+$/iu.test(normalize(p.name))) add('R07', 'info', p, '比較不能: 取引先名のカナ未登録（不一致とは判定しない）');
        else if (a && b && !a.includes(b) && !b.includes(a)) add('R07', 'medium', p, `名義不一致: ${bank.account_name} / ${bank.account_number || ''}`);
      }
      if (/株式会社|有限会社|合同会社/.test(p.name) && bank.account_name && !corporateAccount(bank.account_name)) add('R08', 'high', p, `法人取引先の口座名義に法人略号なし: ${bank.account_name} / ${bank.account_number || ''}`);
    }
    const round = rows.filter(r => r.amount >= t.round_min && r.amount % t.round_unit === 0);
    if (round.length) add('R03', 'info', p, `丸い金額: ${round.length}件`);
    const under = rows.filter(r => t.approval.some(a => r.amount >= a * t.approval_lower_ratio && r.amount < a));
    if (under.length) add('R04', under.length >= t.repeat_count ? 'medium' : 'info', p, `承認閾値直下: ${under.length}件`);
    let duplicate = false, split = false, left = 0, rollingSum = 0;
    const lastAmountDate = new Map();
    for (let i = 0; i < rows.length; i++) {
      const at = Date.parse(rows[i].date), last = lastAmountDate.get(rows[i].amount);
      if (last !== undefined && at - last <= t.duplicate_days * DAY) duplicate = true;
      lastAmountDate.set(rows[i].amount, at);
      rollingSum += rows[i].amount;
      while (at - Date.parse(rows[left].date) > t.split_days * DAY) rollingSum -= rows[left++].amount;
      if (i - left + 1 >= t.repeat_count && rollingSum >= t.approval[0]) split = true;
    }
    if (duplicate) add('R05', 'medium', p, `${t.duplicate_days}日以内の同額支払重複`);
    if (split) add('R09', 'medium', p, `${t.split_days}日以内に${t.repeat_count}件以上、合計${t.approval[0]}円以上`);
    const holiday = rows.filter(r => [0, 6].includes(new Date(`${r.date}T00:00:00Z`).getUTCDay()) || patterns.holidays_jp.includes(r.date));
    if (holiday.length) add('R11', 'info', p, `休日の支払: ${holiday.length}件（実行時刻は不明）`);
    const names = [normalize(p.name), normalizeAccount(p.name_kana), normalizeAccount(bank.account_name)].filter(Boolean);
    const staff = (snapshot.staff || []).find(m => (m.names || []).some(n => names.includes(normalizeAccount(n))) || p.email && (m.emails || []).some(e => e.toLowerCase() === p.email.toLowerCase()));
    if (staff) add('R13', 'high', p, '取引先名・名義・メールと Discord メンバー情報が一致（社員所属の確認が必要）');
    if (t.free_mail_domains.includes(String(p.email).split('@')[1]?.toLowerCase())) add('R14', 'info', p, 'フリーメールの取引先');
    const month = end.slice(0, 7), monthStart = Date.parse(`${month}-01`);
    const six = new Date(monthStart); six.setUTCMonth(six.getUTCMonth() - t.spike_months);
    const all = (snapshot.payments || []).filter(r => String(r.partner_id) === String(p.id) && r.date <= end);
    if (snapshot.coverage?.historyComplete && snapshot.coverage.historyStart <= six.toISOString().slice(0, 10)) {
      const current = all.filter(r => r.date.startsWith(month)).reduce((s, r) => s + r.amount, 0);
      const avg = all.filter(r => Date.parse(r.date) >= +six && Date.parse(r.date) < monthStart).reduce((s, r) => s + r.amount, 0) / t.spike_months;
      if (current >= t.spike_min && current > avg * t.spike_ratio) add('R15', 'medium', p, `当月 ${current}円 / 過去${t.spike_months}か月平均 ${Math.round(avg)}円（当月は途中）`);
    } else unknown('R15', p, '過去6か月の完全な比較期間を取得できていません');
  }
  const banks = new Map();
  for (const p of snapshot.partners || []) if (p.bank?.key) { if (!banks.has(p.bank.key)) banks.set(p.bank.key, []); banks.get(p.bank.key).push(p); }
  for (const ps of banks.values()) if (new Set(ps.map(p => p.id)).size > 1) add('R06', 'high', ps[0], `同一銀行・支店・口座: ${ps.map(p => p.name).join(' / ')} (${ps[0].bank.account_number})`);
  for (const w of snapshot.wallet_txns || []) if (w.entry_side === 'expense' && w.date >= start && w.date <= end) {
    const subject = { id: '', name: (snapshot.walletables || []).find(x => x.id === w.walletable_id && x.type === w.walletable_type)?.name || '口座明細' };
    if (w.status === 1 && now - Date.parse(w.date) >= t.unregistered_days * DAY && w.amount >= t.unregistered_min) add('R10', 'medium', subject, `長期未消込: ${w.date} ${w.amount}円`);
    if (w.status === 3 && w.amount >= t.ignored_min) add('R10', 'info', subject, `無視された出金: ${w.date} ${w.amount}円`);
  }
  if (payments.length >= t.benford_min_count) {
    const observed = Array(9).fill(0);
    for (const p of payments) observed[Number(String(p.amount).replace(/^0\./, '').replace(/^0+/, '')[0]) - 1]++;
    const chi = observed.reduce((s, count, i) => { const expected = payments.length * Math.log10(1 + 1 / (i + 1)); return s + (count - expected) ** 2 / expected; }, 0);
    if (chi > t.benford_chi_square) add('R12', 'info', null, `先頭桁分布 χ²=${chi.toFixed(2)}, n=${payments.length}（固定単価等で偏り得る）`);
  }
  const partnerIds = new Set((snapshot.partners || []).map(p => String(p.id)));
  for (const p of payments) if (!partnerIds.has(String(p.partner_id))) unknown('payments', null, `取引先未登録の支払 ${p.amount}円`);
  const holidayYears = new Set(patterns.holidays_jp.map(d => d.slice(0, 4)));
  if (payments.some(p => !holidayYears.has(p.date.slice(0, 4)))) unknown('R11', null, '対象支払年の祝日定義が未収録（土日のみ判定）');
  if (!snapshot.staffVerified) unknown('R13', null, 'メンバー名簿未取得または社員属性・メール未確認。Discord メンバー一致のみ判定可能');
  return { findings, unverified };
}
