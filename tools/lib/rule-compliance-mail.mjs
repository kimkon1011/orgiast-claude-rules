import fs from 'node:fs';

export const RULE_COMPLIANCE_TAG = '[rule-compliance]';
export const COMPLIANCE_CONTROLLER = 'kim-PC';
export const COMPLIANCE_DAYS = 7;
export const COMPLIANCE_WHY_LIMIT = 200;
export const rulesRegistry = JSON.parse(fs.readFileSync(new URL('../rules-registry.json', import.meta.url), 'utf8'));
export const measuredRules = rulesRegistry.rules.filter(rule =>
  rule.validation?.status === 'validated' && rule.detect?.mode !== 'delegated');
const modes = new Set(['off', 'warn', 'block']);

// Whitelist fields: examples/session excerpts and enforcement reasons stay on the source PC.
export function buildRuleComplianceMail({ pc, at, days, rulesHead, rules, enforcement = {} }) {
  const counts = {}, enforcementModes = {};
  for (const rule of rulesRegistry.rules) {
    const row = rules?.[rule.id];
    if (!row || rule.detect?.mode === 'delegated') continue;
    const applicable = row.applicable;
    const violation = row.violation;
    const unmeasured = row.unmeasured ?? 0;
    if (![applicable, violation, unmeasured].every(n => Number.isSafeInteger(n) && n >= 0)
        || violation > applicable || unmeasured > applicable) throw new Error('invalid compliance counts');
    const rawMode = enforcement[rule.id]?.mode ?? enforcement[rule.id] ?? row.mode ?? 'off';
    const mode = modes.has(rawMode) ? rawMode : 'off';
    counts[rule.id] = { applicable, violation, rate: applicable ? violation / applicable : 0, unmeasured, mode };
    enforcementModes[rule.id] = mode;
  }
  const summaries = rulesRegistry.rules.filter(rule => counts[rule.id]).map(rule => {
    const row = counts[rule.id];
    return `${rule.short || rule.id} ${Math.round(row.rate * 100)}%(${row.violation}/${row.applicable},${row.mode})`;
  });
  return {
    why: `[報告・返信不要]${RULE_COMPLIANCE_TAG} ${pc} ${summaries.join(' ')}`.slice(0, COMPLIANCE_WHY_LIMIT),
    body: JSON.stringify({ kind: 'rule-compliance', pc, at, days, rulesHead, rules: counts, enforcementModes })
  };
}

export function parseRuleComplianceMail(mail) {
  if (!String(mail?.why ?? '').includes(RULE_COMPLIANCE_TAG)) return null;
  try {
    const data = JSON.parse(mail.body);
    if (data?.kind !== 'rule-compliance' || typeof data.pc !== 'string' || !data.pc.trim()
        || !Number.isFinite(Date.parse(data.at)) || !Number.isFinite(data.days) || data.days <= 0
        || typeof data.rulesHead !== 'string' || !data.rules || typeof data.rules !== 'object'
        || Array.isArray(data.rules) || (mail.from && mail.from !== data.pc)) return null;
    // Recompute rates from counts; never trust a stale or inconsistent claimed rate.
    const normalized = buildRuleComplianceMail({ ...data, enforcement: data.enforcementModes });
    const report = JSON.parse(normalized.body);
    if (!Object.keys(report.rules).length) return null;
    return { ...report, ...(mail.id ? { mailId: mail.id } : {}) };
  } catch { return null; }
}

export function latestComplianceByPc(reports) {
  const latest = new Map();
  for (const report of reports) {
    if (!Number.isFinite(Date.parse(report.at))) continue;
    const previous = latest.get(report.pc);
    if (!previous || Date.parse(report.at) >= Date.parse(previous.at)) latest.set(report.pc, report);
  }
  return [...latest.values()];
}
