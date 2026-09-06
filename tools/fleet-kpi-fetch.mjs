#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import os from 'node:os';
import path from 'node:path';

function parseEnv(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) return null;
      return [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')];
    }).filter(Boolean));
  } catch { return {}; }
}

export function getClaudeDir(argv = []) {
  const homeArgIdx = argv.indexOf('--home');
  if (homeArgIdx !== -1 && argv[homeArgIdx + 1]) {
    return path.join(argv[homeArgIdx + 1], '.claude');
  }
  const home = process.env.ORGIAST_HOME || os.homedir();
  return path.join(home, '.claude');
}

export async function fetchFleetKPIs({ sheetUrl, token, fetchImpl = globalThis.fetch } = {}) {
  if (!sheetUrl || !token) {
    return { ok: false, reason: 'FLEET_SHEET_URL or FLEET_SHEET_TOKEN is not configured' };
  }
  try {
    const url = new URL(sheetUrl);
    url.searchParams.set('token', token);
    let response = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 2 && !response; attempt += 1) {
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
      }
    }
    if (!response) {
      return { ok: false, reason: lastError?.message || 'no response' };
    }
    if (!response.ok) {
      return { ok: false, reason: `HTTP status ${response.status}` };
    }
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') {
      return { ok: false, reason: 'invalid json payload' };
    }
    if (!payload.ok) {
      return { ok: false, reason: payload.error || 'payload ok is false' };
    }
    if (!Array.isArray(payload.rows)) {
      return { ok: false, reason: 'rows is not an array' };
    }
    return { ok: true, rows: payload.rows };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const claudeDir = getClaudeDir(argv);
  const fleetEnv = {
    ...parseEnv(path.join(claudeDir, 'fleet-sheet.env')),
    ...process.env
  };
  const sheetUrl = fleetEnv.FLEET_SHEET_URL;
  const token = fleetEnv.FLEET_SHEET_TOKEN;

  const result = await fetchFleetKPIs({ sheetUrl, token });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (result.ok) {
      console.log(`Successfully fetched ${result.rows.length} rows.`);
    } else {
      console.error(`Failed to fetch fleet KPIs: ${result.reason}`);
      process.exitCode = 1;
    }
  }
  return result;
}

// Only run if called directly
if (isEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
