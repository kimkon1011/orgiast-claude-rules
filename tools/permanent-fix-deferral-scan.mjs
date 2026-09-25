#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const P1 = /(恒久|改修|実装|修正|対応|恒久化)[^」"'\n]{0,60}(次セッション|次回セッション|次回に|後日|来週|先送り)/;
const P2 = /(次セッション|次回セッション|次回に|後日)[^」"'\n]{0,60}(実装|対応|修正|改修|恒久)/;
const W  = /(数分|しばらく|少し|少々)[^」"'\n]{0,20}(お?待ち|待って)|完了を?待って|完了待ちで/;
const FIX = '実装|修正|改修|恒久|恒久化|修復|作り直';
const HANDOFF_LINE = /次に\s*kim\s*がすること[:：][ \t]*([^\r\n]*)/;
const HANDOFF_EMPTY = /^(なし|ありません|ありません。|特になし|無し)/;
const ASK_PERMISSION = /(やりますか|進めますか|進めてよいか|よろしいですか|可否|判断してください|決めてください|選んでください)/;
const ASK_CONTEXT = /(恒久|配布|自動修復|実装|修正|改修|恒久化)/;
const P3 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(HANDOFF_LINE, 'g'))) {
      if (!HANDOFF_EMPTY.test(match[1]) && new RegExp(FIX).test(match[1])) return match;
    }
    return null;
  }
};
const P4 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(ASK_PERMISSION, 'g'))) {
      const context = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60);
      if (ASK_CONTEXT.test(context)) return match;
    }
    return null;
  }
};
export const PATTERNS = { P1, P2, P3, P4, W };

export function detect(text) {
  return Object.entries(PATTERNS).map(([pattern, regex]) => {
    const match = typeof regex.find === 'function' ? regex.find(text) : regex.exec(text);
    return match ? { pattern, match } : null;
  }).filter(Boolean).sort((a, b) => a.match.index - b.match.index);
}

const DEFAULT_SINCE = '1970-01-01T00:00:00Z';
const NAMES = ['stop-gate-runner-ledger.jsonl', 'handoff-audit-ledger.jsonl', 'handoff-audit-nightly-ledger.jsonl'];

export function scan({ home = os.homedir(), since = DEFAULT_SINCE } = {}) {
  const sources = NAMES.map((name, index) => {
    const file = path.join(home, '.claude', name);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const rows = [], counts = {};
    const byPattern = Object.fromEntries(Object.keys(PATTERNS).map(pattern => [pattern, 0]));
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || !(Date.parse(entry.ts) >= Date.parse(since))) continue;
      const text = index === 0 ? String(entry.excerpt ?? '')
        : (Array.isArray(entry.violations) ? entry.violations : []).map(v => v?.quote ?? '').join(' ~ ');
      const found = detect(text)[0];
      if (!found) continue;
      const { pattern, match } = found;
      byPattern[pattern]++;
      const day = new Date(entry.ts).toISOString().slice(0, 10);
      counts[day] = (counts[day] || 0) + 1;
      rows.push({ pattern, ts: entry.ts, verdict: entry.verdict ?? entry.decision ?? '', sessionId: String(entry.sessionId ?? ''),
        match: text.slice(Math.max(0, match.index - 45), match.index + match[0].length + 110).replace(/[\r\n]+/g, ' ') });
    }
    return { name, file, total: lines.length, hits: rows.length, byPattern, byDay: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), rows };
  });
  return { since, sources };
}

function validIso(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value.slice(0, 10);
}
export function main(args = process.argv.slice(2)) {
  let since = DEFAULT_SINCE, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--since' && validIso(args[i + 1] ?? '')) since = args[++i];
    else {
      console.error('Usage: node tools/permanent-fix-deferral-scan.mjs [--since <ISO>] [--json]');
      return 2;
    }
  }
  try {
    const report = scan({ since });
    if (json) console.log(JSON.stringify(report, null, 2));
    else for (const source of report.sources) {
      console.log(`${source.name}: hits=${source.hits} / ${source.total}`);
      console.log(Object.entries(source.byPattern).map(([pattern, count]) => `${pattern}:${count}`).join(' '));
      console.log(Object.entries(source.byDay).map(([day, count]) => `${day}:${count}`).join(' '));
      for (const row of source.rows) console.log(`${row.ts} ${row.verdict} ${row.sessionId.slice(0, 8)}  …${row.match}…`);
    }
  } catch (error) { console.error(`permanent-fix-deferral-scan: ${error.message}`); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = main();
