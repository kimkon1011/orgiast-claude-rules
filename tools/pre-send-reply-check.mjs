#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { checkPreSendReply, normalizeHistory, collectBeeperContext } from './lib/pre-send-reply-check.mjs';
import { writePreSendPass } from './lib/pre-send-marker.mjs';

export async function main(argv = process.argv.slice(2), deps = {}) {
  const val = flag => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const channel = val('--channel'), target = val('--chat') || val('--target'), file = val('--text-file');
  if (!['beeper','line','discord','gmail'].includes(channel) || !target || !file) throw new Error('--channel、--chat、--text-file が必要です');
  const draft = fs.readFileSync(file, 'utf8'), now = val('--now') ?? deps.now ?? Date.now();
  if (!Number.isFinite(new Date(now).getTime())) throw new Error('--now は有効なISO日時を指定してください');
  const windowHours = Number(val('--window-hours') || 24);
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error('--window-hours は正の数を指定してください');
  const imageNotes = val('--image-notes') ? JSON.parse(fs.readFileSync(val('--image-notes'), 'utf8')) : {};
  let messages;
  if (channel === 'beeper') messages = await (deps.collectBeeperContext || collectBeeperContext)({ chatID: target, now, windowHours: Number(val('--window-hours') || 24), api: deps.api, saveDir: val('--save-dir'), imageNotes });
  else {
    const { fetchHistory } = await import('./send-context-check.mjs');
    const history = await (deps.fetchHistory || fetchHistory)(channel, target, { home: deps.home, readOnly: true });
    messages = normalizeHistory(history.messages, { chatID: history.target });
    messages = messages.map(m => ({ ...m, attachments: m.attachments.map((a, i) => ({ ...a, description: imageNotes[`${m.id}:${i}`] ?? imageNotes[m.id] ?? a.description })) }));
  }
  const result = checkPreSendReply({ draft, messages, now, windowHours });
  if (result.ok && argv.includes('--write-pass') && channel === 'beeper') writePreSendPass({ chatID: target, text: draft, home: deps.home, now });
  (deps.stdout || console.log)(argv.includes('--json') ? JSON.stringify(result) : result.ok ? '送信前照合: 合格' : result.findings.map(f => `${f.code}: ${f.sentence}\n${f.fix}`).join('\n'));
  return result.ok ? 0 : 2;
}
if (isEntry(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
