import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

export function codexAuthStatus(home) {
  const tokens = readJson(path.join(home, '.codex', 'auth.json'))?.tokens;
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
