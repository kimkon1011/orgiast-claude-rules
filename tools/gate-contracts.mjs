import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);
// Literal JSON is intentional: several legacy hooks execute/exit when imported.
// Read metadata without executing those hooks or interpreting arbitrary source.
export function readContract(file) {
  const source = fs.readFileSync(file, 'utf8');
  const literal = source.match(/^export const GATE_CONTRACT = (\{[^\n]+\});$/m);
  return literal ? JSON.parse(literal[1]) : null;
}
export function discoverGates(dir = toolsDir) {
  const names = new Set();
  const runner = fs.readFileSync(path.join(dir, 'stop-gate-runner.mjs'), 'utf8');
  for (const m of runner.matchAll(/from ['"]\.\/([^'"]+(?:gate|guard))\.mjs['"]/g)) names.add(m[1]);
  const registration = fs.readFileSync(path.join(dir, 'register-hooks.mjs'), 'utf8');
  for (const m of registration.matchAll(/add\(settings\.hooks\.(?:PreToolUse|Stop), '([^']+)\.mjs'/g)) names.add(m[1]);
  // Detect a new deny hook even if its author forgot both registries.
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.mjs') || /\.test\.mjs$/.test(entry) || /gate-(?:contracts|runtime|hook-runner)/.test(entry)) continue;
    const source = fs.readFileSync(path.join(dir, entry), 'utf8');
    if (/permissionDecision\s*:\s*['"]deny|decision\s*:\s*['"]block/.test(source)
      && /hook|gate|guard|detector/i.test(source)) names.add(entry.slice(0, -4));
  }
  // Non-denying registered hooks are still wrapped for future rollout, but do not
  // require a deny contract until they implement denial. Runner children always do.
  return [...names].filter(name => {
    const source = fs.readFileSync(path.join(dir, `${name}.mjs`), 'utf8');
    return /GATE_CONTRACT|permissionDecision\s*:\s*['"]deny|decision\s*:\s*['"]block/.test(source)
      || runner.includes(`from './${name}.mjs'`) && /(?:gate|guard)$/.test(name);
  }).sort();
}
export function contractErrors(contract, { root = repoDir, manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/keyserve-distribution-manifest.json'), 'utf8')) } = {}) {
  if (!contract?.name || !Array.isArray(contract.remedies) || !contract.remedies.length) return ['missing GATE_CONTRACT/remedies'];
  const errors = [];
  for (const r of contract.remedies) {
    if (!r.ref?.trim()) { errors.push('missing remedy ref'); continue; }
    if (r.kind === 'repo-file') {
      const file = path.resolve(root, r.ref);
      if (path.relative(root, file).startsWith('..') || !fs.existsSync(file)) errors.push(`missing repo-file: ${r.ref}`);
      else if (r.section && !fs.readFileSync(file, 'utf8').includes(`## ${r.section}\n`)) errors.push(`missing section: ${r.section}`);
    } else if (r.kind === 'keyserve-key') {
      if (!manifest.distributions.some(d => d.keys.some(k => `${d.file}#${k}` === r.ref))) errors.push(`undistributed key: ${r.ref}`);
    } else if (r.kind === 'user-consent') {
      if (!r.reason?.trim()) errors.push(`missing consent reason: ${r.ref}`);
    } else if (r.kind !== 'command') errors.push(`unknown remedy kind: ${r.kind}`);
  }
  return errors;
}
