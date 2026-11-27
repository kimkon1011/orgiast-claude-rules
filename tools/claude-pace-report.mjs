#!/usr/bin/env node
/**
 * Claude ペース毎日報告（07:30 JST・集計担当 011、stale なら 018）。
 * 社外送信・支払いはしない。--dry-run は標準出力のみ。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { downloadFileContent, findOrCreateFolder, listFiles, uploadFileContent } from './lib/drive-files.mjs';
import { FOLDERS } from './hub-push.mjs';
import { decidePace, loadPaceConfig, defaultConfigPath, defaultQueuePath, paceLedgerPath } from './claude-pace.mjs';
import { summarizeQueue } from './claude-pace-queue.mjs';
import { checkSchema } from './lib/json-schema-check.mjs';
import { readCodexWindows } from './lib/quota-windows.mjs';
import { reportLocations } from './lib/claude-pace-report-core.mjs';

export { reportLocations } from './lib/claude-pace-report-core.mjs';

export const DAY_TARGET_PCT = 12.9;
export const REPORT_DIR_NAME = 'claude-pace-reports';

export const STATUS_JA = { behind: '遅れ', onpace: 'ちょうど', ahead: '進みすぎ', 'final-push': '残り10%モード', stopped: '停止（97%）', unmeasurable: '計測不能' };
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const finite = (n) => typeof n === 'number' && Number.isFinite(n) ? n : null;

/** UTC と JST は必ず同じ瞬間から生成する。 */
export function datePair(value) {
  const ms = value == null ? NaN : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return { jst: null, iso: null };
  return { jst: new Date(ms + 9 * 3600_000).toISOString().replace(/\.000Z$/, 'Z').replace(/Z$/, '+09:00'), iso: new Date(ms).toISOString() };
}

/** 当日分だけ読む。破損・日付違いも未受領として理由を残す。 */
export function readGrokbotInput(dateJst, repoRoot = REPO_ROOT) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateJst)) throw new Error('invalid report date');
  const relative = `reports/claude-pace/grokbot/${dateJst}.json`;
  try {
    const input = JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8').replace(/^\uFEFF/, ''));
    const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/claude-pace-grokbot-schema.json'), 'utf8'));
    const errors = checkSchema(schema, input);
    if (errors.length || input.date !== dateJst || !Number.isFinite(Date.parse(input.weeklyResetsAt)) ||
        (input.onDemandResetsAt != null && !Number.isFinite(Date.parse(input.onDemandResetsAt)))) throw new Error('入力スキーマまたは日付が不正');
    return { ...input, received: true };
  } catch (error) {
    return { received: false, note: `グロボ分 未受領（${relative} ${error.code === 'ENOENT' ? 'が無い' : '読取または入力検証に失敗'}）` };
  }
}

/** グロボにも既存の週枠判定をそのまま適用する。 */
export function judgeGrokbot(input, nowMs) {
  const decision = decidePace({ nowMs, usage: { available: true, fiveHour: {}, sevenDay: {
    utilization: input.weeklyUsedPercent, resetsAt: input.weeklyResetsAt,
  } } });
  return { elapsedRatio: decision.elapsedRatio, targetLinePct: decision.target, deltaPt: decision.deltaPt,
    effectiveTolerancePt: decision.effectiveTolerance, status: decision.status,
    statusJa: STATUS_JA[decision.status], projectedLandingPct: decision.projectedLanding };
}

export function readRegistrationStatus(repoRoot = REPO_ROOT) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, 'reports/claude-pace/registration.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!data.hosts || typeof data.hosts !== 'object' || Array.isArray(data.hosts)) throw new Error('hosts が不正');
    return data;
  } catch (error) { return { hosts: {}, note: `未確認（${error.code === 'ENOENT' ? 'registration.json が無い' : 'registration.json 読取失敗'}）` }; }
}

export function reportDir(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', REPORT_DIR_NAME);
}

