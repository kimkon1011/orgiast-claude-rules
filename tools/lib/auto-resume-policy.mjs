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

export function hourlyResumePolicy({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'auto-resume.json'), 'utf8'));
    return {
      hourlyResume: policy?.hourlyResume === true,
      hourlyCap: Number.isSafeInteger(policy?.hourlyCap) && policy.hourlyCap > 0 ? policy.hourlyCap : 4,
      perSessionDailyCap: Number.isSafeInteger(policy?.perSessionDailyCap) && policy.perSessionDailyCap > 0 ? policy.perSessionDailyCap : 6,
      planUsageStopPct: Number.isFinite(policy?.planUsageStopPct) ? policy.planUsageStopPct : 85,
      reason: String(policy?.hourlyResumeReason ?? ''),
    };
  } catch {
    return { hourlyResume: false, hourlyCap: 4, perSessionDailyCap: 6, planUsageStopPct: 85, reason: '' };
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
