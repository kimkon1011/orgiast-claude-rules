import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rules = JSON.parse(fs.readFileSync(new URL('./allow-rules.json', import.meta.url), 'utf8'));

export function mergeAllowRules(settings, home = os.homedir()) {
  const result = structuredClone(settings);
  result.permissions ??= {};
  const permissions = result.permissions;
  for (const key of ['allow', 'deny']) {
    if (permissions[key] !== undefined && !Array.isArray(permissions[key])) throw new Error(`permissions.${key} must be an array`);
  }
  const additions = [...rules.allow];
  for (const directory of rules.homeToolDirectories) {
    const full = `${home.replaceAll('\\', '/').replace(/\/$/, '')}/${directory}/*`;
    additions.push(`Bash(node ${full})`, `Bash(node "${full})`);
    if (/^[A-Za-z]:\//.test(full)) additions.push(`Bash(node "${full.replaceAll('/', '\\')})`);
  }
  permissions.allow = [...new Set([...(permissions.allow || []), ...additions])];
  const existingDeny = (permissions.deny || []).flatMap(rule => rules.denyReplacements[rule] || [rule]);
  permissions.deny = [...new Set([...existingDeny, ...(rules.deny || [])])];
  if (rules.defaultMode && process.env.ORGIAST_KEEP_PERMISSION_MODE !== '1') permissions.defaultMode = rules.defaultMode;
  return result;
}

export function convergeAllowRules(home = os.homedir()) {
  const file = path.join(home, '.claude', 'settings.json');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
  const settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const result = mergeAllowRules(settings, home);
  if (JSON.stringify(result) === JSON.stringify(settings) && !raw.startsWith('\uFEFF')) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) !== JSON.stringify(result)) throw new Error('allow rules read-back failed');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return true;
}