export function loadQueue(queuePath = defaultQueuePath(), home = process.env.ORGIAST_HOME || os.homedir()) {
  const candidates = [
    queuePath,
    path.join(home, '.claude', 'claude-pace-queue.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* next */ }
  }
  return { tasks: [], newOfferings: [] };
}

/**
 * 011 が既定。011 の台帳が staleHours 以上古ければ 018。
 * @returns {boolean}
 */
export function shouldReport(host, config, lastSeenMap, now = Date.now()) {
  const primary = String(config?.reportHost || '011');
  const fallback = String(config?.reportFallbackHost || '018');
  const staleMs = (config?.staleHours ?? 3) * 3600_000;
  const nowMs = typeof now === 'number' ? now : Date.parse(String(now)) || Date.now();
  const raw = lastSeenMap?.[primary];
  const seen = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
  const primaryStale = !Number.isFinite(seen) || nowMs - seen > staleMs;
  const h = String(host);
  if (!primaryStale) return h === primary;
  return h === fallback;
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function ymdJst(nowMs) {
  return new Date(nowMs).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '');
}

/**
 * アカウント単位に最新スナップショットをまとめ、前日比（約24h前）を付ける。
 * @param {object[]} rows jsonl 行
 * @param {number} nowMs
 */
export function aggregateAccountSnapshots(rows, nowMs = Date.now()) {
  const byAccount = new Map();
  for (const row of rows || []) {
    if (!row || row.measurable === false || row.missing || row.status === 'unmeasurable' || !Number.isFinite(row.sevenDayPct)) continue;
    const account = row.account || 'unknown';
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts) || ts > nowMs) continue;
    const cur = byAccount.get(account);
    if (!cur || ts > cur.tsMs) {
      byAccount.set(account, { ...row, tsMs: ts });
    }
  }
  const dayAgo = nowMs - 24 * 3600_000;
  const out = [];
  for (const [account, latest] of byAccount) {
    let prev = null;
    let bestDiff = Infinity;
    for (const row of rows || []) {
      if ((row.account || 'unknown') !== account || row.measurable === false || row.missing || row.status === 'unmeasurable') continue;
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts > nowMs) continue;
      const diff = Math.abs(ts - dayAgo);
      if (ts < latest.tsMs && diff <= 6 * 3600_000 && diff < bestDiff) {
        bestDiff = diff;
        prev = row;
      }
    }
    const seven = latest.sevenDayPct;
    const prevSeven = prev?.sevenDayPct ?? null;
    const sameWindow = !prev?.sevenDayResetsAt || !latest.sevenDayResetsAt || Date.parse(prev.sevenDayResetsAt) === Date.parse(latest.sevenDayResetsAt);
    const dayDelta = sameWindow && Number.isFinite(seven) && Number.isFinite(prevSeven) && seven >= prevSeven ? seven - prevSeven : null;
    const projected = latest.projectedLanding != null
      ? Number(latest.projectedLanding)
      : null;
    out.push({
      ...latest,
      account,
      host: latest.host,
      hosts: [...new Set((rows || []).filter((r) => (r.account || 'unknown') === account).map((r) => r.host).filter(Boolean))],
      sevenDayPct: seven,
      target: latest.target,
      deltaPt: latest.deltaPt,
      projectedLanding: projected,
      unusedForecast: projected == null ? null : 100 - projected,
      dayDelta,
      dayTarget: DAY_TARGET_PCT,
      dayDeltaVsTarget: dayDelta == null ? null : dayDelta - DAY_TARGET_PCT,
      status: latest.status,
      launch: latest.launch,
      hold: latest.hold,
      reasons: latest.reasons || [],
      codex: latest.codex || [],
      ts: latest.ts,
      measurable: true,
    });
  }
  return out.sort((a, b) => String(a.account).localeCompare(String(b.account)));
}

/**
 * @param {{
 *   snapshots: object[],
 *   queue?: object,
 *   config?: object,
 *   now?: number,
 *   missingHosts?: {host:string, reason:string}[],
 *   actionsTaken?: string[],
 *   grokbot?: object,
 *   registration?: object,
 *   generatedByHost?: string,
 * }} input
 * @returns {{ markdown: string, json: object }}
 */
