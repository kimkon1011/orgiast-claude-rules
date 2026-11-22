import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CYCLE_START = '2026-11-18T00:00:00+09:00';
export const DEFAULT_CYCLE_END = '2026-12-18T00:00:00+09:00';
export const TARGET_END_LOW = 90;
export const TARGET_END_HIGH = 95;
export const ON_DEMAND_HALT_PCT = 97;

export function cursorUsagePaceTxtPath(home) {
  return path.join(home, '.claude', 'reports', 'cursor-usage-pace.txt');
}
export function cursorUsagePaceJsonlPath(home) {
  return path.join(home, '.claude', 'reports', 'cursor-usage-pace.jsonl');
}
export function cursorUsagePaceStatePath(home) {
  return path.join(home, '.claude', 'cursor-usage-pace-state.json');
}
export function cursorUsagePaceAlertPath(home) {
  return path.join(home, '.claude', 'reports', 'cursor-usage-pace-alert.txt');
}
export function ownerReportPath(home) {
  return path.join(home, '.claude', 'reports', 'cursor-usage-owner-report.json');
}

export function readOwnerReport(home) {
  try {
    const raw = fs.readFileSync(ownerReportPath(home), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' &&
        Number.isFinite(Number(parsed.cursorModelsPct)) &&
        Number.isFinite(Number(parsed.otherModelsPct))) {
      return {
        cursorModelsPct: Number(parsed.cursorModelsPct),
        otherModelsPct: Number(parsed.otherModelsPct),
        onDemandUsed: Boolean(parsed.onDemandUsed),
        at: parsed.at || '',
        by: parsed.by || '',
      };
    }
  } catch { /* not found or invalid */ }
  return null;
}

export function hoursAgo(ms, now = Date.now()) {
  return (now - ms) / 3_600_000;
}

export function findLastGoodFromState(home) {
  const state = readPaceState(home);
  if (state.lastGood && typeof state.lastGood === 'object' &&
      Number.isFinite(state.lastGood.cursorModelsPct) &&
      Number.isFinite(state.lastGood.otherModelsPct) &&
      state.lastGood.source && state.lastGood.source !== 'unavailable') {
    return state.lastGood;
  }
  return null;
}
export function cursorFillEnabledPath(home) {
  return path.join(home, '.claude', 'cursor-fill.enabled');
}
export function cursorFillQueuePath(home) {
  return path.join(home, '.claude', 'reports', 'cursor-fill-queue.jsonl');
}

