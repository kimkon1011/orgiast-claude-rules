#!/usr/bin/env node
// Dedicated fleet-mail recipient; only the existing rules-resync operation is executable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DAY, readJson, convergenceAddress } from './fleet-convergence.mjs';
import { parseEnvText } from './env-kv.mjs';
import { createClient, acquireLock } from './fleet-mail.mjs';
import { isEntry } from './is-entry.mjs';
const ownRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function validSyncMail(mail, identity, now) {
  let body; try { body = JSON.parse(mail.body); } catch { return false; }
  return mail.kind === 'note' && mail.from === 'kim-PC' && mail.to === convergenceAddress(identity)
    && Date.parse(mail.expiresAt) > now && body.action === 'rules-resync' && body.version === 1
    && body.hostname === identity.hostname && body.username === identity.username;
}
export function syncInvocation(repo, platform = process.platform) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('unsupported platform');
  return [process.execPath, [path.join(repo, 'tools/onboarding-sync.mjs'), '--force']];
}
export async function receiveConvergence({ home = process.env.ORGIAST_HOME || os.homedir(), repo = ownRepo,
  identity = { hostname: os.hostname(), username: os.userInfo().username }, now = Date.now(), request, run = spawnSync } = {}) {
  const dir = path.join(home, '.claude');
  if (!request) {
    let config; try { config = parseEnvText(fs.readFileSync(path.join(dir, 'fleet-sheet.env'), 'utf8')); } catch { return { skipped: 'no-transport' }; }
    if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) return { skipped: 'no-transport' };
    request = createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN });
  }
  const release = acquireLock(path.join(dir, '.fleet-convergence-sync.lock'));
  if (!release) return { skipped: 'locked' };
  const file = path.join(dir, '.fleet-convergence-sync.json');
  const state = readJson(file);
  const save = () => fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  try {
    const address = convergenceAddress(identity);
    state.requestId ||= randomUUID(); save();
    const data = await request('mail-poll', { to: address, hostname: address, requestId: state.requestId });
    state.pending ||= [];
    for (const mail of data.messages) if (!state.pending.some(m => m.id === mail.id)) state.pending.push(mail);
    delete state.requestId; save();
    let executed = 0;
    for (const mail of [...state.pending]) {
      if (!validSyncMail(mail, identity, now)) {
        await request('mail-reply', { id: mail.id, from: address, resultBody: '固定再同期指示の検証不一致・期限切れ。実行なし。' });
      } else {
        if (!mail.result) {
          if (state.lastAttempt && now - state.lastAttempt < DAY) break;
          state.lastAttempt = now; save(); // crash cannot cause an immediate repeat
          const [exe, args] = syncInvocation(repo);
          const result = run(exe, args, { encoding: 'utf8', timeout: 300000, windowsHide: true,
            env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo }, stdio: ['ignore', 'pipe', 'pipe'] });
          mail.result = `rules-resync 実行 exit=${result.status ?? '未確認'}。収束成功はシートの次回レポートで判定。`;
          save(); executed++;
        }
        await request('mail-reply', { id: mail.id, from: address, resultBody: mail.result });
      }
      state.pending = state.pending.filter(m => m.id !== mail.id); save();
    }
    return { executed, pending: state.pending.length };
  } finally { release(); }
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await receiveConvergence())); }
  catch { console.error('fleet-convergence-sync failed (secrets omitted)'); process.exitCode = 1; }
}
