#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
export function checkFleetMail({ mail, unseenHours = 24, now = Date.now(), spawnImpl = spawnSync } = {}) {
  if (!mail || !Number.isFinite(Number(unseenHours)) || Number(unseenHours) <= 0) throw new Error('--mail と正の --unseen-hours が必要です');
  const result = spawnImpl(process.execPath, [fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)), '--sent-status', mail],
    { cwd: repo, encoding: 'utf8', timeout: 200000, windowsHide: true, maxBuffer: 64 * 1024 });
  if (result.error || result.signal || result.status !== 0) throw new Error(`送信状況を取得できません: ${result.error?.message || result.stderr || result.status}`);
  const fields = Object.fromEntries(String(result.stdout || '').split(/\r?\n/).flatMap(line => {
    const m = /^([\w]+):\s*(.*)$/.exec(line);
    return m ? [[m[1], m[2] === '(なし)' ? '' : m[2]]] : [];
  }));
  const to = fields.to || fields.replyFrom || '依頼先';
  if (fields.resultAt || (fields.reply && fields.replyFrom && fields.replyCreatedAt)) return { code: 0, text: `${to} から返信あり` };
  if (!fields.status || !Number.isFinite(Date.parse(fields.createdAt))) throw new Error('送信状況に status / createdAt がありません');
  const hours = Math.max(0, (now - Date.parse(fields.createdAt)) / 3600000);
  const elapsed = hours >= 24 ? `${Math.floor(hours / 24)}日` : `${Math.floor(hours)}時間`;
  const terminal = ['expired', 'failed'].includes(fields.status);
  if (terminal || (!fields.seenAt && hours > Number(unseenHours))) {
    const state = fields.seenAt ? `開封後${elapsed}経過` : `未開封のまま${elapsed}`;
    return { code: 3, text: `${to} が${state}${terminal ? fields.status === 'expired' ? '（期限切れ）' : '（失敗）' : ''}` };
  }
  return { code: 1, text: fields.seenAt ? `${to} が対応中（開封 ${fields.seenAt}）` : `${to} が未開封 ${elapsed}` };
}
export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { mail: { type: 'string' }, 'unseen-hours': { type: 'string' } } });
  return checkFleetMail({ mail: values.mail, unseenHours: values['unseen-hours'] ?? 24 });
}
if (isEntry(import.meta.url)) {
  try { const result = main(); console.log(result.text); process.exitCode = result.code; }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
