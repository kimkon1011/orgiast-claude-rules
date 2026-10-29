import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { quotaFailure } from './lane-real-health.mjs';

export const REPAIR_TTL = 6 * 3600_000;
export function repairable(state) {
  return state?.alive === false && !/^(?:billing|quota_wait|cooldown|demoted|missing_key|cli_missing)$/.test(state.reason || '')
    && !quotaFailure(state.reason)
    && /real_fail_rate|probe_failed|auth|oauth|login|spawn|ENOENT|launch|execution_unavailable|wsl|native|physical_operation/i.test(state.reason || '');
}
export function faultId(lane, state) {
  const error = String(state?.error || '').replace(/\(\d+\)/g, '').replace(/\d{4}-\d\d-\d\dT\S+/g, '').trim();
  return createHash('sha256').update(`${lane}\0${state?.reason}\0${error}`).digest('hex').slice(0, 24);
}
export function repairRows(home) {
  let raw;
  try { raw = fs.readFileSync(path.join(home, '.claude/lane-repair-log.jsonl'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export function pendingRepairs(health, home, now = Date.now()) {
  const rows = repairRows(home);
  return Object.entries(health?.lanes || {}).filter(([lane, state]) => lane !== 'gemini-cli' && repairable(state)
    && !rows.some(r => r.lane === lane && r.faultId === faultId(lane, state) && r.tried?.trim()
      && ['fixed', 'unfixable'].includes(r.result) && Date.parse(r.ts) <= now && Date.parse(r.ts) > now - REPAIR_TTL))
    .map(([lane, state]) => ({ lane, ...state }));
}
export function repairContext(health, home, now) {
  const pending = pendingRepairs(health, home, now);
  const quota = Object.entries(health.lanes).filter(([, s]) => s.reason === 'quota_wait').map(([p]) => p);
  const alternatives = Object.entries(health.lanes).filter(([p, s]) => p !== 'gemini-cli' && s.alive).map(([p]) => p);
  return [pending.length ? `本セッションの最初の作業はレーン修復: ${pending.map(s => `${s.lane}(${s.reason})`).join(', ')}。node tools/lane-doctor.mjs --probe。Codex の probe 失敗は直接 wsl codex exec の終了コードでも切り分ける。試行後 node tools/lane-repair-log.mjs --lane <名> --tried "<試した手段>" --result fixed|unfixable（6時間有効）。` : '',
    ...Object.entries(health.lanes).filter(([, s]) => s.reason === 'billing').map(([p]) => `${p}: 残高不足。代替の安いレーン（例: OpenRouter 経由）へ回す`),
    quota.length ? `quota_wait: ${quota.join(', ')}。代替の安いレーン: ${alternatives.join(', ') || 'なし（lane-doctor --probe で確認）'}` : ''].filter(Boolean).join(' / ');
}
