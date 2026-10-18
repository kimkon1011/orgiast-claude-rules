import path from 'node:path';
import { createHash } from 'node:crypto';
import { readInbox } from '../fleet-mail.mjs';
import { buildFleetStatus } from '../fleet-status.mjs';
import { DAY, HOUR, iso, millis, readJson, saveJson, makeItem, active, complete, oldest, CATEGORY } from './fleet-chase-ledger.mjs';
import { RULE_COMPLIANCE_TAG, COMPLIANCE_CONTROLLER, measuredRules,
  parseRuleComplianceMail, latestComplianceByPc } from './rule-compliance-mail.mjs';

export const ROLLOUT_POLICY = Object.freeze({ applicable: 5, rate: 0.5, consecutiveDays: 3,
  historyDays: 30, reportAge: 72 * HOUR, pollAge: 48 * HOUR });
export const complianceHistoryPath = home => path.join(home, '.claude/fleet-chase/compliance-history.json');
export const percent = rate => Math.round(rate * 100);
const dayKey = at => new Date(millis(at)).toISOString().slice(0, 10);
const fresh = (report, now) => report && millis(report.at) <= now && now - millis(report.at) < ROLLOUT_POLICY.reportAge;

export function collectComplianceReports({ home, now, readInboxImpl = readInbox }) {
  const reports = readInboxImpl(home, { unreadOnly: false })
    .filter(mail => mail.to === COMPLIANCE_CONTROLLER)
    .map(parseRuleComplianceMail).filter(Boolean);
  const own = readJson(path.join(home, '.claude/rule-compliance-fleet-self.json'));
  if (own?.pc === COMPLIANCE_CONTROLLER) {
    const report = parseRuleComplianceMail({ why: RULE_COMPLIANCE_TAG, body: JSON.stringify(own) });
    if (report) reports.push(report);
  }
  return reports.filter(report => millis(report.at) <= now);
}

export function updateComplianceHistory(previous, reports, now) {
  const pcs = {};
  const start = dayKey(now - (ROLLOUT_POLICY.historyDays - 1) * DAY);
  const oldReports = Object.values(previous?.pcs || {}).flatMap(days => Object.values(days));
  for (const report of [...oldReports, ...reports]) {
    const normalized = parseRuleComplianceMail({ why: RULE_COMPLIANCE_TAG, body: JSON.stringify(report) });
    if (!normalized || millis(normalized.at) > now) continue;
    const day = dayKey(normalized.at);
    if (day < start) continue;
    pcs[normalized.pc] ||= {};
    const old = pcs[normalized.pc][day];
    if (!old || millis(normalized.at) >= millis(old.at)) pcs[normalized.pc][day] = normalized;
  }
  return { version: 1, pcs };
}

export async function collectRollout(ctx) {
  const reports = collectComplianceReports(ctx);
  const history = updateComplianceHistory(readJson(complianceHistoryPath(ctx.home), { pcs: {} }), reports, ctx.now);
  const latest = latestComplianceByPc([...Object.values(history.pcs).flatMap(days => Object.values(days)), ...reports]);
  let fleet = { beacons: [], serverPolls: {} };
  try { fleet = await ctx.fetchBeacons(); }
  catch { ctx.stderr?.('fleet-chase: ビーコン取得失敗（報告欠落の新規判定を保留）'); }
  if (fleet.ok === false) ctx.stderr?.('fleet-chase: ビーコン取得不可（報告欠落の新規判定を保留）');
  const rows = buildFleetStatus({ pcMap: { ...ctx.pcMap, [COMPLIANCE_CONTROLLER]: {} },
    beacons: fleet.ok === false ? [] : fleet.beacons, serverPolls: fleet.ok === false ? {} : fleet.serverPolls, now: ctx.now });
  let convergence = null;
  try { convergence = readJson(path.join(ctx.home, '.claude/.fleet-convergence-watch.json')); }
  catch { ctx.stderr?.('fleet-chase: 配布収束状態を読めないため既存ミラーを維持'); }
  return { history, latest, rows, convergence };
}

