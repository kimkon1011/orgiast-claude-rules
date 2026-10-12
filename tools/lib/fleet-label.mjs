// fleet-mail と fleet-beacon が共有する PC ラベル解決。fleet-mail.mjs に置くと
// fleet-beacon.mjs ⇄ fleet-mail.mjs が循環し、--send が exit 13 で黙って止まる（PR #726 の事故）。
import fs from 'node:fs';
import path from 'node:path';
import { parseEnvText } from '../env-kv.mjs';
import { machineIdentity } from '../machine-identity.mjs';

function envFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

export function resolveFleetLabel(home, identity = machineIdentity()) {
  return envFile(path.join(home, '.claude', 'cost-reporter.env')).REPORTER_LABEL || identity.hostname;
}
