import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const registryPath = path.join(repoRoot, 'tools/feedback-zero-registry.json');
export const kit = JSON.parse(fs.readFileSync(new URL('./kit.json', import.meta.url), 'utf8'));
export function detectKind(root) {
  if (!root) return null;
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps && Object.prototype.hasOwnProperty.call(deps, 'next')) return 'next';
    } catch {
      // 読めない package.json は無視して他の判定へ進む
    }
  }
  if (fs.existsSync(path.join(root, 'appsscript.json')) || fs.existsSync(path.join(root, '.clasp.json'))) return 'gas';
  return null;
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export function gasRoot(root) {
  const dir = path.resolve(root, readJson(path.join(root, '.clasp.json'), {}).rootDir || '.');
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error('clasp rootDir がアプリ外を指しています');
  return dir;
}
export function files(root, extensions = /\.(html|gs|js|tsx|jsx|ts)$/) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink() || e.name.startsWith('.') || ['node_modules','dist','build','out'].includes(e.name)) return [];
    const f = path.join(root, e.name);
    return e.isDirectory() ? files(f, extensions) : extensions.test(e.name) ? [f] : [];
  });
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
export function atLeast(actual, minimum) {
  const re = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/;
  if (!re.test(actual || '') || !re.test(minimum)) return false;
  const a = actual.split(/[.+]/).slice(0,3).map(Number), b = minimum.split('.').map(Number);
  for (let i=0;i<3;i++) if(a[i] !== b[i]) return a[i] > b[i];
  return true;
}
