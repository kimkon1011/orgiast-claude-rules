import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact, cell, parseEnv } from '../../fraud-audit.mjs';
export { cell, parseEnv };
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DAY = 86400000;
export const USERS = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp', 'cr@orgiast.jp'];
export const UNAVAILABLE_USERS = ['satou@orgiast.jp', 'eigyou@orgiast.jp', 'keiri2@orgiast.jp'];
export const SEVERITIES = ['high', 'medium', 'info'];
export const dateOnly = value => new Date(+new Date(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
export function safeText(value, secrets = []) {
  return redact(String(value ?? ''), secrets)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[DB REDACTED]')
    .replace(/Bearer\s+[^\s"'<>]+/gi, '[AUTH REDACTED]')
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{15,}/g, '[KEY REDACTED]');
}
export const maskNumbers = value => String(value ?? '').replace(/\d{7,}/g, n => `****${n.slice(-4)}`);
export function scrub(value, secrets = []) {
  if (Array.isArray(value)) return value.map(v => scrub(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([k]) => !/^(private_key|access_token|refresh_token|client_secret|body|snippet)$/i.test(k))
    .map(([k, v]) => [k, /^(account_number)$/i.test(k) ? (v ? `****${String(v).slice(-4)}` : '') : scrub(v, secrets)]));
  return typeof value === 'string' ? safeText(value, secrets) : value;
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error('JSON ファイルを読み込めません'); }
}
export async function writePrivate(file, value, secrets = []) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('出力先 symlink は使用できません'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const content = typeof value === 'string' ? safeText(value, secrets) : JSON.stringify(scrub(value, secrets), null, 2) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}
export function reason(error) {
  if (/unauthorized_client/.test(error?.message)) return 'unauthorized_client（DWD スコープ未付与）';
  return safeText(error?.auditReason || (Number.isInteger(error?.status) ? `HTTP ${error.status}` : '') || (error?.code ? `接続失敗 (${error.code})` : error?.name === 'TimeoutError' ? 'タイムアウト' : `取得失敗 (${error?.name || 'Error'})（接続・資格情報・API 応答を確認）`));
}
export function auditError(message) { return Object.assign(new Error(message), { auditReason: message }); }
export async function getJson(url, { headers = {}, fetchImpl = fetch, signal, retries = 5, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      let retry = Number(response.headers?.get('retry-after')) * 1000;
      if (response.status === 429) { const body = await response.json().catch(() => ({})); retry = Math.max(retry || 0, Number(body.retry_after || 0) * 1000); }
      const wait = Math.max(1000 * 2 ** attempt, retry || 0);
      if (wait > 120000) throw auditError('レート制限: 再試行待機が120秒を超過');
      await sleep(wait); signal?.throwIfAborted(); continue;
    }
    throw Object.assign(auditError(`HTTP ${response.status}`), { status: response.status });
  }
}
export async function mapLimit(rows, limit, fn) {
  const out = new Array(rows.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    for (;;) { const i = next++; if (i >= rows.length) break; out[i] = await fn(rows[i], i); }
  })); return out;
}
export function runProcess(command, args, { timeout = 120000, env = process.env, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', over = false;
    const timer = setTimeout(() => { over = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', b => { output += b; if (output.length > 2_000_000) { over = true; child.kill('SIGKILL'); } });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(auditError('子プロセスを起動できません')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !over ? resolve(output) : reject(auditError(over ? '子プロセス タイムアウト/出力上限' : `子プロセス終了コード ${code}`)); });
  });
}
export function parseModelJson(text) {
  const start = text.search(/[\[{]/);
  if (start < 0) throw new SyntaxError('JSON start missing');
  const stack = [];
  let quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '[' || c === '{') stack.push(c === '[' ? ']' : '}');
    else if (c === ']' || c === '}') {
      if (stack.pop() !== c) throw new SyntaxError('JSON brackets mismatch');
      if (!stack.length) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new SyntaxError('JSON incomplete');
}
export const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)/g, '').replace(/[\s\p{P}\p{S}ーｰ]+/gu, '');
