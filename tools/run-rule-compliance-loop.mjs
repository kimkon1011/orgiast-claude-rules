import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAudit } from './rule-compliance-loop.mjs';
import { isEntry } from './is-entry.mjs';

// rule-compliance-loop.mjs 自体には定期実行の口が無い(手動 --apply のみ)。
// これが「未配線」の実体だった — スケジューラから叩く薄いラッパー。
// 出力は rule-compliance-report.mjs(SessionStart hook) と
// cron-liveness-check.mjs が読む2ファイルに固定する。
export function runAndPersist({ home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir(), days = 7 } = {}) {
  const result = runAudit({ home, days, apply: true, dryRun: false });
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'rule-compliance.md'), result.report);
  fs.writeFileSync(
    path.join(claudeDir, 'rule-compliance-state.json'),
    JSON.stringify({ lastRunAt: new Date().toISOString(), days }, null, 2) + '\n',
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
