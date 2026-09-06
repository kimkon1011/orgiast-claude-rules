import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { collectUserEffortKpi, summarizeUserEffortKpi } from './user-effort-kpi.mjs';
const h = process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
try { const s = fs.readFileSync(path.join(h, '.claude', 'rule-compliance.md'), 'utf8'); if (s.trim()) process.stdout.write(s); } catch {}
try {
  const summary = summarizeUserEffortKpi(collectUserEffortKpi({ home: h }));
  process.stdout.write(`\n${summary}\n`);
} catch (error) {
  // SessionStart の本体レポートを KPI 取得失敗で消さないため、警告だけに留める。
  console.error(`[user effort KPI] 集計失敗: ${error.message}`);
}
