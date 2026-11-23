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

export function eventResumeAllowed({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'auto-resume.json'), 'utf8'));
    return policy?.eventResume === true;
  } catch {
    return false;
  }
}

/**
 * Returns true only when the config file explicitly sets `enabled: false`,
 * i.e. auto-resume is *permanently disabled by configuration.
 * Unlike `autoResumeAllowed()`, this does not check the env var or allowSources.
 */
export function autoResumeDisabledByConfig({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'auto-resume.json'), 'utf8'));
    return policy?.enabled === false;
  } catch {
    return false;
  }
}
