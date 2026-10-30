import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export function run(command, args = [], input, options = {}) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  // Never include subprocess output/arguments: they can contain credentials or SQL.
  if (result.error || result.status !== 0) throw new Error(`command failed: ${path.basename(command)} (exit ${result.status ?? 'spawn'})`);
  return result.stdout;
}
export function atomic(file, content, mode = 0o600) {
  // Public desktop/policy files need traversable directories for employee sessions.
  // Secret files retain private parents; never relax an existing directory.
  const directoryMode = mode & 0o044 ? 0o755 : 0o700;
  const missing = [];
  for (let dir = path.dirname(file); !fs.existsSync(dir); dir = path.dirname(dir)) missing.push(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: directoryMode });
  for (const dir of missing) fs.chmodSync(dir, directoryMode); // provisioning uses umask 077
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode, flag: 'wx' });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export const columns = ['username', 'display_name', 'email', 'role'];
export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',' || c === '\n') {
      row.push(field); field = ''; closed = false;
      if (c === '\n') { rows.push(row); row = []; }
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('invalid CSV quoting'); field += c; }
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (field || row.length || closed) rows.push([...row, field]);
  if (JSON.stringify(rows.shift()) !== JSON.stringify(columns)) throw new Error('CSV header mismatch');
  const names = new Set(), emails = new Set();
  return rows.map((r, i) => {
    if (r.length !== 4 || r.some(v => !v || /[\r\n\x00-\x1f\x7f]/.test(v))) throw new Error(`invalid CSV row ${i + 2}`);
    const user = Object.fromEntries(columns.map((c, j) => [c, r[j]]));
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(user.username) || /^(root|r640admin|guacadmin|postgres|daemon|nobody|ubuntu)$/.test(user.username)) throw new Error(`invalid username at row ${i + 2}`);
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(user.email) || !['employee', 'manager'].includes(user.role) || /:/.test(user.display_name)) throw new Error(`invalid fields at row ${i + 2}`);
    if (names.has(user.username) || emails.has(user.email.toLowerCase())) throw new Error('duplicate CSV identity');
    names.add(user.username); emails.add(user.email.toLowerCase()); return user;
  });
}
export const csvField = value => `"${String(value).replaceAll('"', '""')}"`;
export function password() { return run('openssl', ['rand', '-hex', '32']).trim(); }
export function hashes(secret) {
  const salt = randomBytes(32).toString('hex').toUpperCase();
  return { linux: run('openssl', ['passwd', '-6', '-stdin'], `${secret}\n`).trim(), salt,
    guac: createHash('sha256').update(secret + salt).digest('hex') };
}
export function encrypt(plaintext, recipient) {
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error('age recipient required');
  return run('age', ['--armor', '--encrypt', '--recipient', recipient], plaintext);
}
export function versions() {
  return Object.fromEntries(fs.readFileSync(path.join(ROOT, 'versions.env'), 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split('=')));
}
export function capacity(memoryGiB) {
  if (![64, 96, 128, 192].includes(memoryGiB)) throw new Error('unsupported memory size');
  return Math.min(20, Math.floor((memoryGiB - 24) / 5));
}
export function validateSite(site) {
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(site.hostname ?? '') || site.hostname.endsWith('.invalid')) throw new Error('set real hostname');
  for (const key of ['managementCidr', 'lanCidr']) {
    const [ip, mask] = (site[key] ?? '').split('/');
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || ip.split('.').some(x => +x > 255) || !/^\d+$/.test(mask ?? '') || +mask < 8 || +mask > 32 || ip.startsWith('192.0.2.')) throw new Error(`set ${key}`);
  }
  if (!Number.isInteger(site.maxSessions) || site.maxSessions < 1 || site.maxSessions > capacity(site.memoryGiB)) throw new Error('session cap exceeds memory budget');
  if (!/^age1[0-9a-z]{58}$/.test(site.ageRecipient ?? '')) throw new Error('set age public recipient');
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+(?: .*)?$/.test(site.adminSshKey ?? '')) throw new Error('set SSH public key');
  if (!['mdadm', 'hardware'].includes(site.storageMode)) throw new Error('invalid storageMode');
  if (!Number.isInteger(site.minimumDiskGiB) || site.minimumDiskGiB < 32) throw new Error('invalid disk capacity');
  if (!Array.isArray(site.diskSerials) || site.diskSerials.length !== 2 || new Set(site.diskSerials).size !== 2 || site.diskSerials.some(s => !/^[A-Za-z0-9_.-]+$/.test(s) || s.startsWith('REPLACE'))) throw new Error('set two SSD serials');
  if (!site.backupRepository || /REPLACE|\s/.test(site.backupRepository)) throw new Error('set backup repository');
  return site;
}
export function compose(args, input) {
  return run('docker', ['compose', '--project-name', 'orgiast-r640', '--env-file', path.join(ROOT, 'versions.env'), '-f', path.join(ROOT, 'compose.yaml'), ...args], input);
}
export function sql(statement) {
  return compose(['exec', '-T', '--user', 'postgres', 'db', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'guacamole', '-d', 'guacamole'], statement);
}
export const literal = value => `'${String(value).replaceAll("'", "''")}'`;
export const isMain = url => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);
