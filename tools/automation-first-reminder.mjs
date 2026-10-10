#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export const additionalContext = '[AUTOMATION-FIRST] user 依頼(手作業/設定/コピペ/UI操作)の前に必ず順に試す: (1) MCP/CLI で取得 (2) keyserve（tools/keyserve-status.mjs / tools/env-kv.mjs）から取得 (3) production bundle から公開設定値を確認 (4) 自動設定は専用ツール経由のみ（tools/env-kv.mjs など） (5) 全部不可の時のみ理由明示で user 依頼(例外: OAuth初回同意/支払い/アカウント作成/物理操作のみ)。0ステップが原則、準備は全部Claude側で済ませる。ID/設定値も対象。classifier 拒否はカテゴリを1行報告し、言い換え再試行しない。拒否は操作単位。一括拒否から個別不可を推定せず、手渡し前に最小単位で1回試す。';

export function getComplianceContext(home = process.env.ORGIAST_HOME || os.homedir()) {
  const claudeDir = path.join(home, '.claude');
  const stateFile = path.join(claudeDir, 'rule-compliance-state.json');
  const escalationFile = path.join(claudeDir, 'compliance-escalation.json');

  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  let escalation = {};
  try { escalation = JSON.parse(fs.readFileSync(escalationFile, 'utf8')); } catch {}

  const summary = state.summary || {};
  const hq = summary['handoff-quality-only'] || summary['handoff-quality'] || { applicable: 17, violation: 17, rate: 1.0 };
  const vbd = summary['verify-before-done'] || { applicable: 48, violation: 15, rate: 0.3125 };

  const hqRateText = hq.applicable ? `${(hq.rate * 100).toFixed(1)}%` : '—';
  const vbdRateText = vbd.applicable ? `${(vbd.rate * 100).toFixed(1)}%` : '—';

  let text = `[遵守状況] 直近7日: handoff-quality 違反 ${hq.violation}/${hq.applicable} (${hqRateText}) / verify-before-done ${vbd.violation}/${vbd.applicable} (${vbdRateText})\n→ 手渡しを書く前に、対象システムへ実アクセスして失敗を確認したか。調査は中身を開くまでやったか。`;

  if (escalation.strongUserPromptSubmit) {
    text = `🚨 [遵守緊急警告] 直近7日の handoff-quality 違反率は ${hqRateText} です (目標: 0%)\n手渡しを書く前に、対象システムへ実アクセスして失敗を確認し、エラー本文を証拠として貼ること！\n` + text;
  }

  return text;
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    JSON.parse(raw);
    const compliance = getComplianceContext();
    const combined = `${compliance}\n\n${additionalContext}`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: combined } }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
