#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { execute as executeGtasks, flattenCache } from './gtasks.mjs';

export const MARKER = '<!-- NEXT-SESSION v1 -->';
export const defaultStateFile = () => path.join(os.homedir(), '.claude', 'gtasks-state.json');
export const defaultNextSessionFile = () => path.join(os.homedir(), '.claude', 'next-session.md');

export function readState(text) {
  try { const value = JSON.parse(text); return value?.picked && typeof value.picked === 'object' ? value : { picked: {} }; } catch { return { picked: {} }; }
}

// kim 指示(2026-09-03): メモ/引用/期限切れは削除せず残すが、無人消化の対象からは外す。
// 繰り返しタスクは毎日 taskId が変わるので、除外はリストIDとタイトルで判定する。
export const defaultSkipFile = () => path.join(os.homedir(), '.claude', 'gtasks-skip.json');
export const BUILTIN_SKIP = {
  listIds: ['REs0cWdTdzcwVWpmSzJKcg'], // 「古い Google Keep のリマインダー」= 2020-2025年の期限切れ置き場
  titles: [
    '幸せの輪を広げる感覚を体験する', 'シンクロニシティ', '不確実性という性質が私',
    '良いフィードバックを細かく', '自分も他人も平等と感じてみる', '私はどこにいる',
    '私の理想がすべて現実化している', '苦しみを解消してから問題に', 'すでに達成している',
    '誰がなんと言おうとこれが正というマニュアル', '精度としてはopus5相当',
  ],
};

export function readSkip(text) {
  let extra = {};
  try { extra = JSON.parse(text) ?? {}; } catch { extra = {}; }
  return {
    listIds: [...BUILTIN_SKIP.listIds, ...(Array.isArray(extra.listIds) ? extra.listIds : [])],
    titles: [...BUILTIN_SKIP.titles, ...(Array.isArray(extra.titles) ? extra.titles : [])],
  };
}

export function isSkipped(row, skip = BUILTIN_SKIP) {
  if ((skip.listIds ?? []).includes(row.listId)) return true;
  const title = String(row.title ?? '');
  return (skip.titles ?? []).some((needle) => needle && title.includes(needle));
}

export function selectTasks(rows, state, count = 3, skip = BUILTIN_SKIP) {
  return rows.filter((row) => !state.picked[row.taskId] && !isSkipped(row, skip)).slice(0, count);
}

export function appendTodoBlock(original, rows) {
  if (!rows.length) return String(original ?? '');
  const source = String(original ?? '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const prefix = source && !source.endsWith('\n') && !source.endsWith('\r') ? newline + newline : source.endsWith(newline + newline) || !source ? '' : newline;
  const todos = rows.map((row, index) => `${index + 1}. Googleタスク消化: ${String(row.title).replace(/[\r\n]+/g, ' ')}（${row.listId}/${row.taskId}）`).join(newline);
  return `${source}${prefix}${MARKER}${newline}## 残TODO（Googleタスク）${newline}${todos}${newline}`;
}

// 無人セッションは過去を探せないので、消化手順を毎回この場に書く（§1.5.3 自己完結）。
// 番号なしの行はパーサが TODO として拾わないため、35分枠を1つ食い潰さない。
export const HOWTO = [
  '- **Googleタスク消化の手順**（下の「Googleタスク消化:」行に共通）: (1) タイトルの作業を実際にやる（調査ならWeb検索して結論まで、実装なら `node tools/codex-do.mjs --prompt-file <仕様>` でCodexに委譲してテストまで緑にする）。',
  '  (2) 結果・結論・根拠URLを1ファイルに書き、`node tools/gtasks.mjs note <listId> <taskId> --text-file <その file>` でタスクのメモに残す（kim はスマホのGoogleタスクでこれを読む）。',
  '  (3) Claude だけで完遂したものは `node tools/gtasks.mjs done <listId> <taskId>` で完了にする。kim の物理操作（購入・電話・来店・署名・支払い）が必ず残るものは done にせず、メモの最後に「■ kimの残り1操作: …」を1行で書いて終わる。',
  '  (4) 情報が足りず着手できないものは done にせず、メモに「■ 要確認: <聞きたいこと>」を書き、`~/.claude/next-session.md` の申し送りにも1行残す。',
].join('\n');

export function todoLines(rows, newline = '\n') {
  const lines = rows.map((row, index) => `${index + 1}. Googleタスク消化: ${String(row.title).replace(/[\r\n]+/g, ' ')}（${row.listId}/${row.taskId}）`);
  return [HOWTO.split('\n').join(newline), ...lines].join(newline);
}

// 末尾に足すと 110 件以上ある既存 TODO の後ろに並び、07:30 締切までに到達しない。
// kim の指示は「上から毎日実行」なので、先頭ブロックの ## 残TODO の直後に差し込む。
export function insertTodosAtTop(original, rows) {
  if (!rows.length) return String(original ?? '');
  const source = String(original ?? '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const first = source.indexOf(MARKER);
  if (first < 0) return appendTodoBlock(source, rows);
  const second = source.indexOf(MARKER, first + MARKER.length);
  const block = source.slice(first, second < 0 ? source.length : second);
  const heading = /^##[ \t]+残TODO.*$/m.exec(block);
  if (!heading) return appendTodoBlock(source, rows);
  const insertAt = first + heading.index + heading[0].length;
  return source.slice(0, insertAt) + newline + todoLines(rows, newline) + source.slice(insertAt);
}

function readOptional(file) { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } }

export async function plan({ count = 3, dryRun = false, stateFile = defaultStateFile(), nextFile = defaultNextSessionFile(), skipFile = defaultSkipFile(), fetchCache, now = () => new Date() } = {}) {
  let cache;
  if (fetchCache) cache = await fetchCache();
  else { const result = await executeGtasks(['list', '--refresh', '--json'], { stdout: () => {} }); cache = result.cache; }
  const rows = flattenCache(cache).rows;
  const state = readState(readOptional(stateFile));
  const picked = selectTasks(rows, state, count, readSkip(readOptional(skipFile)));
  const originalNext = readOptional(nextFile);
  const nextText = insertTodosAtTop(originalNext, picked);
  if (!dryRun && picked.length) {
    const stamp = now().toISOString();
    for (const row of picked) state.picked[row.taskId] = { title: row.title, pickedAt: stamp, status: 'picked' };
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.dirname(nextFile), { recursive: true });
    fs.writeFileSync(nextFile, nextText, 'utf8');
  }
  return { picked, text: nextText };
}

export async function execute(argv, io = {}) {
  if (argv[0] === '--reset') {
    const taskId = argv[1];
    if (!taskId) throw new Error('--reset には taskId が必要です');
    const stateFile = io.stateFile ?? defaultStateFile();
    const state = readState(readOptional(stateFile));
    delete state.picked[taskId];
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    console.log(`reset: ${taskId}`);
    return;
  }
  if (!argv.includes('--plan')) throw new Error('使い方: gtasks-loop.mjs --plan [--count 3] [--dry-run] | --reset <taskId>');
  const countIndex = argv.indexOf('--count');
  const count = countIndex < 0 ? 3 : Number(argv[countIndex + 1]);
  if (!Number.isInteger(count) || count < 1) throw new Error('--count は正の整数で指定してください');
  const result = await plan({ count, dryRun: argv.includes('--dry-run'), ...io });
  console.log(result.picked.length ? result.picked.map((row, index) => `${index + 1}. Googleタスク消化: ${row.title}（${row.listId}/${row.taskId}）`).join('\n') : '対象タスクはありません');
}

if (isEntry(import.meta.url)) {
  try { await execute(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
