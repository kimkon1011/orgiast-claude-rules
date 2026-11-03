#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const detector = fileURLToPath(new URL('./daytrip-detect.mjs', import.meta.url));
export function pendingHash(items) {
  return crypto.createHash('sha256').update(JSON.stringify([...new Set(items.map(c => c.number))].sort((a, b) => a - b))).digest('hex');
}
export function buildContext(items, script = detector) {
  return `【必須】応答の冒頭で user に見える形で「🚗 日帰り出張の確認（カレンダーから自動検出）」として次の一覧を全文そのまま表示し、宿泊なし・片道50km以上・外出4時間以上の業務出張か（会食・接待のみは対象外）を「はい 1 / いいえ 2」の形で答えてもらう。user が答えたら node "${script}" --answer "<回答そのまま>" を実行し、stdout の記録内容をそのまま表示せよ。回答をコマンド引数に渡す際はシェルの特殊文字を適切にエスケープすること。user がこの件に触れずに別の話をした場合は、本題に答えたあと最後にもう一度だけ一覧を出して聞く。\n${items.map(c => c.line).join('\n')}\n距離: © OpenStreetMap contributors（概算）`;
}
export function consumePending(input, { home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now() } = {}) {
  try {
    const session = input?.session_id, event = input?.hook_event_name;
    if (typeof session !== 'string' || !session || !['SessionStart', 'UserPromptSubmit'].includes(event)) return null;
    const dir = path.join(home, '.claude', 'daytrip-detect');
    const { items } = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8'));
    if (!Array.isArray(items) || !items.length || items.some(c => !Number.isSafeInteger(c.number) || c.number <= 0 || typeof c.line !== 'string')) return null;
    const file = path.join(dir, 'shown.json');
    let previous = {};
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const shown = Object.fromEntries(Object.entries(previous).filter(([, v]) => v && Number.isFinite(v.at) && now - v.at < 30 * 86400000));
    const hash = pendingHash(items);
    if (Object.hasOwn(shown, session) && shown[session].hash === hash) return null;
    Object.defineProperty(shown, session, { value: { hash, at: now }, enumerable: true, configurable: true, writable: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(shown) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
    return { hookSpecificOutput: { hookEventName: event, additionalContext: buildContext(items) } };
  } catch { return null; }
}
export async function main() {
  try {
    const out = consumePending(JSON.parse(await readStdinWithTimeout(75)));
    if (out) console.log(JSON.stringify(out));
  } catch {}
}
if (isEntry(import.meta.url)) await main();
