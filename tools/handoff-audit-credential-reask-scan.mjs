#!/usr/bin/env node
/**
 * handoff-audit-credential-reask-scan.mjs — 「Claude が user にクレデンシャル/識別子の値を
 * 聞き直した（規則8違反）」turn を、一次記録から数える読み取り専用ツール。
 *
 * なぜ要るか: handoff-audit の TODO `[handoff-audit:0ab11a96de53cc66] API キー/Client ID/
 * impersonate メールの復元` は「この handoff が再発していないか」を実物で検証させる。再発の有無は、
 * 台帳(handoff-audit-ledger.jsonl)と transcript(projects/**) を走査すれば資格情報なしで数えられる。
 *
 * 再発の定義: 1 turn の中で『クレデンシャル/識別子の名詞』と『user に値を出させる依頼語』が
 *             近接（±80 文字）して共起すること ＝ 規則8「クレデンシャル・ID・設定値を user に
 *             聞き直さない」の違反型。監査 TODO 文そのもの・knowledge の pattern 文は除外する
 *             （TODO は毎セッションのプロンプトに入るため、数えると自己言及で膨らむ）。
 *
 * 使い方:
 *   node tools/handoff-audit-credential-reask-scan.mjs                 # 既定窓(28日前〜現在)を走査
 *   node tools/handoff-audit-credential-reask-scan.mjs --since 2026-09-17
 *   node tools/handoff-audit-credential-reask-scan.mjs --selftest      # 陽性5件・陰性5件の対照を先に通す
 *
 * 検出力: 走査結果だけでは「0 件」が「検出できなかった」なのか「本当に無かった」なのか区別できない。
 *         報告する前に --selftest を通し、対照が全通過してから件数を書くこと。
 *
 * 限界: 判定は 1 turn 内の近接共起を要求する。turn をまたいだ聞き直しは取りこぼす。また
 *       シークレットウィンドウ(= incognito) の「シークレット」や `gh secret`、サービスアカウントの
 *       メールアドレス等、値そのものではない識別子は偽陽性になりうる（運用では人手で分類する）。
 *       0 件は「その型が無かった」であって「聞き直しが皆無だった」ではない。
 *
 * 終了コード: 0 = 走査を完走（0 件でも 0。0 は「測った 0」） / 1 = --selftest が落ちた
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

const CRED = [
  'API[\\s_-]?キー', 'API[\\s_-]?key', 'API[\\s_-]?トークン', 'Client\\s*ID', 'client_id', 'クライアント\\s*ID',
  'Client\\s*Secret', 'client_secret', 'クライアント\\s*シークレット', 'GOCSPX',
  'impersonate', 'なり代わり', 'なりすまし', 'パスワード', 'password',
  '接続文字列', 'connection[\\s_-]?string', 'SUPABASE_DB', 'db_password', 'DB\\s*URL',
  'アクセス[\\s-]?トークン', 'access[\\s_-]?token', 'refresh[\\s_-]?token', 'リフレッシュトークン',
  'シークレット', 'secret', 'サービスアカウント', 'service[\\s_-]?account', 'SA\\s*鍵', '鍵ファイル',
  '認証情報', 'credential', 'webhook[\\s_-]?URL', 'ウェブフック', 'Bot\\s*トークン', 'ボットトークン',
  'discord[\\s_-]?bot[\\s_-]?token', 'DISCORD_BOT_TOKEN', '\\.env',
].join('|');

const ASK = [
  '教えてください', '教えて下さい', '教えてもら', '教えていただけ', '教えてほしい', '教えて欲しい',
  '貼ってください', '貼り付け', 'コピペ', 'ペースト',
  '入力してください', 'ご入力', '入力いただけ', '入力してほしい',
  '送ってください', '送付してください', '送っていただけ', '送ってほしい',
  'いただけますか', 'いただけませんか', 'いただけますと', 'いただけますでしょうか', 'もらえますか',
  'ご用意', '用意してください', '設定してください', '発行してください',
  '取得してください', '共有してください', '提示してください', 'お願いします',
  'ください', '助かります', 'ほしいです',
].join('|');

const det = new RegExp(`(?:${CRED})[\\s\\S]{0,80}(?:${ASK})|(?:${ASK})[\\s\\S]{0,80}(?:${CRED})`, 'i');

/** 1 turn の本文が「クレデンシャル/識別子の値を user に聞き直した」かを判定する。 */
export function detect(text) {
  const t = String(text || '');
  if (!t) return false;
  // 監査 TODO 文そのもの（毎セッションのプロンプトに入る）と knowledge の pattern 文は再発ではない。
  if (/handoff-audit:0ab11a96de53cc66/.test(t)) return false;
  if (/API キー\/Client ID\/impersonate メールの復元/.test(t)) return false;
  return det.test(t);
}