export function jstStamp(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} JST`;
}

export function cycleWindow({ cycleStart = DEFAULT_CYCLE_START, cycleEnd = DEFAULT_CYCLE_END } = {}) {
  const start = Date.parse(cycleStart);
  const end = Date.parse(cycleEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('invalid cycle window');
  }
  return { start, end, days: (end - start) / 86_400_000 };
}

export function elapsedRatio(now, { cycleStart, cycleEnd } = {}) {
  const { start, end } = cycleWindow({ cycleStart, cycleEnd });
  const t = Number(now);
  if (t <= start) return 0;
  if (t >= end) return 1;
  return (t - start) / (end - start);
}

export function idealBand(now, opts = {}) {
  const ratio = elapsedRatio(now, opts);
  return {
    ratio,
    low: Number((ratio * (opts.targetLow ?? TARGET_END_LOW)).toFixed(3)),
    high: Number((ratio * (opts.targetHigh ?? TARGET_END_HIGH)).toFixed(3)),
  };
}

export function decideCursorPace({
  cursorModelsPct,
  otherModelsPct,
  now = Date.now(),
  onDemandUsed = false,
  haltPct = ON_DEMAND_HALT_PCT,
  cycleStart,
  cycleEnd,
} = {}) {
  const cursor = Number(cursorModelsPct);
  const other = Number(otherModelsPct);
  const havePct = Number.isFinite(cursor) && Number.isFinite(other);
  const band = idealBand(now, { cycleStart, cycleEnd });
  const used = havePct ? Math.max(cursor, other) : null;
  let decision = 'unknown';
  let fill = false;
  let halt = false;
  if (havePct && (onDemandUsed || cursor >= haltPct || other >= haltPct)) {
    decision = 'on_demand_risk';
    halt = true;
    fill = false;
  } else if (havePct && used > band.high) {
    decision = 'ahead';
    fill = false;
  } else if (havePct && used < band.low) {
    decision = 'behind';
    fill = true;
  } else if (havePct) {
    decision = 'on_track';
    fill = false;
  }
  return {
    havePct,
    cursorModelsPct: havePct ? cursor : null,
    otherModelsPct: havePct ? other : null,
    used,
    band,
    decision,
    fill,
    halt,
  };
}

const DECISION_JA = {
  behind: '遅れ',
  ahead: '先行',
  on_track: '適正',
  on_demand_risk: '従量の恐れ',
  unknown: '未取得',
};

export function formatPaceLine({
  now = Date.now(),
  cursorModelsPct,
  otherModelsPct,
  decision,
  fill,
  halt,
  source = '',
  localCursorOk = null,
  cycleStart = DEFAULT_CYCLE_START,
  cycleEnd = DEFAULT_CYCLE_END,
  band,
} = {}) {
  const { start, end, days } = cycleWindow({ cycleStart, cycleEnd });
  const elapsedDays = Number((((Number(now) - start) / 86_400_000)).toFixed(2));
  const startDay = new Date(start).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const endDay = new Date(end).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const cursor = (cursorModelsPct === 0 || Number.isFinite(cursorModelsPct)) && cursorModelsPct !== null && cursorModelsPct !== '' ? Number(cursorModelsPct).toFixed(1) : '—';
  const other = (otherModelsPct === 0 || Number.isFinite(otherModelsPct)) && otherModelsPct !== null && otherModelsPct !== '' ? Number(otherModelsPct).toFixed(1) : '—';
  const low = band ? band.low.toFixed(1) : '—';
  const high = band ? band.high.toFixed(1) : '—';
  const fillJa = halt ? '停止' : fill ? 'する' : 'しない';
  const demandJa = halt ? 'あり（止めて通知）' : 'なし';
  const local = Number.isFinite(Number(localCursorOk)) ? ` 本地cursor成功${Number(localCursorOk)}件` : '';
  const src = source ? ` 取得:${source}` : '';
  return `${jstStamp(now)} Cursor Models ${cursor}% / Other Models ${other}%（理想 ${low}–${high}%、目標期末 90–95%、周期 ${startDay}〜${endDay}、経過 ${elapsedDays}/${days} 日）判定:${DECISION_JA[decision] || decision} 追加回し:${fillJa} 従量:${demandJa}${src}${local}`;
}

export function readPaceState(home) {
  try {
    const raw = fs.readFileSync(cursorUsagePaceStatePath(home), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function isCursorUsageHalted(home, env = process.env) {
  if (String(env.CURSOR_USAGE_HALT || '') === '1') return true;
  return readPaceState(home).halt === true;
}
export function isCursorUsageFill(home, env = process.env) {
  if (String(env.CURSOR_USAGE_FILL || '') === '1') return true;
  return readPaceState(home).fill === true;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function writePaceOutputs(home, record) {
  const line = record.line || formatPaceLine(record);
  const txt = cursorUsagePaceTxtPath(home);
  const jsonl = cursorUsagePaceJsonlPath(home);
  const state = cursorUsagePaceStatePath(home);
  const alert = cursorUsagePaceAlertPath(home);
  ensureDir(txt);
  fs.writeFileSync(txt, `${line}\n`, 'utf8');
  fs.appendFileSync(jsonl, `${JSON.stringify({ ...record, line, t: new Date(record.now || Date.now()).toISOString() })}\n`, 'utf8');
  const stateDoc = {
    fill: Boolean(record.fill),
    halt: Boolean(record.halt),
    decision: record.decision,
    cursorModelsPct: record.cursorModelsPct,
    otherModelsPct: record.otherModelsPct,
    source: record.source || '',
    updatedAt: jstStamp(record.now || Date.now()),
  };
  // Save lastGood only when we have actual measurements (not estimates)
  if (Number.isFinite(record.cursorModelsPct) && Number.isFinite(record.otherModelsPct) &&
      record.source && record.source !== 'unavailable' &&
      !record.source.startsWith('前回値(') && !record.source.includes('(推定)')) {
    stateDoc.lastGood = {
      cursorModelsPct: record.cursorModelsPct,
      otherModelsPct: record.otherModelsPct,
      onDemandUsed: Boolean(record.onDemandUsed),
      source: record.source,
      at: new Date(record.now || Date.now()).toISOString(),
    };
  } else {
    // Preserve existing lastGood from previous state
    const prev = readPaceState(home);
    if (prev.lastGood) stateDoc.lastGood = prev.lastGood;
  }
  fs.writeFileSync(state, `${JSON.stringify(stateDoc, null, 2)}\n`, 'utf8');
  if (record.halt) {
    fs.writeFileSync(alert, `${line}\nCursor の従量課金に入りそうなので追加利用を止めました。ダッシュボードを確認してください。\n`, 'utf8');
  } else if (fs.existsSync(alert)) {
    try { fs.unlinkSync(alert); } catch { /* keep going */ }
  }
  return { line, txt, jsonl, state, alert: record.halt ? alert : null };
}

export function countCursorAgentRuns(home, { sinceMs = 0, untilMs = Date.now() } = {}) {
  const files = [
    path.join(home, '.claude', 'executor-usage.jsonl'),
    path.join(home, '.claude', 'fallback-backend-history.jsonl'),
  ];
  const seen = new Set();
  let attempts = 0;
  let ok = 0;
  let timeout = 0;
  let other = 0;
  const parseTime = (row) => {
    const t = row.t ?? row.ts ?? row.time ?? row.at;
    if (t == null) return NaN;
    if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
    return Date.parse(t);
  };
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\n/)) {
      const s = line.trim();
      if (!s) continue;
      let row;
      try { row = JSON.parse(s); } catch { continue; }
      const blob = `${row.backend || ''} ${row.provider || ''} ${row.model || ''} ${row.executor || ''}`;
      if (!/cursor-agent|cursor/i.test(blob)) continue;
      const t = parseTime(row);
      if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
      const key = `${file}:${t}:${row.outcome || row.status || ''}:${row.backend || row.provider || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts += 1;
      const outcome = String(row.outcome || row.status || '');
      if (outcome === 'ok' || outcome === 'success') ok += 1;
      else if (outcome === 'timeout') timeout += 1;
      else other += 1;
    }
  }
  return { attempts, ok, timeout, other };
}

// Map Team Admin / dashboard-like payloads into the two Ultra buckets.
// Unknown shapes return null percentages rather than inventing numbers.
export function extractPlanPercents(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const plan = payload.planUsage || payload.individualUsage?.plan || payload.usage?.plan || payload;
  const auto = plan.autoPercentUsed ?? plan.cursorModelsPct ?? payload.cursorModelsPct ?? payload.autoPercentUsed;
  const api = plan.apiPercentUsed ?? plan.otherModelsPct ?? payload.otherModelsPct ?? payload.apiPercentUsed;
  if (Number.isFinite(Number(auto)) && Number.isFinite(Number(api))) {
    return {
      cursorModelsPct: Number(auto),
      otherModelsPct: Number(api),
      onDemandUsed: Boolean(payload.onDemandUsed || payload.individualUsage?.onDemand?.used > 0),
      billingCycleStart: payload.billingCycleStart || plan.billingCycleStart,
      billingCycleEnd: payload.billingCycleEnd || plan.billingCycleEnd,
    };
  }
  return null;
}
