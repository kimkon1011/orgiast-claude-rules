#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { findTemaRecord, temaRecordText } from './lib/tema-record-store.mjs';
import { stripHumanOnly } from './lib/handback-guard.mjs';
import { checkTema, formatTemaFindings } from './lib/tema-check.mjs';

export function extractBodyFile(input = {}) {
  const command = String(input?.tool_input?.command || input?.tool_input?.script || '');
  if (!/(?:gmail-draft[^\n]*--send|discord-dm|line-channel|line-group-send|beeper-send)/i.test(command)) return '';
  if (/fleet-mail/i.test(command)) return '';
  return command.match(/--(?:body-file|text-file|file)\s+(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i)?.slice(1).find(Boolean) || '';
}
export function evaluateTemaHook(input = {}) {
  const file = extractBodyFile(input);
  if (!file || !fs.existsSync(file)) return { decision: 'pass' };
  const text = fs.readFileSync(file, 'utf8');
  const record = findTemaRecord(stripHumanOnly(text), { home: input.home });
  const result = checkTema(record ? `${text}\n${temaRecordText(record)}` : text, { kind: 'send' });
  return result.ok ? { decision: 'pass' } : { decision: 'block', reason: formatTemaFindings(result.findings) };
}
async function main() { let raw = ''; for await (const c of process.stdin) raw += c; try { const r = evaluateTemaHook(JSON.parse(raw)); if (r.decision === 'block') console.log(JSON.stringify(r)); } catch {} }
if (isEntry(import.meta.url)) await main();
