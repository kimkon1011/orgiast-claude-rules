#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { atomicJson } from './lane-doctor.mjs';

export function addCorrection(summary, { rule, detectText, detectEvidence, severity = 'block', gate = 'course-correction-gate', dir = fileURLToPath(new URL('.', import.meta.url)), now = new Date() } = {}) {
  if (!summary || !rule || !detectText || !['block', 'warn'].includes(severity)) throw new Error('指摘・規則・detect-text・有効なseverityが必要');
  new RegExp(detectText); if (detectEvidence) new RegExp(detectEvidence);
  const json = path.join(dir, 'course-corrections.json'), md = path.join(dir, 'course-corrections.md'), lock = `${json}.lock`;
  const fd = fs.openSync(lock, 'wx');
  try {
    const rules = JSON.parse(fs.readFileSync(json, 'utf8'));
    const id = `CC-${String(Math.max(0, ...rules.map(r => Number(r.id.match(/^CC-(\d+)$/)?.[1]) || 0)) + 1).padStart(3, '0')}`;
    const entry = { id, rule, detectText: [detectText], detectEvidence: detectEvidence ? [detectEvidence] : [], severity, gate, fix: rule };
    const line = v => String(v).replace(/[\r\n]+/g, ' ');
    const oldMd = fs.readFileSync(md, 'utf8');
    const addition = `\n## ${id} (${now.toISOString().slice(0, 10)}) ${line(summary)}\n\n- 指摘: ${line(summary)}\n- 規則: ${line(rule)}\n- 検出: ${line(gate)} / course-correction-gate\n- 修復: ${line(entry.fix)}\n`;
    fs.appendFileSync(md, addition);
    try { atomicJson(json, [...rules, entry]); } catch (e) { fs.writeFileSync(md, oldMd); throw e; }
    return entry;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function main(args = process.argv.slice(2)) {
  const opt = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  console.log(JSON.stringify(addCorrection(args[0], { rule: opt('--rule'), detectText: opt('--detect-text'), detectEvidence: opt('--detect-evidence'), severity: opt('--severity'), gate: opt('--gate') })));
}
if (isEntry(import.meta.url)) main();