function rolloutId(pc, subkind, ruleId = '') {
  return `rollout-${subkind}-${createHash('sha256').update(JSON.stringify([pc, ruleId])).digest('hex').slice(0, 24)}`;
}
function openRollout(ledger, { pc, subkind, ruleId = '', title, body, at, summary = '', source = '' }, now) {
  const id = rolloutId(pc, subkind, ruleId);
  const previous = ledger.items[id];
  if (previous && previous.status !== 'done') return previous;
  const suffix = createHash('sha256').update(`${id}:${at}:${now}`).digest('hex').slice(0, 24);
  const direction = pc === COMPLIANCE_CONTROLLER ? 'inbound' : 'outbound';
  const item = makeItem({ id: `mail-rollout-${suffix}`, from: COMPLIANCE_CONTROLLER, to: pc,
    why: title, body, createdAt: iso(now), expiresAt: iso(now), messageKind: 'note' }, direction, now);
  Object.assign(item, { id, kind: 'rollout', direction, subkind, ruleId, pc, target: pc,
    summary, source, openedReportAt: at, category: CATEGORY.task, previousEpisodes: (previous?.previousEpisodes || 0) + (previous ? 1 : 0) });
  ledger.items[id] = item;
  return item;
}
function violationBody(rule, rate) {
  return `[作業依頼] ルール ${rule.id}（${rule.summary}、出典 ${rule.source}）の違反率が ${percent(rate)}% で ${ROLLOUT_POLICY.consecutiveDays} 日続いています。`
    + '(1) `node tools/rule-compliance-loop.mjs --days 7 --apply` を実行して enforcement を更新 '
    + '(2) 直近違反 3 件（session id と抜粋は `~/.claude/rule-compliance.md`）の原因を 1 行ずつ '
    + '(3) 再発防止として入れた hook/memory の名前、を返信してください。'
    + '完了の証拠は次回の日次報告（違反率低下 または mode=block）で確認します。';
}
function streak(history, pc, ruleId, after = 0) {
  const days = Object.entries(history.pcs[pc] || {}).sort(([a], [b]) => a.localeCompare(b)).slice(-ROLLOUT_POLICY.consecutiveDays);
  return days.length === ROLLOUT_POLICY.consecutiveDays && days.every(([day, report], index) => {
    const row = report.rules[ruleId];
    return millis(report.at) > after && row?.applicable >= ROLLOUT_POLICY.applicable && row.rate >= ROLLOUT_POLICY.rate
      && (!index || millis(day) - millis(days[index - 1][0]) === DAY);
  });
}

