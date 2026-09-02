import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from '../is-entry.mjs';

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return env;
}

export async function reportHeartbeat(
  { job, startedAt, finishedAt, ok, summary },
  { homeDir = os.homedir(), fetchImpl = globalThis.fetch } = {},
) {
  if (!job) throw new Error('job is required');
  const record = { job, startedAt, finishedAt, ok, summary };
  const heartbeatDir = path.join(homeDir, '.claude', 'heartbeat');
  const filePath = path.join(heartbeatDir, `${job}.json`);
  await mkdir(heartbeatDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  let env;
  try {
    env = parseEnv(await readFile(path.join(homeDir, '.claude', 'task-sheet.env'), 'utf8'));
  } catch (error) {
    return { written: true, sent: false, warning: `task-sheet.env could not be read: ${error.message}` };
  }
  const url = env.TASK_SHEET_WEBAPP_URL || '';
  const token = env.TASK_SHEET_TOKEN || '';
  if (!url || !token) {
    return { written: true, sent: false, warning: 'TASK_SHEET_WEBAPP_URL or TASK_SHEET_TOKEN is empty' };
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, kind: 'upsertJob', ...record }),
    });
    if (!response.ok) {
      return { written: true, sent: false, warning: `heartbeat request failed with HTTP ${response.status}` };
    }
    const body = await response.json();
    if (body && body.ok === false) {
      return { written: true, sent: false, warning: `heartbeat API failed: ${body.error || body.status || 'unknown error'}` };
    }
    return { written: true, sent: true };
  } catch (error) {
    return { written: true, sent: false, warning: `heartbeat request failed: ${error.message}` };
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run') args.dryRun = true;
    else if (item.startsWith('--')) args[item.slice(2)] = argv[++index];
  }
  return args;
}

export async function heartbeatCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.job) throw new Error('--job is required');
  const record = {
    job: args.job,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    ok: args.ok === undefined ? undefined : args.ok === 'true',
    summary: args.summary,
  };
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, record })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await reportHeartbeat(record))}\n`);
}

if (isEntry(import.meta.url)) {
  heartbeatCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
