// 選択肢を出す前の期限ゲート（kim 2026-11-27「間に合わないならなぜ案内したの？」の再発防止）。
// 期限（必着日）と根拠が無い案件では選択肢を出させない。各選択肢の所要日数を営業日で積み上げて到着日を出し、
// 20%以上（最低1営業日）の余裕を残して期限に届くものだけを「出してよい」に入れる。
// 所要日数に根拠（source）が無い手順を含む選択肢は「未確認」として出さない（言い切り防止）。
// 訪問（人が窓口・現地へ行く）を含む選択肢は、訪問なしで間に合う選択肢がある限り後ろに回し、推奨にしない。
import { addDays, addBusinessDays, isBusinessDay, nextBusinessDay } from './jp-business-days.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function businessDaysBetween(from, to, options) {
  // from の翌営業日から to までの営業日数（to が from 以前なら負または0）。
  if (to <= from) {
    let n = 0, d = from;
    while (d > to) { d = addDays(d, -1); if (isBusinessDay(d, options)) n--; }
    return n;
  }
  let n = 0, d = from;
  while (d < to) { d = addDays(d, 1); if (isBusinessDay(d, options)) n++; }
  return n;
}

export function arrivalOf(start, steps = [], options) {
  // 各手順: { label, days, unit: 'business' | 'calendar', source }
  // start は着手日。営業日の手順は「着手日を含めず数えてn営業日後」。
  let day = start;
  for (const s of steps) {
    const days = Number(s.days) || 0;
    if (s.unit === 'calendar') day = addDays(day, days);
    else day = days === 0 ? (isBusinessDay(day, options) ? day : nextBusinessDay(day, options)) : addBusinessDays(day, days, options);
  }
  return day;
}

export function gateOptions({ deadline, deadlineSource, today, options = [], bufferRatio = 0.2, holidayOptions } = {}) {
  if (!deadline || !ISO.test(deadline) || !deadlineSource) {
    return { ok: false, reason: '期限未確認：期限日（必着か消印有効か）と根拠の出典を確かめるまで、選択肢を出さない', allowed: [], rejected: options.map(o => ({ ...o, verdict: '保留', why: '期限未確認' })) };
  }
  const judged = options.map(o => {
    const steps = o.steps || [];
    const totalBiz = steps.reduce((a, s) => a + (Number(s.days) || 0), 0);
    const need = Math.max(1, Math.ceil(totalBiz * bufferRatio));
    const start = o.start || today;
    const arrival = arrivalOf(start, steps, holidayOptions);
    const slack = businessDaysBetween(arrival, deadline, holidayOptions);
    const unverified = steps.filter(s => !s.source).map(s => s.label);
    let verdict = '出してよい', why = `到着見込み ${arrival}（期限 ${deadline} まで余裕 ${slack} 営業日・必要 ${need}）`;
    if (arrival > deadline) { verdict = '出さない'; why = `間に合わない：到着見込み ${arrival} が期限 ${deadline} を過ぎる`; }
    else if (slack < need) { verdict = '出さない'; why = `余裕不足：到着見込み ${arrival}、期限まで ${slack} 営業日（20%バッファ ${need} 営業日に届かない）`; }
    else if (unverified.length) { verdict = '出さない'; why = `所要日数が未確認：${unverified.join('・')}。根拠を確かめてから出す`; }
    return { ...o, arrival, slack, need, verdict, why };
  });
  const allowed = judged.filter(o => o.verdict === '出してよい');
  const noVisit = allowed.filter(o => !o.visit);
  allowed.sort((a, b) => (a.visit === b.visit ? (a.cost ?? 0) - (b.cost ?? 0) : a.visit ? 1 : -1));
  return {
    ok: true, deadline, deadlineSource, allowed, rejected: judged.filter(o => o.verdict !== '出してよい'),
    recommend: (noVisit[0] || allowed[0] || null)?.name || null,
    note: allowed.length && !noVisit.length ? '訪問なしで間に合う道が無い。訪問は全案件の同じ窓口の用事とまとめる（visit-consolidate）' : '',
  };
}
