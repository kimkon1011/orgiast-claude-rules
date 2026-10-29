import path from 'node:path';
import { repairable, faultId, REPAIR_TTL } from './lane-repair-state.mjs';
import { quotaFailure } from './lane-real-health.mjs';
import { redactAll } from './redact.mjs';

const contentText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(contentText).join('\n') : c?.text || '';
const jsonObjects = text => String(text).split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const laneFor = command => command.match(/--(?:provider|lane)(?:=|\s+)["']?([\w-]+)/)?.[1] || (/codex-do\.mjs/.test(command) ? 'codex' : 'unknown');

// Only real tool results can introduce failures or acknowledge repair records.
// User prose, test descriptions, source code and failed logging commands cannot.
export function detectLaneRepair(session, repairLog = []) {
  const uses = new Map(), pending = new Map(), observations = [];
  const observed = (lane, wrapped, state) => pending.set(lane, { wrapped, state });
  for (const wrapped of session.events) {
    const event = wrapped.event || wrapped;
    const role = event.message?.role || event.type;
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const use = uses.get(block.tool_use_id);
        if (!use) continue;
        const command = String(use.input?.command || use.input?.script || '');
        const output = contentText(block.content);
        if (/^(?:Bash|PowerShell)$/.test(use.name) && /(?:^|[\\/\s"'])lane-repair-log\.mjs\b/.test(command) && !block.is_error) {
          for (const row of jsonObjects(output)) {
            if (row.lane && row.tried?.trim() && ['fixed', 'unfixable'].includes(row.result)) {
              repairLog = [...repairLog, row];
            }
          }
        }
        if ((use.name === 'Read' && /(?:^|[\\/])lane-health\.json$/.test(use.input?.file_path || ''))
          || /^(?:Bash|PowerShell)$/.test(use.name) && /lane-doctor\.mjs\b|(?:cat|Get-Content)\s+[^\n]*lane-health\.json/.test(command)) {
          for (const health of jsonObjects(output)) for (const [lane, state] of Object.entries(health.lanes || {})) {
            if (lane !== 'gemini-cli' && repairable(state)) observed(lane, wrapped, state);
            else if (state.alive) pending.delete(lane);
          }
        }
        if (/^(?:Bash|PowerShell)$/.test(use.name) && /(?:codex-do|llm-ask)\.mjs\b/.test(command)) {
          const lines = output.split(/\r?\n/).filter(s => !/^(?:# Subtest:|(?:not )?ok\s+\d+\s+-)/.test(s.trim()));
          const failure = lines.find(s => /HTTP\s*[45]\d\d|spawn\s+\S+\s+ENOENT|認証失敗|unauthorized|login required|全候補が失敗|exit code\s*[:=]?\s*[1-9]|WSL ディストリが見つかりません/i.test(s));
          if (failure && !quotaFailure(failure)) observed(laneFor(command), wrapped);
        }
      }
      if (block.type !== 'tool_use' || role !== 'assistant') continue;
      uses.set(block.id, block);
      const at = Date.parse(wrapped.ts || event.timestamp);
      for (const [lane, fault] of pending) {
        if (repairLog.some(r => r.lane === lane && r.tried?.trim() && ['fixed', 'unfixable'].includes(r.result)
          && Date.parse(r.ts) <= at && at - Date.parse(r.ts) < REPAIR_TTL
          && (!fault.state || r.faultId === faultId(lane, fault.state)))) pending.delete(lane);
      }
      if (!pending.size) continue;
      const command = String(block.input?.command || block.input?.script || '');
      const impl = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(block.name);
      const fallback = /^(?:Bash|PowerShell)$/.test(block.name) && /(?:codex-do|llm-ask)\.mjs\b/.test(command)
        && !pending.has(laneFor(command)) && !/\[LANE-REPAIR\]/.test(contentText(event.message?.content));
      if (impl || fallback) observations.push({ violation: true, ts: wrapped.ts, excerpt: redactAll(`${[...pending.keys()].join(', ')} 未修復: ${block.name} ${impl ? path.basename(block.input?.file_path || block.input?.notebook_path || '') : command}`).slice(0, 200) });
    }
    // A prose fallback without a repair marker is also observable abandonment.
    if (role === 'assistant' && pending.size) {
      const text = contentText(event.message?.content);
      if (!/\[LANE-REPAIR\]/.test(text) && /(?:代替|別のレーン|別レーン|fallback)[^。\n]{0,30}(?:回す|回し|切り替|切替|へ)|\[LANE-FALLBACK\]/i.test(text)) observations.push({ violation: true, ts: wrapped.ts, excerpt: redactAll(text).slice(0, 200) });
    }
  }
  return { applicable: pending.size > 0 || observations.length > 0 || uses.size > 0 && session.events.some(w => /lane-doctor|llm-ask|codex-do|lane-health/.test(w.raw || JSON.stringify(w.event || w))), observations };
}
