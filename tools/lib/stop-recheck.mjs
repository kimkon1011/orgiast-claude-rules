import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Existing runner contract: initial block plus two rewritten responses.
export const MAX_BLOCKS_PER_TURN = 2;
export const CAP_CONTEXT = 'Stop ゲートの同一ターン上限に達したため今回は送信します。残った違反を次の応答で必ず訂正してください。';

const defaultHome = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir();
const digest = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);

function lastUserFingerprint(file) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    let legacyFingerprint = '';
    // promptId stays shared by the human message, tool results and Stop feedback.
    for (let index = rows.length - 1; index >= 0; index--) {
      let row; try { row = JSON.parse(rows[index]); } catch { continue; }
      if (row?.promptId) return `promptId:${digest(row.promptId)}`;
      // Older transcripts use the last real user message, skipping hook/tool rows.
      if (legacyFingerprint || (row?.type !== 'user' && row?.message?.role !== 'user')) continue;
      const content = row.message?.content ?? row.content;
      if (row.isMeta === true) continue;
      if (Array.isArray(content) && content.length > 0 && content.every(item => item?.type === 'tool_result')) continue;
      if (typeof content === 'string' && content.startsWith('Stop hook feedback')) continue;
      legacyFingerprint = digest(JSON.stringify({ uuid: row.uuid, timestamp: row.timestamp, message: row.message ?? row.content }));
    }
    return legacyFingerprint;
  } catch {}
  return '';
}

export function stopIdentity(input = {}, assistantText = '') {
  const sessionId = input.session_id || input.sessionId || path.basename(input.transcript_path || '', '.jsonl') || 'unknown';
  return { sessionId, turnKey: lastUserFingerprint(input.transcript_path) || `session:${sessionId}`, responseHash: digest(assistantText) };
}

export function stateFile(home = defaultHome()) { return path.join(home, '.claude', 'stop-gate-runner-state.json'); }
export function ledgerFile(home = defaultHome()) { return path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'); }

function readState(home) { try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')); } catch { return {}; } }
function writeState(home, state) {
  const file = stateFile(home); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}
export function appendStopLedger(record, home = defaultHome()) {
  try { const file = ledgerFile(home); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'); } catch {}
}

// Every Stop hook sees the same response. responseHash makes that one block attempt,
// rather than counting each independently registered hook as another retry.
export function registerStopViolation({ input = {}, assistantText = '', reasonCodes = [], blockedBy = [], home = defaultHome() } = {}) {
  const id = stopIdentity(input, assistantText);
  if (id.sessionId === 'unknown') return { ...id, blockNumber: 1, sameTextRetries: 1, retryCap: false, verdict: 'block', reasonCodes, blockedBy };
  const state = readState(home);
  const now = Date.now();
  for (const [key, value] of Object.entries(state)) {
    const stamp = Date.parse(value?.lastTs);
    if (!Number.isFinite(stamp) || stamp < now - 7 * 864e5) delete state[key];
  }
  const prior = state[id.sessionId]?.turnKey === id.turnKey ? state[id.sessionId] : { turnKey: id.turnKey, blocks: 0, responses: {} };
  const signature = [...blockedBy].sort().join(',') || [...reasonCodes].sort().join(',') || 'unknown';
  const response = prior.responses?.[id.responseHash];
  const seenByDifferentHook = response && !response.signatures?.includes(signature);
  const blockNumber = seenByDifferentHook ? response.blockNumber : prior.blocks + 1;
  prior.blocks = Math.max(prior.blocks, blockNumber);
  prior.responses = { ...(prior.responses || {}), [id.responseHash]: {
    blockNumber, signatures: [...new Set([...(response?.signatures || []), signature])],
  } };
  prior.lastHash = id.responseHash; prior.lastTs = new Date(now).toISOString();
  state[id.sessionId] = prior;
  try { writeState(home, state); } catch {}
  const capped = blockNumber > MAX_BLOCKS_PER_TURN;
  return { ...id, blockNumber, sameTextRetries: blockNumber, retryCap: capped, verdict: capped ? 'pass_after_cap' : 'block', reasonCodes, blockedBy, additionalContext: capped ? CAP_CONTEXT : undefined };
}

export function stopGateOutput(result, reason) {
  return result.retryCap ? { systemMessage: `${CAP_CONTEXT} 残存コード: ${result.reasonCodes.join(', ')}` } : { decision: 'block', reason };
}

export function summarizeStopRechecks(rows, { since = 0 } = {}) {
  const recent = rows.filter(row => Date.parse(row.ts) >= since);
  return {
    skippedStopHookActive: recent.filter(row => row.verdict === 'skipped' && row.reasonCodes?.includes('stop_hook_active')).length,
    passAfterCap: recent.filter(row => row.verdict === 'pass_after_cap').length,
  };
}
