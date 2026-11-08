#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { atomicJson } from './lane-doctor.mjs';

export function addCorrection(summary, { extra = {}, rule, detectText, detectEvidence, requireEvidenceTools, excludeText, fix, severity = 'block', gate = 'course-correction-gate', dir = fileURLToPath(new URL('.', import.meta.url)), now = new Date() } = {}) {
  if (!summary || !rule || !detectText || !['block', 'warn'].includes(severity)) throw new Error('指摘・規則・detect-text・有効なseverityが必要');
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('extra must be a JSON object');
  const reserved = ['id', 'rule', 'detectText', 'detectEvidence', 'severity', 'gate', 'fix', 'requireEvidenceTools', 'excludeText'];
  if (reserved.some(key => Object.hasOwn(extra, key))) throw new Error('extra must not override rule fields');
  new RegExp(detectText); if (detectEvidence) new RegExp(detectEvidence);
  for (const patterns of [requireEvidenceTools, excludeText]) {
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string' || !p)) throw new Error('patterns must be an array of non-empty strings');
    for (const pattern of patterns) new RegExp(pattern);
  }
  const json = path.join(dir, 'course-corrections.json'), md = path.join(dir, 'course-corrections.md'), lock = `${json}.lock`;
  const fd = fs.openSync(lock, 'wx');
  try {
    const rules = JSON.parse(fs.readFileSync(json, 'utf8'));
    const id = `CC-${String(Math.max(0, ...rules.map(r => Number(r.id.match(/^CC-(\d+)$/)?.[1]) || 0)) + 1).padStart(3, '0')}`;
    const entry = { ...extra, id, rule, detectText: [detectText], detectEvidence: detectEvidence ? [detectEvidence] : [], severity, gate, fix: fix ?? rule, ...(requireEvidenceTools === undefined ? {} : { requireEvidenceTools }), ...(excludeText === undefined ? {} : { excludeText }) };
    const line = v => String(v).replace(/[\r\n]+/g, ' ');
    const oldMd = fs.readFileSync(md, 'utf8');
    const addition = `\n## ${id} (${now.toISOString().slice(0, 10)}) ${line(summary)}\n\n- 指摘: ${line(summary)}\n- 規則: ${line(rule)}\n- 検出: ${line(gate === 'course-correction-gate' ? gate : `${gate} / course-correction-gate`)}\n- 修復: ${line(entry.fix)}\n`;
    fs.appendFileSync(md, addition);
    try { atomicJson(json, [...rules, entry]); } catch (e) { fs.writeFileSync(md, oldMd); throw e; }
    return entry;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function main(args = process.argv.slice(2), { dir } = {}) {
  const opt = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  console.log(JSON.stringify(addCorrection(args[0], { dir, extra: opt('--extra') === undefined ? undefined : JSON.parse(opt('--extra')), rule: opt('--rule'), detectText: opt('--detect-text'), detectEvidence: opt('--detect-evidence'), severity: opt('--severity'), gate: opt('--gate'), fix: opt('--fix'), requireEvidenceTools: opt('--require-evidence-tools') === undefined ? undefined : JSON.parse(opt('--require-evidence-tools')), excludeText: opt('--exclude-text') === undefined ? undefined : JSON.parse(opt('--exclude-text')) })));
}
if (isEntry(import.meta.url)) main();
