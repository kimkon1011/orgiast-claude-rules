#!/usr/bin/env node
// 一回にまとめる：出す前に同じ案件・同じ相手・同じ締切の作業（直送・控え・別送・追加署名など）を全部洗い出して1回にまとめる。分けるときは理由を書く（詳細はCLAUDE.md『一回にまとめる』）
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { checkMatome, renderMatome } from './lib/matome-check-core.mjs';

const PLAN_RE = /^(?:PRINT-PLAN.*\.md|PRINT-ORDER.*\.json|PRINT-RESULT.*\.md|BODY-.*\.txt|INSTRUCTIONS.*\.md|kim-inbox-ask.*\.txt|codex-brief.*\.md|REPORT\.md)$/i;
const SKIP_DIR = /^(?:photos|preview.*|print-cache|node_modules)$/i;
const arg = (argv, name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const args = (argv, name) => argv.flatMap((v, i) => v === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []);

export function collectFiles(root, depth = 3) {
  const found = [];
  function walk(dir, level) {
    if (level > depth || !fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) { if (!SKIP_DIR.test(ent.name)) walk(path.join(dir, ent.name), level + 1); continue; }
      if (/\.(?:md|txt|json)$/i.test(ent.name)) found.push(path.join(dir, ent.name));
    }
  }
  walk(root, 0); return found;
}

export function checkDirectory(caseDir, explicitPlans = []) {
  const files = collectFiles(caseDir);
  const plans = explicitPlans.length ? explicitPlans.map(p => path.resolve(p)) : files.filter(p => PLAN_RE.test(path.basename(p)));
  const read = p => ({ name: path.relative(caseDir, p) || path.basename(p), text: fs.readFileSync(p, 'utf8') });
  return { caseDir, planPaths: plans, ...checkMatome({ sources: files.map(read), plans: plans.map(read) }) };
}

export function scanRecent(root, hours = 48, now = Date.now()) {
  if (!fs.existsSync(root)) return [];
  const cutoff = now - hours * 3600_000;
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name)).filter(dir => {
    const files = collectFiles(dir); return files.some(p => PLAN_RE.test(path.basename(p))) && Math.max(fs.statSync(dir).mtimeMs, ...files.map(p => fs.statSync(p).mtimeMs)) >= cutoff;
  }).map(dir => checkDirectory(dir));
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const cmd = argv[0] || 'check'; const json = argv.includes('--json');
  if (cmd === 'check') {
    const caseDir = path.resolve(arg(argv, 'case-dir') || '');
    if (!arg(argv, 'case-dir')) { log('--case-dir が必要です'); return 1; }
    const result = checkDirectory(caseDir, args(argv, 'plan'));
    log(json ? JSON.stringify(result, null, 2) : renderMatome(result, caseDir));
    return argv.includes('--strict') && result.warnings.length ? 3 : 0;
  }
  if (cmd === 'scan-recent') {
    const root = path.resolve(arg(argv, 'root') || '');
    if (!arg(argv, 'root')) { log('--root が必要です'); return 1; }
    const results = scanRecent(root, Number(arg(argv, 'hours') || 48));
    log(json ? JSON.stringify(results, null, 2) : (results.length ? results.map(r => renderMatome(r, r.caseDir)).join('\n\n') : '対象なし'));
    return 0;
  }
  log('usage: matome-check.mjs check --case-dir <dir> [--plan <file>] [--json] [--strict]\n       matome-check.mjs scan-recent --root <dir> [--hours 48] [--json]'); return 1;
}
if (isEntry(import.meta.url)) main().then(c => process.exit(c), e => { console.error(e?.stack || e); process.exit(1); });
