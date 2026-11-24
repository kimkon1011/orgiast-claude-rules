// fleet-mail と fleet-beacon が共有する PC ラベル解決。fleet-mail.mjs に置くと
// fleet-beacon.mjs ⇄ fleet-mail.mjs が循環し、--send が exit 13 で黙って止まる（PR #726 の事故）。
import fs from 'node:fs';
import path from 'node:path';
import { parseEnvText } from '../env-kv.mjs';
import os from 'node:os';

function envFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

export function resolveFleetLabel(home, identity = { hostname: os.hostname() }) {
  // Check for custom fleet PC map first
  const fleetMapPath = path.join(home, '.claude', 'fleet-pc-map.json');
  if (fs.existsSync(fleetMapPath)) {
    try {
      const fleetMap = JSON.parse(fs.readFileSync(fleetMapPath, 'utf8'));
      if (identity.hostname in fleetMap) {
        const entry = fleetMap[identity.hostname];
        // entry may be a plain string label or an object with label/hostname/aliases
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'object' && entry) {
          if (typeof entry.label === 'string') return entry.label;
          if (Array.isArray(entry.aliases) && typeof entry.aliases[0] === 'string') return entry.aliases[0];
          if (typeof entry.hostname === 'string') return entry.hostname;
        }
        // entry found but no usable string; fall through to other resolution paths
      }
    } catch (e) {
      // Ignore invalid map file
    }
  }

  // Check for REPORTER_LABEL in cost-reporter.env
  const reporterLabel = envFile(path.join(home, '.claude', 'cost-reporter.env')).REPORTER_LABEL;
  if (reporterLabel) return reporterLabel;

  // Normalize hostname for known patterns
  // If hostname starts with digits followed by 'KimPC', normalize to 'kim-PC'
  const kimPCMatch = identity.hostname.match(/^\d+(\w+)/i);
  if (kimPCMatch && kimPCMatch[1].toLowerCase() === 'kimpc') {
    return 'kim-PC';
  }

  // Return original hostname as fallback
  return identity.hostname;
}
