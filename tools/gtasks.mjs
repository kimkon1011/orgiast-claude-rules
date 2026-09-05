#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';

export const COMMAND_FOLDER_ID = '1grKtdl1DFcrQZLm766rgV079_IzLjav7';
export const DEFAULT_TIMEOUT_SECONDS = 420;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeQuery = (value) => String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");

export function makeMultipartBody(metadata, content, boundary = `gtasks-${randomUUID()}`) {
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`, 'utf8'),
    Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);
  return { boundary, body };
}

export function createDriveQueue({ token, api = driveApi, folderId = COMMAND_FOLDER_ID }) {
  async function findByName(name) {
    const q = `name='${escapeQuery(name)}' and '${folderId}' in parents and trashed=false`;
    const params = new URLSearchParams({ q, fields: 'files(id,name,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '100' });
    const response = await api(token, `https://www.googleapis.com/drive/v3/files?${params}`);
    return (await response.json()).files ?? [];
  }
  return {
    async submit(id, payload) {
      const name = `cmd_${id}.json`;
      const { boundary, body } = makeMultipartBody({ name, parents: [folderId], mimeType: 'text/plain' }, JSON.stringify(payload));
      await api(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
    },
    async takeResult(id) {
      const files = await findByName(`result_${id}.txt`);
      if (!files.length) return null;
      const file = files[0];
      const response = await api(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
      const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
      await api(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
      try { return JSON.parse(text); } catch { throw new Error(`GAS結果がJSONではありません (${file.name}): ${text.slice(0, 300)}`); }
    },
    async readCache() {
      const files = await findByName('tasks-cache.json');
      if (!files.length) throw new Error('tasks-cache.json がありません。list --refresh を実行してください');
      const response = await api(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(files[0].id)}?alt=media`);
      return JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8').replace(/^\uFEFF/, ''));
    },
  };
}

export async function runQueued(commands, { queue, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, pollMs = 10_000, now = Date.now, wait = sleep, idFactory = randomUUID } = {}) {
  if (!queue) throw new Error('queue が必要です');
  const pending = commands.map((item, index) => ({ index, id: idFactory(), item }));
  await Promise.all(pending.map(({ id, item }) => queue.submit(id, item)));
  const deadline = now() + timeoutSeconds * 1000;
  const results = new Array(commands.length);
  while (pending.length && now() < deadline) {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      const result = await queue.takeResult(entry.id);
      if (result === null) continue;
      results[entry.index] = result;
      pending.splice(index, 1);
    }
    if (pending.length) await wait(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  if (pending.length) throw new Error(`タイムアウト: ${pending.map(({ index }) => `${index + 1}番目`).join(', ')} の結果が返りませんでした`);
  const failed = results.map((result, index) => ({ result, index })).filter(({ result }) => result?.ok === false || result?.result?.ok === false);
  if (failed.length) throw new Error(failed.map(({ result, index }) => {
    const failure = result?.ok === false ? result : result.result;
    return `${index + 1}番目: ${failure.error ?? failure.message ?? JSON.stringify(failure)}`;
  }).join('\n'));
  return results;
}

export function flattenCache(cache) {
  let n = 0;
  return { updatedAt: cache?.updatedAt ?? null, rows: (cache?.lists ?? []).flatMap((list) => (list.tasks ?? []).map((task) => ({
    n: ++n, listId: list.id, list: list.title, taskId: task.id, title: task.title, notes: task.notes ?? '',
    status: task.status ?? null, due: task.due ?? null,
  }))) };
}

export function formatHuman(cache) {
  let n = 0;
  return (cache?.lists ?? []).map((list) => [`\n${list.title} (${list.id})`, ...(list.tasks ?? []).map((task) => `${++n}. ${String(task.title).replace(/[\r\n]+/g, ' ')}${task.due ? ` [${String(task.due).slice(0, 10)}]` : ''}`)]).flat().join('\n').trim();
}

function optionValue(args, name, required = false) {
  const index = args.indexOf(name);
  if (index < 0) { if (required) throw new Error(`${name} が必要です`); return undefined; }
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} に値が必要です`);
  return args[index + 1];
}

export async function execute(argv, { queue, tokenProvider = getDriveToken, api = driveApi, stdout = console.log } = {}) {
  const [command, ...args] = argv;
  // PR #255 の呼び出しとの互換用。GAS は kim 権限で動くため値は意図的に使わない。
  optionValue(args, '--user');
  const timeoutRaw = optionValue(args, '--timeout');
  const timeoutSeconds = timeoutRaw === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(timeoutRaw);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('--timeout は正の秒数で指定してください');
  const activeQueue = queue ?? createDriveQueue({ token: await tokenProvider(), api });
  const run = (items) => runQueued(items, { queue: activeQueue, timeoutSeconds });
  if (command === 'list') {
    if (args.includes('--refresh')) await run([{ command: 'dumpTasksToCache', args: [] }]);
    const cache = await activeQueue.readCache();
    stdout(args.includes('--json') ? JSON.stringify(flattenCache(cache), null, 2) : formatHuman(cache));
    return { cache, rows: flattenCache(cache).rows };
  }
  if (command === 'get') {
    if (!args[0] || !args[1]) throw new Error('get には listId と taskId が必要です');
    await run([{ command: 'dumpTasksToCache', args: [] }]);
    const cache = await activeQueue.readCache();
    const task = (cache?.lists ?? []).find((list) => list.id === args[0])?.tasks?.find((item) => item.id === args[1]);
    if (!task) throw new Error(`タスクが見つかりません: ${args[0]}/${args[1]}`);
    const result = { title: task.title, notes: task.notes ?? '', status: task.status ?? null };
    stdout(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'note') {
    if (!args[0] || !args[1]) throw new Error('note には listId と taskId が必要です');
    const file = optionValue(args, '--text-file', true);
    return run([{ command: 'appendTaskNotes', args: [args[0], args[1], fs.readFileSync(file, 'utf8')] }]);
  }
  if (command === 'done') {
    if (!args[0] || !args[1]) throw new Error('done には listId と taskId が必要です');
    return run([{ command: 'completeTask', args: [args[0], args[1]] }]);
  }
  if (command === 'add') {
    if (!args[0]) throw new Error('add には listId が必要です');
    const title = optionValue(args, '--title', true);
    const notesFile = optionValue(args, '--notes-file');
    return run([{ command: 'insertTaskInList', args: [args[0], title, notesFile ? fs.readFileSync(notesFile, 'utf8') : ''] }]);
  }
  if (command === 'run') {
    const file = optionValue(args, '--file', true);
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(items) || items.some((item) => !item || typeof item.command !== 'string' || !Array.isArray(item.args))) throw new Error('commands.json は [{command,args}] 形式が必要です');
    return run(items);
  }
  throw new Error('使い方: gtasks.mjs list [--json] [--refresh] | get <listId> <taskId> | note <listId> <taskId> --text-file <path> | done <listId> <taskId> | add <listId> --title <t> [--notes-file <path>] | run --file <commands.json> [--timeout <秒>] [--user <email>]');
}

if (isEntry(import.meta.url)) {
  try { await execute(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