// Called both after ingestion and after reply checks. Replies alone cannot close rollout items.
export function reconcileRollout(ledger, snapshot, { home, now, dryRun = false }) {
  const { history, latest, rows, convergence } = snapshot;
  const byPc = new Map(latest.map(report => [report.pc, report]));
  for (const item of Object.values(ledger.items).filter(i => i.kind === 'rollout' && active(i))) {
    const report = byPc.get(item.pc);
    const row = report?.rules[item.ruleId];
    if (item.subkind === 'violation' && row) item.latestRule = row;
    if (!fresh(report, now) || millis(report.at) <= millis(item.openedReportAt)) continue;
    if (item.subkind === 'violation' && millis(report.at) <= millis(item.firstSeenAt)) continue;
    const improved = row?.applicable > 0 && row.rate < ROLLOUT_POLICY.rate;
    const enforced = row?.mode === 'block' && item.replyEvidence
      && millis(report.at) >= millis(item.replyEvidence.at);
    if (item.subkind === 'no-report' || item.subkind === 'violation' && (improved || enforced)) {
      complete(item, { type: 'compliance-report', at: report.at, pc: report.pc,
        ruleId: item.ruleId, rate: row?.rate, mode: row?.mode, reply: enforced ? item.replyEvidence : undefined }, now);
    }
  }
  for (const report of latest.filter(report => fresh(report, now))) {
    for (const rule of measuredRules) {
      const row = report.rules[rule.id];
      const previous = ledger.items[rolloutId(report.pc, 'violation', rule.id)];
      if (!streak(history, report.pc, rule.id, previous?.status === 'done' ? millis(previous.lastEvidenceAt) : 0)) continue;
      const title = `[ルール遵守] ${report.pc} ${rule.id} 違反率 ${percent(row.rate)}%（${row.violation}/${row.applicable}、mode=${row.mode}）`;
      const item = openRollout(ledger, { pc: report.pc, subkind: 'violation', ruleId: rule.id,
        title, body: violationBody(rule, row.rate), at: report.at, summary: rule.summary, source: rule.source }, now);
      if (active(item)) Object.assign(item, { title, latestRule: row });
    }
  }
  // 導入直後の猶予: 各PCは夜間同期で新コードを受け取るまで報告できない。全PCへ初日に「報告なし」の
  // 作業依頼を一斉送信しないよう、そのPCから過去に報告があるか、フリート最初の報告から 72h 以上経つまでは起票しない。
  const firstReportAt = Math.min(...Object.values(history.pcs).flatMap(days => Object.values(days)).map(report => millis(report.at)).filter(Boolean));
  const fleetWarmedUp = Number.isFinite(firstReportAt) && now - firstReportAt >= ROLLOUT_POLICY.reportAge;
  for (const row of rows) {
    const report = byPc.get(row.label);
    if (!row.pollAt || row.pollAgeMs < 0 || row.pollAgeMs > ROLLOUT_POLICY.pollAge || fresh(report, now)) continue;
    if (!history.pcs[row.label] && !fleetWarmedUp) continue;
    openRollout(ledger, { pc: row.label, subkind: 'no-report', at: report?.at || null,
      title: `[ルール遵守] ${row.label} 遵守報告なし（最終 ${report?.at || 'なし'}、最終poll ${row.pollAt}）`,
      body: '[作業依頼] 夜間のルール遵守報告が kim-PC に届いていません。`node tools/setup.mjs --converge` を実行し、その出力末尾 20 行を返信してください。' }, now);
  }
  // Missing/corrupt watch state is not evidence that convergence succeeded.
  if (convergence?.targets && typeof convergence.targets === 'object' && !Array.isArray(convergence.targets)) {
    for (const [key, target] of Object.entries(convergence.targets)) {
      const pc = target.pc || target.label || target.hostname || `配布対象(${key})`;
      const id = rolloutId(key, 'convergence');
      let item = ledger.items[id];
      if (!item || item.status === 'done') {
        item = openRollout(ledger, { pc: key, subkind: 'convergence', at: iso(target.firstSeen || now),
          title: `[配布未収束] ${pc}`, body: 'convergence-watch が収束を追跡中' }, now);
        Object.assign(item, { pc, target: pc, convergenceKey: key, direction: 'mirror' });
      }
      item.convergenceState = target;
    }
    for (const item of Object.values(ledger.items).filter(i => i.kind === 'rollout' && i.subkind === 'convergence' && active(i))) {
      if (!Object.hasOwn(convergence.targets, item.convergenceKey)) complete(item, { type: 'convergence-cleared', at: iso(now) }, now);
    }
  }
  if (!dryRun) saveJson(complianceHistoryPath(home), history);
}

export function rolloutSummary(ledger) {
  const items = Object.values(ledger.items).filter(item => item.kind === 'rollout' && active(item));
  const count = subkind => items.filter(item => item.subkind === subkind).length;
  return `ルール遵守: 違反継続 ${count('violation')} 件（PC×ルール）/ 報告なし ${count('no-report')} PC / 配布未収束 ${count('convergence')}`;
}
export function rolloutTop(ledger) {
  return Object.values(ledger.items).filter(item => item.kind === 'rollout' && active(item)).sort(oldest).slice(0, 3);
}
export function complianceTable({ latest, rows }) {
  const reports = new Map(latest.map(report => [report.pc, report]));
  const polls = new Map(rows.map(row => [row.label, row.pollAt]));
  const pcs = [...new Set([...polls.keys(), ...reports.keys()])].sort();
  const lines = ['PC / 報告日時 / ' + measuredRules.map(rule => `${rule.short || rule.id} 違反率`).join(' / ')];
  for (const pc of pcs) {
    const report = reports.get(pc);
    const values = measuredRules.map(rule => {
      const row = report?.rules[rule.id];
      return row ? `${percent(row.rate)}%(${row.violation}/${row.applicable},${row.mode})` : '—';
    });
    lines.push(`${pc} / ${report?.at || `—（最終poll ${polls.get(pc) || '不明'}）`} / ${values.join(' / ')}`);
  }
  return lines.join('\n');
}
