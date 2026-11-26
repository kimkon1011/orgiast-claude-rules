// fleet-mail と fleet-beacon が共有する PC ラベル解決。fleet-mail.mjs に置くと
// fleet-beacon.mjs ⇄ fleet-mail.mjs が循環し、--send が exit 13 で黙って止まる（PR #726 の事故）。
import fs from 'node:fs';
import path from 'node:path';
import { parseEnvText } from '../env-kv.mjs';
import os from 'node:os';

function envFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

/** PC番号付き表記などゆれを kim-PC に揃える。それ以外はそのまま返す。 */
export function normalizeFleetLabel(label) {
  if (typeof label !== 'string') return label;
  // 先頭の数字（任意）＋任意の区切り＋ kim ＋任意の - ＋ pc
  if (/^\d*[\s\-_｜]*kim-?pc$/i.test(label)) return 'kim-PC';
  return label;
}

export function resolveFleetLabel(home, identity = { hostname: os.hostname() }) {
  let label;

  // Check for custom fleet PC map first
  const fleetMapPath = path.join(home, '.claude', 'fleet-pc-map.json');
  if (fs.existsSync(fleetMapPath)) {
    try {
      const fleetMap = JSON.parse(fs.readFileSync(fleetMapPath, 'utf8'));
      if (identity.hostname in fleetMap) {
        const entry = fleetMap[identity.hostname];
        // entry may be a plain string label or an object with label/hostname/aliases
        if (typeof entry === 'string') label = entry;
        else if (typeof entry === 'object' && entry) {
          if (typeof entry.label === 'string') label = entry.label;
          else if (typeof entry.hostname === 'string') label = entry.hostname;
          else if (Array.isArray(entry.aliases) && typeof entry.aliases[0] === 'string') label = entry.aliases[0];
        }
        // entry found but no usable string; fall through to other resolution paths
      }
    } catch (e) {
      // Ignore invalid map file
    }
  }

  if (label === undefined) {
    // Check for REPORTER_LABEL in cost-reporter.env
    const reporterLabel = envFile(path.join(home, '.claude', 'cost-reporter.env')).REPORTER_LABEL;
    if (reporterLabel) label = reporterLabel;
  }

  if (label === undefined) label = identity.hostname;

  return normalizeFleetLabel(label);
}
