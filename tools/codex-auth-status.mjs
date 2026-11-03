import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickDistro } from './lib/codex-wsl-auth-sync.mjs';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

export function codexAuthStatus(home) {
  return authStatus(readJson(path.join(home, '.codex', 'auth.json')));
}

function authStatus(auth) {
  const tokens = auth?.tokens;
  const token = tokens && typeof tokens === 'object' && !Array.isArray(tokens)
    ? tokens.id_token || tokens.access_token : null;
  if (!token) return { login: false, email: null, plan: null };
  let email = null;
  let plan = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const payloadEmail = payload?.email || payload?.['https://api.openai.com/profile']?.email;
    const payloadPlan = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type;
    email = typeof payloadEmail === 'string' && payloadEmail ? payloadEmail : null;
    plan = typeof payloadPlan === 'string' && payloadPlan ? payloadPlan : null;
  } catch {}
  return { login: true, email, plan };
}

export function formatCodexLogin(status, adoptionAuthed) {
  if (status.login === true) {
    return status.email ? `済(${status.email}${status.plan ? '/' + status.plan : ''})` : '済';
  }
  if (adoptionAuthed === true) return '済';
  if (adoptionAuthed === false) return '未';
  return '判定不能';
}

// Read only: never synchronize rotating refresh tokens between Windows and WSL.
export function codexAuthStatusAny(home, { platform = process.platform, spawnImpl = spawnSync } = {}) {
  const local = codexAuthStatus(home);
  if (local.login) return { ...local, source: platform === 'win32' ? 'windows' : null };
  const missing = { ...local, source: null };
  if (platform !== 'win32') return missing;
  try {
    const listed = spawnImpl('wsl', ['-l', '-q'], { encoding: 'utf16le', windowsHide: true, timeout: 15000 });
    const distro = listed?.status === 0 ? pickDistro(listed.stdout) : null;
    if (!distro) return missing;
    const result = spawnImpl('wsl', ['-d', distro, '--', 'sh', '-c', 'cat "$HOME/.codex/auth.json"'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (result?.status !== 0) return missing;
    const status = authStatus(JSON.parse(String(result.stdout).replace(/^\uFEFF/, '')));
    return { ...status, source: status.login ? 'wsl' : null };
  } catch { return missing; }
}
