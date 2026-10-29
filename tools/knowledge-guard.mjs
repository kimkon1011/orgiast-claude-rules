#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"knowledge-guard","remedies":[{"kind":"repo-file","ref":"docs/knowledge-lock-design.md","section":"6. 移管（HANDOVER.md）方針"}]};
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { main as knowledgeLock, verifyVerdict } from './knowledge-lock.mjs';
import { requireKeyservePcId } from './keyserve-auth.mjs';
import { loadLedger, isContractedLocal } from './claude-account-ledger.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
};
const normalize = value => path.posix.normalize(String(value).replaceAll('\\', '/')).toLowerCase().replace(/\/$/, '');
function absolute(value, home, cwd) {
  let text = String(value).replaceAll('\\', '/');
  if (text === '~' || text.startsWith('~/')) text = home + text.slice(1);
  if (!/^(?:\/|[a-z]:\/)/i.test(text)) text = `${cwd}/${text}`;
  return normalize(text);
}
function protectedPath(value, home, cwd) {
  const p = absolute(value, home, cwd), base = `${normalize(home)}/.claude`;
  if (/\.lock$/i.test(p)) return false;
  return /(?:^|\/)handover\.md$/.test(p) || p === `${base}/projects` || p.startsWith(`${base}/projects/`)
    || p === `${base}/shared-memory` || p.startsWith(`${base}/shared-memory/`)
    || (p.startsWith(`${base}/`) && /^(?:next-session[^/]*\.md|handoff[^/]*(?:\/.*)?)$/.test(p.slice(base.length + 1)));
}
export function protectedTarget(event, home = os.homedir()) {
  const input = event.tool_input || {}, cwd = event.cwd || home;
  if (/^(Bash|PowerShell)$/.test(event.tool_name)) {
    const command = String(input.command || '');
    // Remove only concrete encrypted filenames, not wildcard expressions that could include plaintext.
    const remaining = command.replace(/[^\s'"`;|&<>]*\.lock(?=[\s'"`;|&<>]|$)/gi, token => /[*?]/.test(token) ? token : '');
    return /\.claude[\\/]projects|shared-memory|next-session|handover\.md|\.jsonl|\.claude[\\/]handoff/i.test(remaining) ? command : null;
  }
  if (/^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(event.tool_name)) {
    const file = input.file_path || input.notebook_path || '';
    return file && protectedPath(file, home, cwd) ? file : null;
  }
  if (/^(Grep|Glob)$/.test(event.tool_name)) {
    const base = input.path || cwd;
    const filter = String(input.glob || (event.tool_name === 'Glob' ? input.pattern : '') || '');
    if (/\.lock$/i.test(filter)) return null;
    if (protectedPath(base, home, cwd) || protectedPath(`${base}/${filter}`, home, cwd)) return `${base}/${filter}`;
    const resolved = absolute(base, home, cwd), claude = `${normalize(home)}/.claude`;
    // Searches rooted above protected trees may traverse them. No directory walk on the hot path.
    if (claude === resolved || claude.startsWith(`${resolved}/`) || resolved === '') return `${base}/${filter}`;
    if (/shared-memory|next-session|handover|\.jsonl|\.claude[\\/]projects/i.test(`${input.pattern || ''} ${filter}`)) return `${base}/${filter}`;
    // Unrestricted recursive searches can read HANDOVER.md in any repository.
    if (!filter || /[*?]/.test(filter) && /(?:md|\*\.?\*)$/i.test(filter)) return `${base}/${filter}`;
  }
  return null;
}
function context(deps) {
  return { ...deps, home: deps.home || os.homedir(), toolsDir: deps.toolsDir || toolsDir,
    env: deps.env || process.env, now: deps.now || Date.now, spawn: deps.spawn || spawn };
}
const denial = (email, reason) => ['account-unavailable', 'hook-error'].includes(reason)
  ? `アカウントを確認できないため（keyserve 不通など）、Claude の蓄積の読み出しを保留しています。接続・ログイン状態を確認してください。`
  : `このアカウント(${email})はオージャスト契約外のため、Claude の蓄積（memory・会話ログ・引き継ぎ書）は読めません。必要なら kim の承認経路: node tools/knowledge-lock.mjs open <封印ファイル>`;
export async function accountDecision(deps = {}) {
  const ctx = context(deps);
  const pubFile = path.join(ctx.toolsDir, 'knowledge-lock-pubkey.pem');
  if (!fs.existsSync(pubFile)) return { allow: true, email: '', reason: 'disabled' };
  const email = read(path.join(ctx.home, '.claude.json'))?.oauthAccount?.emailAddress || '';
  const result = (allow, reason, outside = false) => ({ allow, email, reason, outside });
  const pem = fs.readFileSync(pubFile, 'utf8');
  const cacheFile = path.join(ctx.home, '.claude/state/knowledge-verdict.json');
  const cached = read(cacheFile);
  let pc;
  try { pc = requireKeyservePcId(ctx.home, ctx.env); } catch { /* local fallback still available */ }
  const valid = (value, allowExpired = false) => !!email && !!pc && value?.verdict?.email === email
    && verifyVerdict(value.verdict, value.sig, pem, pc, ctx.now(), { allowExpired });
  const decide = value => result(value.verdict.contracted, value.verdict.reason, !value.verdict.contracted);
  if (valid(cached) && cached.verdict.reason !== 'profile_unavailable') return decide(cached);
  // Same process, same verifier and cache writer as the CLI. Never emit CLI output into hook context.
  const code = await knowledgeLock(['verify-account', '--json'], { ...ctx, timeoutMs: 4000, stdout: () => {}, stderr: () => {} });
  const refreshed = read(cacheFile);
  if ((code === 0 || code === 4) && valid(refreshed) && refreshed.verdict.reason !== 'profile_unavailable') return decide(refreshed);
  if (valid(cached, true) && cached.verdict.contracted && cached.verdict.reason !== 'profile_unavailable'
      && ctx.now() / 1000 - cached.verdict.iat <= 7 * 86400) {
    // profile_unavailable must not erase the last known signed contract during an outage.
    if (code === 5 && refreshed?.verdict?.reason === 'profile_unavailable') save(cacheFile, cached);
    return result(true, 'signed-cache-fallback');
  }
  try {
    if (isContractedLocal(email, loadLedger(path.join(ctx.toolsDir, 'claude-account-ledger.json')))) return result(true, 'local-fallback');
  } catch { /* no trustworthy local ledger */ }
  return result(false, 'account-unavailable');
}
function log(ctx, decision, tool, target) {
  const file = path.join(ctx.home, '.claude/logs/knowledge-guard.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date(ctx.now()).toISOString(), decision: decision.allow ? 'allow' : 'deny',
    reason: decision.reason, email: decision.email, tool, pathHash: crypto.createHash('sha256').update(target).digest('hex') })}\n`, { mode: 0o600 });
}
export async function runHook(event, deps = {}) {
  const ctx = context(deps);
  const target = protectedTarget(event, ctx.home);
  if (target === null) return { allow: true, reason: 'unprotected' };
  let decision;
  try { decision = await accountDecision(ctx); log(ctx, decision, event.tool_name, target); }
  catch {
    decision = { allow: false, email: read(path.join(ctx.home, '.claude.json'))?.oauthAccount?.emailAddress || '', reason: 'hook-error' };
    try { log(ctx, decision, event.tool_name, target); } catch {}
  }
  if (!decision.allow) (deps.stdout || (text => process.stdout.write(text)))(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denial(decision.email, decision.reason),
  } }) + '\n');
  return decision;
}
export async function sessionStart(deps = {}) {
  const ctx = context(deps);
  try {
    const decision = await accountDecision(ctx);
    log(ctx, decision, 'SessionStart', '');
    if (!decision.outside) return;
    const file = path.join(ctx.home, '.claude/state/knowledge-guard-notified.json');
    const day = new Date(ctx.now()).toLocaleDateString('en-CA');
    const previous = read(file);
    if (previous?.day === day) return;
    // Claim synchronously before spawning, so overlapping starts do not send duplicates.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch { return; }
    try {
      if (read(file)?.day === day) return;
      save(file, { day, email: decision.email });
      const message = `契約外 Claude アカウントの起動を検知: PC=${os.hostname()} アカウント=${decision.email} 理由=${decision.reason}。蓄積の読み出しはフックで拒否中`;
      let child;
      try { child = ctx.spawn(process.execPath, [path.join(ctx.toolsDir, 'notify-kim.mjs'), message], { stdio: 'ignore', windowsHide: true, detached: true }); }
      catch { fs.unlinkSync(file); return; }
      child.on('error', () => { try { fs.unlinkSync(file); } catch {} });
      child.unref?.();
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  } catch { /* SessionStart must never pollute context, including notification failures. */ }
}
export async function runRawHook(raw, deps = {}) {
  try {
    const event = JSON.parse(raw);
    if (!event || typeof event !== 'object') throw new Error('invalid event');
    return await runHook(event, deps);
  } catch {
    const ctx = context(deps);
    if (!fs.existsSync(path.join(ctx.toolsDir, 'knowledge-lock-pubkey.pem'))
        || !protectedTarget({ tool_name: 'Bash', tool_input: { command: String(raw).replaceAll('\\\\', '\\') } }, ctx.home)) {
      return { allow: true, reason: 'unprotected-input' };
    }
    (deps.stdout || (text => process.stdout.write(text)))(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: denial('', 'hook-error'),
    } }) + '\n');
    return { allow: false, reason: 'hook-error' };
  }
}
if (isEntry(import.meta.url)) {
  if (process.argv.includes('--session-start')) await sessionStart();
  else await runRawHook(await readStdinWithTimeout(500));
}
