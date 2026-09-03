#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

const API = 'https://tasks.googleapis.com/tasks/v1';
const SCOPE = 'https://www.googleapis.com/auth/tasks';
const DEFAULT_USER = 'kim@orgiast.jp';
const USAGE = `使い方:
  node tools/gtasks.mjs get  <listId> <taskId>
  node tools/gtasks.mjs note <listId> <taskId> --text-file <path> [--user <email>]
  node tools/gtasks.mjs done <listId> <taskId> [--user <email>]`;

export function appendNotes(existingNotes, newText) {
  const existing = String(existingNotes ?? '');
  const addition = String(newText ?? '');
  return existing ? `${existing}\n\n---\n${addition}` : addition;
}

export function parseArgs(args) {
  const [command, listId, taskId, ...rest] = args;
  if (!['get', 'note', 'done'].includes(command) || !listId || !taskId) throw new Error(USAGE);

  let user = DEFAULT_USER;
  let textFile;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--user' && rest[index + 1]) user = rest[++index];
    else if (flag === '--text-file' && rest[index + 1]) textFile = rest[++index];
    else throw new Error(USAGE);
  }
  if (command === 'note' && !textFile) throw new Error(USAGE);
  if (command !== 'note' && textFile) throw new Error(USAGE);
  return { command, listId, taskId, user, ...(textFile ? { textFile } : {}) };
}

export async function tasksApi(token, path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Google Tasks API ${response.status}: ${await response.text()}`);
  return response.json();
}

const taskPath = (listId, taskId) => `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;

export async function runCommand(parsed, {
  tokenProvider = getDriveToken,
  api = tasksApi,
  readTextFile = (path) => readFile(path, 'utf8'),
} = {}) {
  const token = await tokenProvider({ scope: SCOPE, impersonate: parsed.user });
  const path = taskPath(parsed.listId, parsed.taskId);
  if (parsed.command === 'get') return api(token, path);

  let body;
  if (parsed.command === 'note') {
    const [task, text] = await Promise.all([api(token, path), readTextFile(parsed.textFile)]);
    body = { notes: appendNotes(task.notes, text) };
  } else {
    body = { status: 'completed' };
  }
  return api(token, path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function main() {
  const result = await runCommand(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
