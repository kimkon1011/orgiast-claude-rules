#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

const SHARE = /共有(?!済み|しました|されています)|権限[をの]付与|アクセス権|閲覧者|編集者として共有|\b(?:permission|share)\b/gi;
const ASK = /してください|して下さい|してもら(?:い)?|お願い|依頼|頼ん|教えて|必要です|設定が必要|お手数|(?:さん|様|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)\s*に[^。]{0,40}共有/gi;
const DONE = /共有しました|共有済み|共有されています|付与しました|実行しました/;
const matches = (re, text) => { re.lastIndex = 0; return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length })); };

export function detect(text) {
  const t = String(text || '');
  if (t.includes('[handoff-audit:') || t.includes('handoff-audit:a59ec7396063a0c4')) return false;
  if (t.includes('SA 直では quota 0 で失敗。DWD で kim を impersonate')) return false;
  if (/drive-share\.mjs[\s\S]*(?:--to|--id)/i.test(t)) return false;
  // 「共有の確認」「共有シート」等、権限付与の依頼ではない共有語を除く（2026-10-23 実測の偽陽性 34 件から抽出）。
  if (/共有(?:の)?確認|共有シート|共有モジュール|情報(?:を)?共有|共有可能|共有しました|共有済み|共有されています|共有が通|共有を実行/.test(t)) return false;
  for (const s of matches(SHARE, t)) for (const a of matches(ASK, t)) {
    const gap = Math.max(0, Math.max(s.start, a.start) - Math.min(s.end, a.end));
    if (gap > 80) continue;
    const near = t.slice(Math.max(0, Math.min(s.start, a.start) - 80), Math.max(s.end, a.end) + 80);
    if (!DONE.test(near)) return true;
  }
  return false;
}

export const CONTROLS = [
  ['P1', '人事評価集計シートと前期 backup フォルダを、furikomide-ta@freeebankde-ta.iam.gserviceaccount.com に閲覧者で共有', true],
  ['P2', 'このフォルダを SA に閲覧者で共有してください', true],
  ['P3', 'Drive の共有設定をお願いします', true],
  ['P4', 'kim さんへの依頼文: 共有はフォルダ単位で頼む', true],
  ['P5', '権限を付与してください', true],
  ['N1', '金さん（kim@orgiast.jp）は編集者として共有済みで、社内の人は閲覧できます', false],
  ['N2', 'node tools/drive-share.mjs --id abc --to a@example.com', false],
  ['N3', '[handoff-audit:a59ec7396063a0c4] Drive の共有設定（SA への権限付与） — この handoff が再発していないかを実物で検証', false],
  ['N4', 'SA 直では quota 0 で失敗。DWD で kim を impersonate（subject）して作成', false],
  ['N5', '共有フォルダの一覧を取得しました', false],
].map(([name, text, want]) => ({ name, text, want }));

export function selftest() {
  const failures = [];
  for (const c of CONTROLS) { const got = detect(c.text); if (got !== c.want) failures.push({ ...c, got }); }
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

export function scan({ home = os.homedir(), since = Date.now(), readFile = fs.readFileSync, stat = fs.statSync, readdir = fs.readdirSync } = {}) {
  const rows = [];
  const push = (src, ts, id, text) => { const t = String(text || '').replace(/[\r\n]+/g, ' ').trim(); if (detect(t)) rows.push({ src, ts, id, text: t.slice(0, 400) }); };
  const readDir = (dir) => { try { return readdir(dir, { withFileTypes: true }); } catch { return []; } };
  let ledgerTotal = 0, ledgerScanned = 0;
  try {
    for (const line of String(readFile(path.join(home, '.claude', 'handoff-audit-ledger.jsonl'), 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      ledgerTotal++; if (!(Date.parse(r.ts) >= since)) continue; ledgerScanned++;
      push('ledger', r.ts, String(r.sessionId || '').slice(0, 8), r.excerpt);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  let files = 0, filesScanned = 0, turnsScanned = 0;
  const walk = (dir) => { for (const e of readDir(dir)) {
    const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.endsWith('.jsonl')) {
      files++; let st; try { st = stat(p); } catch { continue; } if (st.mtimeMs < since) continue; filesScanned++;
      for (const line of String(readFile(p, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue; let rec; try { rec = JSON.parse(line); } catch { continue; } if (rec.isSidechain) continue;
        // 手渡しは Claude の発話だけを数える。ユーザー依頼文（旧タスクの指示）を拾わない。
        if (rec.type && rec.type !== 'assistant') continue;
        // ファイル mtime だけでなく turn 自身の時刻でも窓を切る（古い turn を含む大きいファイルの誤検出を防ぐ）。
        if (rec.timestamp && !(Date.parse(rec.timestamp) >= since)) continue;
        turnsScanned++;
        const c = rec?.message?.content; const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (text) push('transcript', rec.timestamp || new Date(st.mtimeMs).toISOString(), path.basename(p, '.jsonl').slice(0, 8), text);
      }
    }
  } };
  walk(path.join(home, '.claude', 'projects'));

  let runFiles = 0, runFilesScanned = 0;
  const runRoot = path.join(home, '.claude', 'auto-session', 'runs');
  for (const e of readDir(runRoot)) {
    if (!e.isFile() || !e.name.endsWith('.summary.md')) continue; runFiles++;
    const p = path.join(runRoot, e.name); let st; try { st = stat(p); } catch { continue; } if (st.mtimeMs < since) continue; runFilesScanned++;
    push('runs', new Date(st.mtimeMs).toISOString(), e.name.slice(0, -11), readFile(p, 'utf8'));
  }
  return { since: new Date(since).toISOString(), ledger: { total: ledgerTotal, scanned: ledgerScanned }, transcript: { files, filesScanned, turnsScanned }, runs: { files: runFiles, filesScanned: runFilesScanned }, hits: rows.length, rows };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    const r = selftest(); for (const c of CONTROLS) console.log(`${detect(c.text) === c.want ? 'ok  ' : 'FAIL'} ${c.name}  (want=${c.want} got=${detect(c.text)})`);
    console.log(`selftest: ${r.passed}/${r.total} pass`); return r.failures.length ? 1 : 0;
  }
  const i = argv.indexOf('--since'); const since = i >= 0 && argv[i + 1] ? Date.parse(argv[i + 1]) : Date.now() - 14 * 86400_000;
  console.log(JSON.stringify({ ...scan({ since }), selftest: selftest() }, null, 2)); return 0;
}
if (isEntry(import.meta.url)) process.exit(main());

