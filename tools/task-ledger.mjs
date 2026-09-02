import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { machineIdentity } from './machine-identity.mjs';

const TASK_FIELDS = ['taskId', '起票元', '件名', '依頼元', '担当PC', '状態', '次アクション', '成果物リンク', '期限', '備考'];

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator >= 0) env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return env;
}

export function parseLedgerArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--dry-run') args.dryRun = true;
    else if (rest[index].startsWith('--')) args[rest[index].slice(2)] = rest[++index];
  }
  return args;
}

function requireTaskId(args) {
  if (!args.taskId) throw new Error('--taskId is required');
}

export function buildRequest(args, identity = machineIdentity()) {
  if (!['upsert', 'claim', 'done', 'list'].includes(args.command)) {
    throw new Error('command must be one of: upsert, claim, done, list');
  }
  if (args.command !== 'list') requireTaskId(args);
  if (args.command === 'upsert') {
    const payload = { kind: 'upsertTask' };
    for (const field of TASK_FIELDS) if (args[field] !== undefined) payload[field] = args[field];
    return { method: 'POST', payload };
  }
  if (args.command === 'claim') {
    const payload = { kind: 'claimTask', taskId: args.taskId, 担当PC: args.担当PC || identity.hostname };
    if (args.状態 !== undefined) payload.状態 = args.状態;
    return { method: 'POST', payload };
  }
  if (args.command === 'done') {
    const payload = { kind: 'doneTask', taskId: args.taskId };
    for (const field of ['成果物リンク', '備考']) if (args[field] !== undefined) payload[field] = args[field];
    return { method: 'POST', payload };
  }
  const query = {};
  for (const field of ['taskId', '状態', '担当PC']) if (args[field] !== undefined) query[field] = args[field];
  return { method: 'GET', query };
}

export async function runTaskLedger(
  args,
  { homeDir = os.homedir(), fetchImpl = globalThis.fetch, identity = machineIdentity() } = {},
) {
  const request = buildRequest(args, identity);
  if (args.dryRun) return { dryRun: true, ...request };

  let env;
  try {
    env = parseEnv(await readFile(path.join(homeDir, '.claude', 'task-sheet.env'), 'utf8'));
  } catch (error) {
    throw new Error(`task-sheet.env could not be read: ${error.message}`);
  }
  const url = env.TASK_SHEET_WEBAPP_URL || '';
  const token = env.TASK_SHEET_TOKEN || '';
  if (!url) throw new Error('TASK_SHEET_WEBAPP_URL is empty');
  if (!token) throw new Error('TASK_SHEET_TOKEN is empty');

  let response;
  if (request.method === 'POST') {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...request.payload }),
    });
  } else {
    const target = new URL(url);
    target.searchParams.set('token', token);
    for (const [key, value] of Object.entries(request.query)) target.searchParams.set(key, value);
    response = await fetchImpl(target, { method: 'GET' });
  }
  if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
  const body = await response.json();
  if (body && body.ok === false && body.error !== 'already_claimed') {
    throw new Error(`API failed: ${body.error || body.status || 'unknown error'}`);
  }
  return body;
}

export async function taskLedgerCli(argv = process.argv.slice(2)) {
  const result = await runTaskLedger(parseLedgerArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isEntry(import.meta.url)) {
  taskLedgerCli().catch((error) => {
    process.stderr.write(`warning: ${error.message}\n`);
    process.exitCode = 1;
  });
}
