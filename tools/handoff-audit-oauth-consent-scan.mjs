#!/usr/bin/env node
/**
 * handoff-audit-oauth-consent-scan.mjs — 「Google プロパティ(GA4 / Search Console / GTM)の読み取りを
 * **user の OAuth 初回同意に依存させて手渡した** turn」を、一次記録から数える読み取り専用ツール。
 *
 * なぜ要るか: handoff-audit の DWD 経路（tools/google-property-check.mjs）は **SA 鍵のある PC でしか
 * 動かない**。鍵の無い PC では「未確認」で終わり、再発の有無を言えないまま終わる。再発の有無は
 * 資格情報と無関係に、台帳と transcript を走査すれば数えられる。このツールはその走査を 1 コマンドに固定する。
 *
 * 再発の定義: 1 turn の中に『Google プロパティ語』と『OAuth 同意語』が共起し、かつ
 *             『他ベンダー語』が無いこと。他ベンダー（GitHub device flow / codex login / Airbnb 等）の
 *             OAuth 同意は DWD では代替できない＝正当な手渡しなので対象外にする。
 *
 * 使い方:
 *   node tools/handoff-audit-oauth-consent-scan.mjs                 # 既定窓(14日前〜現在)を走査して JSON
 *   node tools/handoff-audit-oauth-consent-scan.mjs --since 2026-09-20
 *   node tools/handoff-audit-oauth-consent-scan.mjs --selftest      # 陽性2件・陰性3件の対照を先に通す
 *
 * 検出力: 走査結果だけでは「0 件」が「検出できなかった」なのか「本当に無かった」なのか区別できない。
 *         報告する前に --selftest を通し、対照が全通過してから件数を書くこと。
 *
 * 限界: 判定は 1 turn 内の共起を要求する。turn をまたいだ手渡し（片方の turn で「OAuth が要る」、
 *       もう片方で「GA4 を読みたい」）は取りこぼす。0 件は「その型が無かった」であって
 *       「手渡しが皆無だった」ではない。
 *
 * 終了コード: 0 = 走査を完走（0 件でも 0。0 は「測った 0」） / 1 = --selftest が落ちた
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

const googleProp = /(GA4|Google\s*Analytics|アナリティクス|Search\s*Console|サーチコンソール|SearchConsole|Tag\s*Manager|タグマネージャ|GTM|analyticsadmin|tagmanager)/i;
const oauthAsk = /(OAuth|オーオース|初回同意|同意画面|consent|認可|アクセスを許可|権限を許可|再認可|re-?auth|連携を?許可|承認してください|許可してください)/i;
// 他ベンダーの OAuth は対象外（DWD では代替できない＝正当な手渡し）。
const otherVendor = /(github|GitHub|codex|OpenAI|ChatGPT|VS\s*Code|VSCode|Airbnb|Booking\.com|Agoda|Beds24|Canva|Figma|Slack|Discord|claude\.ai)/;

/** 1 turn の本文が「Google プロパティの読み取りを user の OAuth 同意に依存させた handoff」かを判定する。 */
export function detect(text) {
  const t = String(text || '');
  if (!googleProp.test(t)) return false;
  if (!oauthAsk.test(t)) return false;
  if (otherVendor.test(t)) return false;
  return true;
}

/** 陽性対照2件・陰性対照3件。走査の前に必ず通す。 */
export const CONTROLS = [
  { name: 'P1 GA4 の同意を依頼', text: 'GA4 のプロパティを見るには OAuth の初回同意が必要です。ブラウザで承認してください。', want: true },
  { name: 'P2 Search Console を開いて許可して', text: 'Search Console のデータが読めないので、その画面でアクセスを許可してください。', want: true },
  { name: 'N1 GitHub device flow', text: 'コード EAE7-10E5 を https://github.com/login/device に入力して承認してください。', want: false },
  { name: 'N2 codex login', text: 'https://auth.openai.com/oauth/authorize?... を開いて ChatGPT にサインインしてください。', want: false },
  { name: 'N3 GA4 の数値報告（手渡し無し）', text: 'GA4 の 直近7日 のセッションは 1,234 でした。', want: false },
];

export function selftest() {
  const failures = [];
  for (const c of CONTROLS) {
    const got = detect(c.text);
    if (got !== c.want) failures.push({ ...c, got });
  }
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

/** 台帳(`handoff-audit-ledger.jsonl`)と transcript(`projects/<proj>/*.jsonl`)を走査する。 */
export function scan({ home = os.homedir(), since = Date.now() , readFile = fs.readFileSync, stat = fs.statSync, readdir = fs.readdirSync } = {}) {
  const rows = [];
  const push = (src, ts, id, text) => {
    const t = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!detect(t)) return;
    // 監査 TODO 文そのもの（TODO を持つセッションのプロンプトに入る）は再発ではない。
    if (/handoff-audit:8c97bb8b5e2e2968/.test(t)) return;
    rows.push({ src, ts, id, text: t.slice(0, 400) });
  };

  const ledgerFile = path.join(home, '.claude', 'handoff-audit-ledger.jsonl');
  let ledgerTotal = 0, ledgerScanned = 0;
  try {
    for (const line of String(readFile(ledgerFile, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      ledgerTotal++;
      if (!(Date.parse(r.ts) >= since)) continue;
      ledgerScanned++;
      push('ledger', r.ts, String(r.sessionId || '').slice(0, 8), r.excerpt);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const projRoot = path.join(home, '.claude', 'projects');
  let files = 0, filesScanned = 0, turnsScanned = 0;
  const readdirSafe = (dir) => { try { return readdir(dir, { withFileTypes: true }); } catch { return []; } };
  const walk = (dir) => {
    for (const e of readdirSafe(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        files++;
        let st;
        try { st = stat(p); } catch { continue; }
        if (st.mtimeMs < since) continue;
        filesScanned++;
        for (const line of String(readFile(p, 'utf8')).split(/\r?\n/)) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          if (rec.isSidechain) continue;
          turnsScanned++;
          const c = rec?.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c)
            ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
            : '';
          if (!text) continue;
          push('transcript', rec.timestamp || new Date(st.mtimeMs).toISOString(), path.basename(p, '.jsonl').slice(0, 8), text);
        }
      }
    }
  };
  walk(projRoot);

  return { since: new Date(since).toISOString(), ledger: { total: ledgerTotal, scanned: ledgerScanned }, transcript: { files, filesScanned, turnsScanned }, hits: rows.length, rows };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    const r = selftest();
    for (const c of CONTROLS) console.log(`${detect(c.text) === c.want ? 'ok  ' : 'FAIL'} ${c.name}  (want=${c.want} got=${detect(c.text)})`);
    console.log(`selftest: ${r.passed}/${r.total} pass`);
    return r.failures.length ? 1 : 0;
  }
  const i = argv.indexOf('--since');
  const since = i >= 0 && argv[i + 1] ? Date.parse(argv[i + 1]) : Date.now() - 14 * 86400_000;
  const report = scan({ since });
  console.log(JSON.stringify({ ...report, selftest: selftest() }, null, 2));
  return 0;
}

if (isEntry(import.meta.url)) process.exit(main());
