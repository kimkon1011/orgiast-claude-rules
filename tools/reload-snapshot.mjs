#!/usr/bin/env node
// Snapshot save/restore for nightly VSCode restart.
// save <file>: writes live, unclosed, non-empty sessions to JSON.
// restore <file>: reopens each session via vscode:// URI, waits for bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { agentsFromRegistry, hasConversation, resolveCodeCli } from './reopen-lost-sessions.mjs';
import { liveSessions } from './lib/process-hygiene.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const BASE = path.join(os.homedir(), '.claude');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}

function closedIds(base) {
  const ledger = readJson(path.join(base, 'closed-sessions.json'), { ids: [] });
  if (!Array.isArray(ledger.ids)) throw Error('Invalid closed ledger');
  return new Set(ledger.ids);
}

// Read transcript rows for a session, return { hasConversation, cwd }.
function transcriptInfo(base, id) {
  const projects = path.join(base, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name === '_deleted-backup') continue;
    const file = path.join(projects, dir.name, `${id}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const rows = raw.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const last = key => rows.findLast(row => row[key])?.[key];
    return {
      cwd: last('cwd'),
      hasConversation: hasConversation(rows),
    };
  }
  return null;
}

// --- save ---
export function saveSnapshot(file, { base = BASE, dryRun = false } = {}) {
  const pidAlive = liveSessions(base);
  let aliveIds;
  if (pidAlive.size > 0) {
    aliveIds = new Set(pidAlive.keys());
  } else {
    const sessionsDir = path.join(base, 'sessions');
    try {
      aliveIds = agentsFromRegistry(sessionsDir);
    } catch (e) {
      if (e.code === 'ENOENT') {
        aliveIds = new Set();
      } else {
        throw e;
      }
    }
  }
  const closed = closedIds(base);
  const sessions = [];
  for (const id of aliveIds) {
    if (closed.has(id)) continue;
    const info = transcriptInfo(base, id);
    if (!info) continue;
    if (!info.hasConversation) continue;
    if (!info.cwd) continue;
    sessions.push({ sessionId: id, cwd: info.cwd });
  }
  if (dryRun) {
    const result = { count: sessions.length, sessions: sessions.map(s => ({ sessionId: s.sessionId, cwd: s.cwd })) };
    console.log(JSON.stringify(result));
    return result;
  }
  const snapshot = { version: 1, at: new Date().toISOString(), sessions };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, file);
  const result = { count: sessions.length };
  console.log(JSON.stringify(result));
  return result;
}

// --- restore ---
export async function restoreSnapshot(file, { base = BASE, codeCli, spawn = spawnSync, wait = sleep, now = Date.now } = {}) {
  const snapshot = readJson(file);
  if (snapshot.version !== 1 || !Array.isArray(snapshot.sessions)) throw Error('Invalid reload snapshot');
  const cli = codeCli || resolveCodeCli();
  const connected = [];
  const failed = [];

  for (const session of snapshot.sessions) {
    const id = session.sessionId || session.id;
    if (!id || !session.cwd) { failed.push({ id, error: 'missing id or cwd' }); continue; }
    try {
      // Open the folder window first
      const psScript = `& '${cli.replace(/'/g, "''")}' --reuse-window '${session.cwd.replace(/'/g, "''")}'`;
      const r1 = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (r1.error) throw Error(`code --reuse-window failed: ${r1.error.message}`);
      await wait(2000);

      // Open the session URI
      const uri = 'vscode://anthropic.claude-code/open?session=' + encodeURIComponent(id);
      const r2 = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `& '${cli.replace(/'/g, "''")}' --reuse-window --open-url '${uri.replace(/'/g, "''")}'`],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (r2.error) throw Error(`code --open-url failed: ${r2.error.message}`);
      await wait(1000);

      // Wait for bridge session to appear in sessions dir (max 90s)
      let found = false;
      const deadline = now() + 90_000;
      for (let elapsed = 0; elapsed <= 90; elapsed += 3) {
        if (now() >= deadline) break;
        const meta = findBridgeSession(base, id);
        if (meta) { found = true; break; }
        await wait(3000);
      }

      if (!found) {
        // Retry once: open URI again
        const r3 = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `& '${cli.replace(/'/g, "''")}' --reuse-window --open-url '${uri.replace(/'/g, "''")}'`],
          { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        if (r3.error) throw Error(`retry code --open-url failed: ${r3.error.message}`);
        await wait(1000);

        const deadline2 = now() + 90_000;
        for (let elapsed = 0; elapsed <= 90; elapsed += 3) {
          if (now() >= deadline2) break;
          const meta = findBridgeSession(base, id);
          if (meta) { found = true; break; }
          await wait(3000);
        }
      }

      if (found) {
        connected.push({ id });
      } else {
        failed.push({ id, error: 'bridge session not found after 2 attempts' });
      }
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }

  const result = { connected, failed };
  console.log(JSON.stringify(result));
  return result;
}

function findBridgeSession(base, sessionId) {
  const sessionsDir = path.join(base, 'sessions');
  let entries;
  try { entries = fs.readdirSync(sessionsDir); } catch { return null; }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, entry), 'utf8'));
      if (data.sessionId === sessionId && data.bridgeSessionId) return data;
    } catch { continue; }
  }
  return null;
}

// --- CLI ---
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const file = args[1];
  const dryRun = args.includes('--dry-run');

  if (cmd === 'save' && file) {
    saveSnapshot(file, { dryRun });
  } else if (cmd === 'restore' && file) {
    const result = await restoreSnapshot(file);
    if (result.failed.length > 0) process.exitCode = 2;
  } else {
    console.error('Usage: reload-snapshot.mjs save <file> [--dry-run]');
    console.error('       reload-snapshot.mjs restore <file>');
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) { await main(); }