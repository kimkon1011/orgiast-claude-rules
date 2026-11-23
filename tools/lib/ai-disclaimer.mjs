#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from '../is-entry.mjs';

export const LINE_AI_DISCLAIMER = 'このLINEは、金の指示でAIが作成・送信しています。';
export const MAIL_AI_DISCLAIMER = 'このメールは、金の指示でAIが作成・送信しています。';
export const MESSAGE_AI_DISCLAIMER = 'このメッセージは、金の指示でAIが作成・送信しています。';

const AI_DISCLAIMER_PATTERN = /金(功勇)?(さん)?の指示で[、,\s]*AI\s*が/u;

export function hasAiDisclaimer(text) {
  return AI_DISCLAIMER_PATTERN.test(String(text ?? ''));
}

function disclaimerFor(channel) {
  if (channel === 'line') return LINE_AI_DISCLAIMER;
  if (channel === 'mail') return MAIL_AI_DISCLAIMER;
  return MESSAGE_AI_DISCLAIMER;
}

export function withAiDisclaimer(text, { channel = 'other' } = {}) {
  const source = String(text ?? '');
  if (!source.trim() || hasAiDisclaimer(source)) return source;
  const trimmed = source.trimEnd();
  const disclaimer = disclaimerFor(channel);
  if (channel !== 'mail') return `${trimmed}\n\n${disclaimer}`;

  const lines = trimmed.split(/\r?\n/u);
  const start = Math.ceil(lines.length / 2);
  const separator = /^(?:-- ?|[━─＝]{3,})\s*$/u;
  const index = lines.findLastIndex((line, i) => i >= start && separator.test(line));
  if (index < 0) return `${trimmed}\n\n${disclaimer}`;
  const before = lines.slice(0, index).join('\n').trimEnd();
  const after = lines.slice(index).join('\n');
  return `${before}\n\n${disclaimer}\n\n${after}`;
}

export function channelFromBeeperChat(chat) {
  // 全体を文字列化すると "online" 等にも当たるため、ネットワークを表す項目だけを見る。
  const c = chat ?? {};
  const fields = [c.accountID, c.network, c.networkID, c.service, c.platform].filter(v => typeof v === 'string').map(v => v.toLowerCase());
  if (fields.some(v => v.includes('discord'))) return 'discord';
  if (fields.some(v => /^line\b|^line[._:-]|\bline$/u.test(v))) return 'line';
  return 'other';
}

function parseCli(argv) {
  const args = { channel: 'other' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--channel') args.channel = argv[++i];
    else if (argv[i] === '--in') args.input = argv[++i];
    else if (argv[i] === '--out') args.output = argv[++i];
    else throw new Error(`不明な引数です: ${argv[i]}`);
  }
  if (!['line', 'mail', 'discord', 'other'].includes(args.channel) || !args.input) throw new Error('usage: ai-disclaimer.mjs --channel <line|mail|discord|other> --in <file> [--out <file>]');
  return args;
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const args = parseCli(argv);
  const read = io.readFile ?? (p => fs.readFileSync(p, 'utf8'));
  const write = io.writeFile ?? ((p, value) => fs.writeFileSync(p, value, 'utf8'));
  const stdout = io.stdout ?? (value => process.stdout.write(value));
  const result = withAiDisclaimer(read(args.input), { channel: args.channel });
  if (args.output) write(args.output, result);
  stdout(result);
  return result;
}

if (isEntry(import.meta.url)) {
  try { runCli(); }
  catch (error) { console.error(`ai-disclaimer: ${error.message}`); process.exitCode = 2; }
}
