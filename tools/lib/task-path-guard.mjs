import os from 'node:os';
import path from 'node:path';

function toSlashLower(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

function isUnderDir(candidate, root) {
  if (!candidate || !root) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

/** True when a scheduled-task path would be baked under a temporary HOME / tmp tree. */
export function isEphemeralPath(p) {
  if (p == null || p === '') return false;
  const raw = String(p);
  const rawSlash = toSlashLower(raw);

  if (rawSlash.split('/').includes('codex-do-cursor-agent-home')) return true;
  if (rawSlash.includes('appdata/local/temp')) return true;

  let resolved;
  try {
    resolved = toSlashLower(path.resolve(raw));
  } catch {
    resolved = rawSlash;
  }

  if (resolved === '/tmp' || resolved.startsWith('/tmp/')) return true;
  if (resolved === '/var/folders' || resolved.startsWith('/var/folders/')) return true;
  if (rawSlash === '/tmp' || rawSlash.startsWith('/tmp/')) return true;
  if (rawSlash === '/var/folders' || rawSlash.startsWith('/var/folders/')) return true;

  try {
    const tmp = toSlashLower(path.resolve(os.tmpdir()));
    if (isUnderDir(resolved, tmp)) return true;
  } catch {
    // ignore tmpdir resolution failures; substring checks above still apply
  }

  return false;
}

/** Throw when a task registration path is under a temporary HOME / tmp tree. */
export function assertStableTaskPath(p, { label } = {}) {
  if (!isEphemeralPath(p)) return p;
  const name = label || 'path';
  throw new Error(
    `unstable task path (${name}): ${p} — refused registration under temporary HOME (codex-do-cursor-agent-home / os.tmpdir())`,
  );
}