/** 一致した部分文字列（人手分類の根拠）。 */
export function firstMatch(text) {
  const m = det.exec(String(text || ''));
  return m ? m[0] : '';
}

/** 陽性5件・陰性5件。走査の前に必ず通す。 */
export const CONTROLS = [
  { name: 'P1 API キーを教えてください', text: 'お手数ですが、対象の API キーを教えてください。', want: true },
  { name: 'P2 Client ID を貼り付け', text: 'GCP の Client ID をここに貼り付けてください。', want: true },
  { name: 'P3 impersonate メールを入力', text: 'impersonate するメールアドレスを入力してください。', want: true },
  { name: 'P4 クライアントシークレットをいただけますか', text: 'クライアント シークレットをいただけますか。', want: true },
  { name: 'P5 Webhook URL を教えていただけますか', text: '通知先の Webhook URL を教えていただけますか。', want: true },
  { name: 'N1 .env.local から復元した（依頼なし）', text: 'API キーは .env.local から復元しました。追加作業はありません。', want: false },
  { name: 'N2 値の報告のみ（依頼なし）', text: 'SUPABASE_DB_URL は解決済みで、接続も確認済みです。', want: false },
  { name: 'N3 GitHub device flow（他ベンダー・正当）', text: 'コード EAE7-10E5 を https://github.com/login/device に貼り付けて承認してください。', want: false },
  { name: 'N4 パスワード変更の報告', text: 'パスワードをローテーションしました。', want: false },
  { name: 'N5 既存キーを流用（再取得しない）', text: 'API キーは既存の .env.local のものを流用しました。再取得は不要です。', want: false },
];

export function selftest() {
  const failures = [];
  for (const c of CONTROLS) {
    const got = detect(c.text);
    if (got !== c.want) failures.push({ ...c, got });
  }
  return { total: CONTROLS.length, passed: CONTROLS.length - failures.length, failures };
}

/** 台帳(`handoff-audit-ledger.jsonl`)と transcript(`projects/**`)を走査する。 */
export function scan({ home = os.homedir(), since = Date.now(), readFile = fs.readFileSync, stat = fs.statSync, readdir = fs.readdirSync, roots = ['projects'] } = {}) {
  const rows = [];
  const push = (src, ts, id, text) => {
    if (!(Date.parse(ts) >= since)) return; // turn の時刻で窓を判定（ファイル mtime の混入を防ぐ）
    const t = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!detect(t)) return;
    rows.push({ src, ts, id, match: firstMatch(t).slice(0, 200), text: t.slice(0, 320) });
  };

  const ledgerFile = path.join(home, '.claude', 'handoff-audit-ledger.jsonl');
  let ledgerTotal = 0, ledgerScanned = 0;
  try {
    for (const line of String(readFile(ledgerFile, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      ledgerTotal++;
      if (!(Date.parse(r.ts) >= since)) continue;
      ledgerScanned++;
      push('ledger', r.ts, String(r.sessionId || '').slice(0, 8), r.excerpt);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  let files = 0, filesScanned = 0, turnsScanned = 0;
  const readdirSafe = (dir) => { try { return readdir(dir, { withFileTypes: true }); } catch { return []; } };
  const walk = (dir) => {
    for (const e of readdirSafe(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      files++;
      let st; try { st = stat(p); } catch { continue; }
      if (st.mtimeMs < since) continue;
      filesScanned++;
      for (const line of String(readFile(p, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.isSidechain) continue;
        const role = rec?.message?.role || rec?.type;
        if (role && role !== 'assistant') continue; // 依頼する側＝assistant のみ
        turnsScanned++;
        const c = rec?.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c)
          ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (!text) continue;
        push('transcript', rec.timestamp || new Date(st.mtimeMs).toISOString(), path.basename(p, '.jsonl').slice(0, 8), text);
      }
    }
  };
  for (const r of roots) walk(path.join(home, '.claude', r));
  return { since: new Date(since).toISOString(), ledger: { total: ledgerTotal, scanned: ledgerScanned }, transcript: { files, filesScanned, turnsScanned }, hits: rows.length, rows };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    for (const c of CONTROLS) console.log(`${detect(c.text) === c.want ? 'ok  ' : 'FAIL'} ${c.name}  (want=${c.want} got=${detect(c.text)})`);
    const r = selftest();
    console.log(`selftest: ${r.passed}/${r.total} pass`);
    return r.failures.length ? 1 : 0;
  }
  const i = argv.indexOf('--since');
  const since = i >= 0 && argv[i + 1] ? Date.parse(argv[i + 1]) : Date.now() - 28 * 86400_000;
  console.log(JSON.stringify({ ...scan({ since }), selftest: selftest() }, null, 2));
  return 0;
}

if (isEntry(import.meta.url)) process.exit(main());
