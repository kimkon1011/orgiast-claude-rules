#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { affirmativeMarker } from './lib/claude-approval.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export { implApproved, billingApproved } from './lib/claude-approval.mjs';
export const GATE_CONTRACT = {"name": "claude-impl-approval", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "claude-impl-approval"}]};
export function issueApprovals(input, home, now = Date.now()) {
  if (!input.session_id || (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit')) return [];
  const messages = [];
  for (const [file, markers] of [['claude-impl-allow.json', ['[CLAUDE-IMPL-OK]', '[LANE-OK]']], ['claude-billing-allow.json', ['[API-BILLING-OK]']]]) {
    const marker = markers.find(m => affirmativeMarker(input.prompt, m));
    if (!marker) continue;
    const until = new Date(now + 3600000).toISOString();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', file), JSON.stringify({ sessionId: input.session_id, until, marker }) + '\n', { mode: 0o600 });
    messages.push(`許可を発行: ${marker} まで ${until}`);
  }
  return messages;
}
if (isEntry(import.meta.url)) {
  try {
    const raw = await readStdinWithTimeout();
    if (raw) {
      const messages = issueApprovals(JSON.parse(raw.replace(/^\uFEFF/, '')), process.env.ORGIAST_HOME || os.homedir());
      if (messages.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: messages.join('\n') } }));
    }
  } catch {}
}