export function buildReport({
  snapshots = [],
  queue = { tasks: [], newOfferings: [] },
  config = {},
  now = Date.now(),
  missingHosts = [],
  actionsTaken = null,
  grokbot = { received: false, note: 'グロボ分 未受領（当日入力なし）' },
  registration = { hosts: {} },
  generatedByHost = process.env.ORGIAST_HOSTNAME || os.hostname(),
} = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(String(now)) || Date.now();
  const date = datePair(nowMs).jst.slice(0, 10);
  const accounts = aggregateAccountSnapshots(
    snapshots,
    nowMs,
  ).filter((a) => datePair(a.ts).jst?.startsWith(date));
  const missing = [
    ...missingHosts,
    ...snapshots.filter((s) => s?.missing || s?.measurable === false).map((s) => ({
      host: s.host || s.pc || '?',
      reason: s.missingReason || s.reason || '計測できなかった',
    })),
  ];

  const hostAccounts = new Map(Object.entries(config.accounts || {}).flatMap(([account, item]) => (item.pcs || []).map((host) => [String(host), account])));
  for (const s of snapshots) if (s?.host && !hostAccounts.has(String(s.host))) hostAccounts.set(String(s.host), s.account || null);
  for (const m of missing) if (!hostAccounts.has(String(m.host))) hostAccounts.set(String(m.host), null);
  for (const host of Object.keys(registration.hosts || {})) if (!hostAccounts.has(host)) hostAccounts.set(host, null);
  const pcs = [...hostAccounts].map(([host, account]) => {
    const latest = snapshots.filter((s) => String(s?.host) === host && Number.isFinite(Date.parse(s.ts)) && Date.parse(s.ts) <= nowMs)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
    const stamp = datePair(latest?.ts);
    const measured = !!(stamp.jst?.startsWith(date) && latest.measurable !== false && !latest.missing && latest.status !== 'unmeasurable' && finite(latest.sevenDayPct) !== null);
    const reason = measured ? null : missing.find((m) => m.host === host)?.reason || latest?.missingReason || latest?.reason || '台帳に当日のスナップショットが無い';
    const entry = registration.hosts?.[host];
    return { host, account, measured, reason, lastSnapshotAtJst: stamp.jst, lastSnapshotAtIso: stamp.iso,
      registered: typeof entry?.registered === 'boolean' ? entry.registered : null };
  });
  const unmeasured = pcs.filter((p) => !p.measured).map(({ host, reason }) => ({ host, reason }));

  const autoActions = [];
  for (const a of accounts) {
    if (a.status === 'stopped') {
      autoActions.push(`${a.account}（${a.host}）: 台帳にハードストップを記録`);
    } else if (a.hold) {
      autoActions.push(`${a.account}（${a.host}）: 台帳に hold を記録（理由: ${(a.reasons || []).join(',') || a.status}）`);
    } else if (a.launch) {
      autoActions.push(`${a.account}（${a.host}）: 台帳に作業起動判定を記録（理由: ${(a.reasons || []).join(',') || a.status}）`);
    } else if (a.status === 'onpace') {
      autoActions.push(`${a.account}（${a.host}）: 予定どおり（起動なし）`);
    } else if (a.status === 'final-push') {
      autoActions.push(`${a.account}（${a.host}）: 最終押し込み`);
    }
  }
  const actions = actionsTaken || autoActions;

  const summary = summarizeQueue(queue);
  // 残り10%に回す上位3件: 全 host の未着手を priority 順で
  const pending = [...(queue.tasks || [])]
    .filter((t) => t.state === '未着手' || t.state === '失敗')
    .filter((t) => !/送信する|メールを送る|フォームから送信|LINE\s*で送る/.test(`${t.title}\n${t.prompt}`))
    .sort((a, b) => {
      const pa = Number(a.priority) || 99;
      const pb = Number(b.priority) || 99;
      if (pa !== pb) return pa - pb;
      return String(a.id).localeCompare(String(b.id));
    })
    .slice(0, 3);

  const startedOfferings = summary.newOfferingsStarted || [];

  const codexLines = [];
  for (const a of accounts) {
    for (const c of a.codex || []) {
      codexLines.push(`${a.account}: window=${c.window ?? c.windowMinutes ?? '?'} used=${c.usedPercent ?? '—'}%`);
    }
  }

  const targetLanding = config.targetLanding ?? 90;
  const lines = [];
  lines.push(`# Claude ペース日次報告（${new Date(nowMs).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST）`);
  lines.push('');
  lines.push('## 結論');
  const behind = accounts.filter((a) => a.status === 'behind');
  const onpace = accounts.filter((a) => a.status === 'onpace');
  const ahead = accounts.filter((a) => a.status === 'ahead');
  if (!accounts.length) {
    lines.push('- 計測できたアカウントが無い。Drive / ローカル台帳を確認すること。');
  } else {
    lines.push(`- 目標着地 ${targetLanding}%（日次目安 ${DAY_TARGET_PCT}%）。遅れ ${behind.length} / ちょうど ${onpace.length} / 進みすぎ ${ahead.length} / 計測 ${accounts.length} アカウント。`);
  }
  lines.push('');

  lines.push('## アカウント別');
  for (const a of accounts) {
    const pcs = (a.hosts || [a.host]).filter(Boolean).join(',');
    lines.push(`### ${a.account}（PC: ${pcs || a.host || '—'}）`);
    lines.push(`- 前日の消費（7日枠%の増分）: ${a.dayDelta == null ? '—' : `${a.dayDelta >= 0 ? '+' : ''}${a.dayDelta.toFixed(1)}pt`}`);
    lines.push(`- 日次目標 ${DAY_TARGET_PCT}% との差: ${a.dayDeltaVsTarget == null ? '—' : `${a.dayDeltaVsTarget >= 0 ? '+' : ''}${a.dayDeltaVsTarget.toFixed(1)}pt`}`);
    lines.push(`- 現在の7日%: ${fmtPct(a.sevenDayPct)} / 目標線: ${fmtPct(a.target)}`);
    lines.push(`- 予測着地: ${fmtPct(a.projectedLanding)}`);
    lines.push(`- 未使用見込み（100−予測着地）: ${a.unusedForecast == null ? '—' : `${a.unusedForecast.toFixed(1)}pt${a.unusedForecast < 0 ? '（超過見込み）' : ''}`}`);
    lines.push(`- 今日の目標: 日次 ${DAY_TARGET_PCT}% 前後（着地 ${targetLanding}% 線に乗せる）`);
    lines.push(`- 判定: ${a.status || '—'}`);
    lines.push('');
  }
  if (!accounts.length) lines.push('（なし）', '');

  lines.push('## 進みすぎ・遅れと措置');
  if (actions.length) for (const a of actions) lines.push(`- ${a}`);
  else lines.push('- （措置なし）');
  lines.push('');

  lines.push('## 残り10%に回す作業（次の上位3件）');
  if (pending.length) {
    for (const t of pending) lines.push(`- ${t.id} [${t.host}/p${t.priority}] ${t.title}`);
  } else {
    lines.push('- （未着手なし。newOfferings から補充を検討）');
  }
  lines.push('');

  lines.push('## 新しく始めたサービス・商品');
  if (startedOfferings.length) {
    for (const o of startedOfferings) lines.push(`- ${o.id} [${o.host}] ${o.title}（state=${o.state}）`);
  } else {
    lines.push('- （まだ無し）');
  }
  lines.push('');

  lines.push('## Codex 参考値');
  if (codexLines.length) for (const c of codexLines) lines.push(`- ${c}`);
  else lines.push('- （スナップショットに Codex 値なし）');
  lines.push('');

  lines.push('## 計測できなかったPC');
  if (unmeasured.length) {
    for (const m of unmeasured) lines.push(`- ${m.host}: ${m.reason}`);
  } else {
    lines.push('- （なし）');
  }
  lines.push('');

  lines.push('## アカウント一覧', '| アカウント / PC | 5時間枠 | 7日枠 | リセット JST（5h / 7d） | 前日の消費 pt | 目標線との差 pt | 判定 | 予測着地 |', '|---|---:|---:|---|---:|---:|---|---:|');
  const accountRows = accounts.map((a) => {
    const five = datePair(a.fiveHourResetsAt), seven = datePair(a.sevenDayResetsAt);
    const decision = decidePace({ nowMs: Date.parse(a.ts), usage: { available: true, fiveHour: {}, sevenDay: { utilization: a.sevenDayPct, resetsAt: a.sevenDayResetsAt } }, targetLanding });
    const status = STATUS_JA[a.status] ? a.status : 'unmeasurable';
    const hosts = [...new Set([...(config.accounts?.[a.account]?.pcs || []), ...a.hosts].map(String))];
    lines.push(`| ${a.account} / ${hosts.join(',')} | ${fmtPct(a.fiveHourPct)} | ${fmtPct(a.sevenDayPct)} | ${five.jst || '—'} / ${seven.jst || '—'} | ${a.dayDelta == null ? '—' : a.dayDelta.toFixed(1)} | ${a.deltaPt == null ? '—' : a.deltaPt.toFixed(1)} | ${STATUS_JA[status]} | ${fmtPct(a.projectedLanding)} |`);
    return { account: a.account, pcs: hosts,
      fiveHour: { usedPercent: finite(a.fiveHourPct), resetsAtJst: five.jst, resetsAtIso: five.iso },
      sevenDay: { usedPercent: finite(a.sevenDayPct), resetsAtJst: seven.jst, resetsAtIso: seven.iso },
      elapsedRatio: finite(a.elapsedRatio ?? decision.elapsedRatio), previousDayConsumedPt: a.dayDelta,
      dailyTargetDeltaPt: a.dayDeltaVsTarget, targetLinePct: finite(a.target), deltaPt: finite(a.deltaPt),
      effectiveTolerancePt: finite(a.effectiveTolerance ?? decision.effectiveTolerance), status, statusJa: STATUS_JA[status],
      projectedLandingPct: finite(a.projectedLanding), unusedForecastPt: finite(a.unusedForecast), todayTargetPct: DAY_TARGET_PCT,
      hold: !!a.hold, actionsTaken: actionsTaken || (a.actionsTaken || autoActions.filter((text) => text.startsWith(`${a.account}（`))),
      codex: (a.codex || []).map((c) => ({ window: String(c.window ?? c.windowMinutes ?? '?'), usedPercent: finite(c.usedPercent) })) };
  });
  const g = grokbot || { received: false, note: 'グロボ分 未受領（当日入力なし）' };
  const received = g.received !== false && g.date === date && finite(g.weeklyUsedPercent) !== null && Number.isFinite(Date.parse(g.weeklyResetsAt));
  const weekly = datePair(received ? g.weeklyResetsAt : null), demand = datePair(received ? g.onDemandResetsAt : null);
  const judged = received ? judgeGrokbot(g, nowMs) : Object.fromEntries(['elapsedRatio', 'targetLinePct', 'deltaPt', 'effectiveTolerancePt', 'status', 'statusJa', 'projectedLandingPct'].map((key) => [key, null]));
  const grokbotRow = { received, date: received ? g.date : null, weeklyUsedPercent: received ? g.weeklyUsedPercent : null,
    weeklyResetsAtJst: weekly.jst, weeklyResetsAtIso: weekly.iso, ...judged,
    onDemandUsd: received ? g.onDemandUsd ?? null : null, onDemandLimitUsd: received ? g.onDemandLimitUsd ?? null : null,
    onDemandResetsAtJst: demand.jst, onDemandResetsAtIso: demand.iso,
    selfExecutedTasks: received ? g.selfExecutedTasks ?? null : null, delegatedTasks: received ? g.delegatedTasks ?? null : null,
    note: received ? g.note || '' : g.received === false ? g.note || 'グロボ分 未受領（当日入力なし）' : 'グロボ分 未受領（当日分の有効な入力なし）' };
  lines.push('', '## グロボ', '| 週枠 | リセット JST | 目標線 | 差 pt | 判定 | 予測着地 | 従量 USD |', '|---:|---|---:|---:|---|---:|---:|',
    received ? `| ${fmtPct(g.weeklyUsedPercent)} | ${weekly.jst} | ${fmtPct(judged.targetLinePct)} | ${judged.deltaPt.toFixed(1)} | ${judged.statusJa} | ${fmtPct(judged.projectedLandingPct)} | ${g.onDemandUsd ?? '—'} / ${g.onDemandLimitUsd ?? '—'} |` : `| グロボ分 未受領 | — | — | — | — | — | — |`, grokbotRow.note, '',
    '## 各PCの登録状況', '| PC | 登録状況 | 理由 |', '|---|---|---|');
  for (const pc of pcs) lines.push(`| ${pc.host} | ${pc.registered === null ? '未確認' : pc.registered ? '登録済み' : '未反映'} | ${registration.hosts?.[pc.host]?.note || (pc.registered === null ? registration.note || '登録結果なし' : pc.registered ? '登録確認済み' : '登録結果が false')} |`);
  lines.push('', reportLocations(date));
  const generated = datePair(nowMs);
  const json = { schemaVersion: 1, date, generatedAtJst: generated.jst, generatedAtIso: generated.iso,
    generatedByHost: String(generatedByHost), targetLandingPct: targetLanding, dailyTargetPct: DAY_TARGET_PCT,
    accounts: accountRows, pcs, grokbot: grokbotRow,
    nextTasks: pending.map((t) => ({ id: t.id, host: String(t.host), priority: Number(t.priority) || 99, title: t.title })),
    newOfferings: startedOfferings.map((o, i) => ({ id: o.id, rank: Number(o.rank) || i + 1, host: String(o.host), title: o.title, state: o.state })),
    unmeasured };

  return { markdown: `${lines.join('\n')}\n`, json };
}

