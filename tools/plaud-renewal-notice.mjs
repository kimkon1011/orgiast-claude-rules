#!/usr/bin/env node
// SessionStart: refresh first, then show only today's recorded automatic failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { failureToday, PREVENT_DAYS } from './plaud-reauth-auto.mjs';
import { renewalMessage } from './plaud-to-tldv.mjs';
import { isEntry } from './is-entry.mjs';

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export function maintenanceNotice({ home = process.env.ORGIAST_HOME || os.homedir(), now, runAuto } = {}) {
  const clock = () => now ?? Date.now();
  const dir = path.join(home, '.claude');
  const stateFile = path.join(dir, 'plaud-to-tldv-state.json');
  if (!fs.existsSync(stateFile)) return '';
  const session = () => read(stateFile).session || {};
  const remaining = () => (Number(session().urtExp || 0) * 1000 - clock()) / 86400000;
  const notice = path.join(dir, 'plaud-renewal-needed.md');
  const clear = () => { try { fs.unlinkSync(notice); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  if (session().urt && remaining() > PREVENT_DAYS) { clear(); return ''; }
  const execute = runAuto || (() => spawnSync(process.execPath,
    [fileURLToPath(new URL('./plaud-reauth-auto.mjs', import.meta.url)), '--if-needed'],
    { env: { ...process.env, ORGIAST_HOME: home }, encoding: 'utf8', timeout: 280000, windowsHide: true }));
  execute();
  // Never replay stale markdown, including when the child is busy or was killed.
  if (session().urt && remaining() > PREVENT_DAYS) { clear(); return ''; }
  const failure = failureToday(read(path.join(dir, 'plaud-reauth-state.json')), clock());
  if (!failure) { clear(); return ''; }
  const days = remaining();
  const message = renewalMessage(days > 0 ? 'warning' : 'expired', Math.floor(days), failure);
  fs.writeFileSync(notice, message + '\n', 'utf8');
  return message;
}
if (isEntry(import.meta.url)) {
  try {
    const body = maintenanceNotice();
    if (body) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
      `【Plaud→tl;dv の保守通知】以下をセッション内で user に伝えること。Discord DM は送らない。\n${body}` } }));
  } catch (error) { console.error(`Plaud 保守処理失敗: ${error.message}`); process.exitCode = 1; }
}
