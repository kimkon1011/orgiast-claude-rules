import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function autoResumeAllowed({ source, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  if (process.env.ORGIAST_AUTO_RESUME === '1') return true;
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'auto-resume.json'), 'utf8'));
    return policy?.enabled === true || (Array.isArray(policy?.allowSources) && policy.allowSources.includes(source));
  } catch {
    return false;
  }
}