function parseJsonl(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

/**
 * Drive 共有ハブ `claude-pace/pace-*.jsonl` を読む。失敗時はローカル台帳。
 */
export async function loadPaceSnapshots({
  config,
  home = process.env.ORGIAST_HOME || os.homedir(),
  hubFolderId = FOLDERS.hub,
  getToken = getDriveToken,
  driveFiles = { findOrCreateFolder, listFiles, downloadFileContent },
} = {}) {
  const expectedHosts = [...new Set(
    Object.values(config?.accounts || {}).flatMap((m) => (Array.isArray(m?.pcs) ? m.pcs.map(String) : [])),
  )];
  const rows = [];
  const missingHosts = [];
  const lastSeenMap = {};
  let driveOk = false;

  try {
    const token = await getToken();
    const folder = await driveFiles.findOrCreateFolder(token, 'claude-pace', hubFolderId);
    const folderId = folder?.id;
    if (!folderId) throw new Error('claude-pace folder missing');
    const files = await driveFiles.listFiles(token, folderId);
    const paceFiles = (files || []).filter((f) => /^pace-.+\.jsonl$/i.test(f.name || f.title || ''));
    driveOk = true;
    const seenHosts = new Set();
    for (const f of paceFiles) {
      const name = f.name || f.title || '';
      const host = name.replace(/^pace-/i, '').replace(/\.jsonl$/i, '');
      seenHosts.add(host);
      try {
        const buf = await driveFiles.downloadFileContent(token, f.id);
        const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
        const parsed = parseJsonl(text);
        for (const row of parsed) rows.push(row);
        for (let i = parsed.length - 1; i >= 0; i--) {
          const ts = Date.parse(parsed[i]?.ts);
          if (Number.isFinite(ts)) { lastSeenMap[host] = ts; break; }
        }
      } catch (error) {
        missingHosts.push({ host, reason: `Drive読取失敗: ${error.message || error}` });
      }
    }
    for (const h of expectedHosts) {
      if (!seenHosts.has(h) && !missingHosts.some((m) => m.host === h)) {
        missingHosts.push({ host: h, reason: 'Drive に pace-*.jsonl が無い' });
      }
    }
  } catch (error) {
    missingHosts.push({ host: '*', reason: `Drive不通のためローカル台帳を使用: ${error.message || error}` });
  }

  if (!driveOk || rows.length === 0) {
    try {
      const text = fs.readFileSync(paceLedgerPath(home), 'utf8');
      const localRows = parseJsonl(text);
      for (const row of localRows) rows.push(row);
      if (!localRows.length) {
        missingHosts.push({ host: 'local', reason: 'ローカル台帳が空' });
      }
    } catch (error) {
      missingHosts.push({ host: 'local', reason: `ローカル台帳読取失敗: ${error.message || error}` });
    }
  }

  return { rows, missingHosts, lastSeenMap, driveOk };
}

export async function uploadReportToDrive({
  basename,
  markdown,
  jsonText,
  hubFolderId = FOLDERS.hub,
  getToken = getDriveToken,
  driveFiles = { findOrCreateFolder, listFiles, uploadFileContent },
} = {}) {
  try {
    const token = await getToken();
    const folder = await driveFiles.findOrCreateFolder(token, 'claude-pace', hubFolderId);
    const folderId = folder?.id;
    if (!folderId) throw new Error('claude-pace folder missing');
    const existing = await driveFiles.listFiles(token, folderId);
    const findId = (name) => (existing || []).find((f) => (f.name || f.title) === name)?.id;
    await driveFiles.uploadFileContent(token, {
      fileId: findId(`${basename}.md`) || undefined,
      name: `${basename}.md`,
      parentId: folderId,
      content: markdown,
      mimeType: 'text/markdown',
      contentType: 'text/markdown; charset=utf-8',
    });
    await driveFiles.uploadFileContent(token, {
      fileId: findId(`${basename}.json`) || undefined,
      name: `${basename}.json`,
      parentId: folderId,
      content: jsonText,
      mimeType: 'application/json',
      contentType: 'application/json; charset=utf-8',
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    jsonOutput: false,
    force: false,
    home: process.env.ORGIAST_HOME || os.homedir(),
    host: process.env.ORGIAST_HOSTNAME || os.hostname(),
    configPath: defaultConfigPath(),
    queuePath: defaultQueuePath(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json-output') opts.jsonOutput = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--home') opts.home = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--config') opts.configPath = argv[++i];
    else if (a === '--queue') opts.queuePath = argv[++i];
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const opts = parseArgs(argv);
  const home = io.home ?? opts.home;
  const host = String(io.host ?? opts.host);
  const nowMs = io.nowMs ?? Date.now();
  const config = io.config ?? loadPaceConfig(opts.configPath);
  const queue = io.queue ?? loadQueue(opts.queuePath, home);

  const loaded = io.snapshots
    ? { rows: io.snapshots, missingHosts: io.missingHosts || [], lastSeenMap: io.lastSeenMap || {}, driveOk: true }
    : opts.dryRun ? { rows: fs.existsSync(paceLedgerPath(home)) ? parseJsonl(fs.readFileSync(paceLedgerPath(home), 'utf8')) : [], missingHosts: [], lastSeenMap: {} }
    : await loadPaceSnapshots({
      config,
      home,
      getToken: io.getDriveToken,
      driveFiles: io.driveFiles,
    });

  if (!opts.force && !opts.dryRun) {
    const ok = shouldReport(host, config, loaded.lastSeenMap, nowMs);
    if (!ok) {
      const msg = `claude-pace-report skip host=${host} (reportHost=${config.reportHost}, fallback=${config.reportFallbackHost})`;
      (io.print ?? console.log)(msg);
      return { skipped: true, reason: 'not-report-host', host };
    }
  }

  // dry-run でも本文は出す（担当判定は --force なしでも dry-run は本文優先）
  let { markdown, json } = buildReport({
    snapshots: loaded.rows,
    queue,
    config,
    now: nowMs,
    missingHosts: loaded.missingHosts,
    grokbot: io.grokbot ?? readGrokbotInput(datePair(nowMs).jst.slice(0, 10), io.repoRoot || REPO_ROOT),
    registration: io.registration ?? readRegistrationStatus(io.repoRoot || REPO_ROOT),
    generatedByHost: host,
  });

  const print = io.print ?? console.log;
  if (opts.dryRun) {
    print(opts.jsonOutput ? JSON.stringify({ markdown, json }) : markdown);
    return { dryRun: true, markdown, json };
  }

  // 既存のローカル参考値も維持する。取得不能を0とは扱わない。
  if (!json.accounts.some((a) => a.codex.length)) {
    try {
      const windows = readCodexWindows({ home, now: nowMs }).map((w) => ({ window: String(w.window), usedPercent: finite(w.usedPercent) }));
      if (windows.length) {
        const localAccount = json.accounts.find((a) => a.pcs.includes(host));
        if (localAccount) localAccount.codex = windows;
        markdown = markdown.replace('- （スナップショットに Codex 値なし）',
          windows.map((w) => `- ローカル参考 PC ${host}: window=${w.window} used=${w.usedPercent ?? '—'}%`).join('\n'));
      }
    } catch { /* ローカル参考値なしでも日報配信は続ける。 */ }
  }

  const publication = await (io.publishReport ?? (await import('./claude-pace-report-publish.mjs')).publishReport)({ report: { markdown, json }, home, getToken: io.getDriveToken, driveFiles: io.driveFiles });
  markdown = publication.markdown;
  const stamp = ymdJst(nowMs);
  const basename = `report-${stamp}`;
  const dir = reportDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${basename}.md`);
  const jsonPath = path.join(dir, `${basename}.json`);
  const jsonText = `${JSON.stringify(json, null, 2)}\n`;
  fs.writeFileSync(mdPath, markdown);
  fs.writeFileSync(jsonPath, jsonText);

  const drive = { ok: !publication.driveError, error: publication.driveError };

  let notifyResult = null;
  const notify = io.notifyKim ?? (await import('./notify-kim.mjs')).notifyKim;
  const body = [
    `【Claudeペース日次】${stamp}`,
    markdown.slice(0, 1500),
    mdPath,
    markdown.slice(markdown.indexOf('## 配信結果') >= 0 ? markdown.indexOf('## 配信結果') : markdown.indexOf('## 置き場所')),
  ].join('\n');
  notifyResult = await notify(body, { home, kind: 'info', source: 'claude-pace-report' });

  print(`claude-pace-report wrote ${mdPath} drive=${drive.ok ? 'ok' : drive.error} notify=${notifyResult?.delivered || '?'}`);
  return { markdown, json, mdPath, jsonPath, drive, publication, notifyResult };
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
