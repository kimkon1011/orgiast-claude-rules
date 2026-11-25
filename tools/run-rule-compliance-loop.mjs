import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAudit } from './rule-compliance-loop.mjs';
import { isEntry } from './is-entry.mjs';

// rule-compliance-loop.mjs 自体には定期実行の口が無い(手動 --apply のみ)。
// これが「未配線」の実体だった — スケジューラから叩く薄いラッパー。
// 出力は rule-compliance-report.mjs(SessionStart hook) と
// cron-liveness-check.mjs が読む2ファイルに固定する。

function processEscalation(home, currentSummary) {
  const claudeDir = path.join(home, '.claude');
  const historyFile = path.join(claudeDir, 'compliance-history.json');
  const escalationFile = path.join(claudeDir, 'compliance-escalation.json');
  const today = new Date().toISOString().slice(0, 10);

  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch {}
  if (!Array.isArray(history)) history = [];

  const entry = { date: today, ts: new Date().toISOString(), rules: currentSummary };
  const existingIdx = history.findIndex(h => h.date === today);
  if (existingIdx >= 0) history[existingIdx] = entry;
  else history.push(entry);

  while (history.length > 60) history.shift();
  try { fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n'); } catch {}

  let escalation = { strongUserPromptSubmit: false, consecutiveUnimprovedWeeks: 0, lastNotifiedAt: null };
  try { escalation = { ...escalation, ...JSON.parse(fs.readFileSync(escalationFile, 'utf8')) }; } catch {}

  if (history.length >= 2) {
    const prev = history.slice(-8, -1)[0] || history[0];
    const currentHq = currentSummary['handoff-quality-only'] || currentSummary['handoff-quality'];
    const prevHq = prev.rules?.['handoff-quality-only'] || prev.rules?.['handoff-quality'];

    if (currentHq && prevHq && currentHq.applicable > 0) {
      if (currentHq.rate >= prevHq.rate && currentHq.rate > 0) {
        escalation.strongUserPromptSubmit = true;
        const daysTracked = (new Date(entry.ts).getTime() - new Date(history[0].ts).getTime()) / 864e5;
        const weeks = Math.floor(daysTracked / 7);
        escalation.consecutiveUnimprovedWeeks = weeks;

        if (weeks >= 3) {
          const now = Date.now();
          const lastNotified = escalation.lastNotifiedAt ? Date.parse(escalation.lastNotifiedAt) : 0;
          if (now - lastNotified >= 7 * 864e5) {
            const notifyScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify-kim.mjs');
            const msg = `[対策効力なし警告] handoff-quality 違反率が${weeks}週連続で改善していません (現在: ${(currentHq.rate * 100).toFixed(1)}%)。対策の見直しが必要です。`;
            spawnSync(process.execPath, [notifyScript, msg], { windowsHide: true, env: process.env });
            escalation.lastNotifiedAt = new Date(now).toISOString();
          }
        }
      } else {
        escalation.strongUserPromptSubmit = false;
        escalation.consecutiveUnimprovedWeeks = 0;
      }
    }
  }

  try { fs.writeFileSync(escalationFile, JSON.stringify(escalation, null, 2) + '\n'); } catch {}
}

export function runAndPersist({ home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir(), days = 7 } = {}) {
  const result = runAudit({ home, days, apply: true, dryRun: false });
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const summary = {};
  for (const [ruleId, r] of Object.entries(result.results || {})) {
    summary[ruleId] = {
      applicable: r.applicable || 0,
      violation: r.violation || 0,
      rate: r.applicable ? (r.violation / r.applicable) : 0
    };
  }

  processEscalation(home, summary);

  fs.writeFileSync(path.join(claudeDir, 'rule-compliance.md'), result.report);
  fs.writeFileSync(
    path.join(claudeDir, 'rule-compliance-state.json'),
    JSON.stringify({ lastRunAt: new Date().toISOString(), days, summary }, null, 2) + '\n',
  );
  return result;
}

if (isEntry(import.meta.url)) {
  const i = process.argv.indexOf('--days');
  const eq = process.argv.find((x) => x.startsWith('--days='));
  const days = Number(eq?.split('=')[1] || (i >= 0 ? process.argv[i + 1] : 7)) || 7;
  const result = runAndPersist({ days });
  process.stdout.write(result.report);
}
