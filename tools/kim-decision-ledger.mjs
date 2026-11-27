#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_LEDGER_FILE = path.join(REPO_ROOT, 'config', 'kim-decision-ledger.json');

export function loadKimDecisionLedger(file = DEFAULT_LEDGER_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
  return decisions.flatMap((item) => {
    if (!item || (item.status && String(item.status).toUpperCase() !== 'ACTIVE')) return [];
    const match = (item.match || []).flatMap((pattern) => {
      try { return [new RegExp(pattern, 'i')]; } catch { return []; }
    });
    const except = (item.except || []).flatMap((pattern) => {
      try { return [new RegExp(pattern, 'i')]; } catch { return []; }
    });
    return [{ ...item, matchRe: match, exceptRe: except }];
  });
}

export function findKimDecision(text, ledger = loadKimDecisionLedger()) {
  const hay = String(text || '');
  if (!hay.trim()) return null;
  for (const item of ledger) {
    const matched = item.matchRe.some((re) => { re.lastIndex = 0; return re.test(hay); });
    if (!matched) continue;
    const excluded = item.exceptRe.some((re) => { re.lastIndex = 0; return re.test(hay); });
    if (excluded) continue;
    if (item.doNotAsk === false) continue;
    return item;
  }
  return null;
}

/** 金さんに聞いてよいか。当たった決定があれば ask=false。 */
export function shouldAskKim(text, ledger = loadKimDecisionLedger()) {
  const hit = findKimDecision(text, ledger);
  if (!hit) return { ask: true };
  return { ask: false, id: hit.id, title: hit.title, answer: hit.answer, decidedAt: hit.decidedAt };
}

export function toNextActionSuppressRules(ledger = loadKimDecisionLedger()) {
  return ledger.filter((item) => item.doNotAsk !== false && (item.match || []).length).flatMap((item) =>
    (item.match || []).map((pattern) => ({
      pattern,
      reason: `決定台帳 ${item.id}: ${String(item.answer).split('\n')[0]}`,
    }))
  );
}

function main(args) {
  const checkAt = args.indexOf('--check');
  if (checkAt >= 0) {
    const text = args.slice(checkAt + 1).join(' ').trim();
    const result = shouldAskKim(text);
    if (result.ask) {
      console.log('ASK');
      process.exit(0);
    }
    console.log(`DO_NOT_ASK\t${result.id}\t${String(result.answer).split('\n')[0]}`);
    process.exit(0);
  }
  const ledger = loadKimDecisionLedger();
  console.log(`decisions=${ledger.length}`);
}

const entry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) main(process.argv.slice(2));
