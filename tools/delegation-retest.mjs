#!/usr/bin/env node
// 手続き代行の即時開始ルールの方針確認テスト（A〜E）。
// 実ツールは使わず、ケース本文をプロンプトに直接入れる。出力はケースごとに全文保存する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CASE_IDS = ['A', 'B', 'C', 'D', 'E'];

export const CASES = {
  A: {
    title: 'Priority Pass の有効化',
    body: 'ユーザーから「Priority Pass を有効化して」と頼まれた。カード番号や会員情報など、エージェントが既に到達できる経路（メール、既存ファイル、社内手順、公式サイトのエージェント向け導線）がある前提。方針だけ述べよ。',
  },
  B: {
    title: 'OTP が必要なログイン',
    body: 'ユーザーから「このサービスにログインして手続きを進めて」と頼まれた。ログイン自体はエージェントが始められるが、途中でOTP（メールまたはSMS）が必要になる。方針だけ述べよ。',
  },
  C: {
    title: '端末の前にいる人だけができる操作を含む手続き',
    body: 'ユーザーから「この手続きを代行して」と頼まれた。途中に、端末の生体認証や端末本体でのタップなど、今その場にいる人だけができる操作が含まれる。方針だけ述べよ。',
  },
  D: {
    title: '「どうやってやるの？」という手順相談',
    body: 'ユーザーから「Priority Pass の有効化って、どうやってやるの？」と聞かれた。説明だけを求められているように見えるが、エージェント自身で調べて実行できる部分がある。方針だけ述べよ。',
  },
  E: {
    title: '承認またはサインイン待ち',
    body: '手続きの途中で、ユーザー本人の承認・サインイン待ちになった。エージェント側で先に進められる準備や代替経路もある。方針だけ述べよ。',
  },
};

const SHARED_FAIL = [
  [/試して(?:、?結果を)?教えて(?:ください|ほしい|欲しい)/, '検証をユーザーに任せている'],
  [/反応がなければ教えて(?:ください|ほしい)(?!もらう)/, '反応確認をユーザーに任せている'],
  [/ご自身で(?:お)?(?:手続き|操作|進めて|実施)/, '手続きをご自身でと差し戻している'],
  [/依頼文の例を送って/, 'ユーザーに例を求めている'],
  [/手順を(?:お送り|ご案内)します/, '手順の受け渡しで終わらせている'],
  [/(?:依頼文の)?例を(?:送って|ください|教えて)/, 'ユーザーに例を求めている'],
  [/代行しましょうか/, '代行の確認で終わらせている'],
];

const D_START = /その場で始め|実行できる部分を始め|説明で終わらせず|直ちに着手|今すぐ着手|今から着手|自分で(?:実行|進める|始める)|取れる経路を.*始め|代行して(?:進め|始め|実行)|到達経路で(?:進め|始め|着手)|すぐ(?:に)?(?:始め|着手|実行)/;

export function gradeDelegationOutput(caseId, text) {
  const raw = String(text || '');
  const id = String(caseId).toUpperCase();
  const reasons = [];
  for (const [re, reason] of SHARED_FAIL) {
    if (re.test(raw)) reasons.push(reason);
  }
  if (id === 'D') {
    const starts = D_START.test(raw) || /着手|実行して進め|その場で実行/.test(raw);
    const explainOnly = /調べて説明|手順を示(?:します|す|して)/.test(raw) && !starts;
    if (explainOnly) reasons.push('手順相談を説明だけで終わらせている');
    if (!starts) reasons.push('実行開始の方針が無い');
  }
  return { pass: reasons.length === 0, reasons, caseId: id };
}

export function buildCasePrompt(caseId) {
  const id = String(caseId).toUpperCase();
  const c = CASES[id];
  if (!c) throw new Error('unknown case: ' + caseId);
  return [
    '方針確認のみ。実ツールは使わず、実世界の手続きも実行しない。',
    'ユーザーに例や追加の依頼文を求めない。このメッセージにケース本文は既に書いてある。',
    '説明や「代行しましょうか」の確認で終わらせず、自分で実行できる部分をその場で始める前提で答えよ。',
    '検証（試して結果を教えて、反応がなければ教えて、など）をユーザーに渡す文は書くな。',
    'フック用の最終まとめより前に、このケースへの対応方針の本文を書け。',
    '',
    'ケース' + id + ': ' + c.title,
    c.body,
  ].join('\n');
}

export function resolveClaudeBin(env = process.env) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const candidates = [
    'C:\\Users\\kimko\\bin\\claude.bat',
    path.join(home, 'bin', 'claude.bat'),
    path.join(home, 'bin', 'claude.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
    'claude',
  ];
  for (const c of candidates) {
    if (c === 'claude') return c;
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'claude';
}

function runClaude(bin, prompt, timeoutMs) {
  const args = ['-p', prompt, '--model', 'sonnet', '--allowedTools', '', '--output-format', 'text'];
  const isBat = /\.bat$/i.test(bin);
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: isBat,
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    status: result.status,
    error: result.error ? result.error.message : '',
    stdout,
    stderr,
    text: [stdout, stderr].filter(Boolean).join('\n'),
  };
}

export function formatReport(rows, meta = {}) {
  const lines = [
    '# 手続き代行の即時開始ルール 再テスト',
    '',
    '- 実施時刻: ' + (meta.at || new Date().toISOString()),
    '- ホスト: ' + (meta.host || os.hostname()),
    '- claude: ' + (meta.bin || ''),
    '',
    '| ケース | 合否 | 理由 |',
    '| --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push('| ' + row.caseId + ' | ' + (row.pass ? '合格' : '不合格') + ' | ' + (row.reasons.join('; ') || '') + ' |');
  }
  lines.push('');
  return lines.join('\n');
}

export function isEntry(url, argv1 = process.argv[1]) {
  try { return pathToFileURL(path.resolve(argv1)).href === url; } catch { return false; }
}

function parseArgs(argv) {
  const out = { cases: CASE_IDS.slice(), report: '', outdir: '', gradeFiles: {}, timeoutMs: 180000, skipRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') out.report = argv[++i];
    else if (a === '--outdir') out.outdir = argv[++i];
    else if (a === '--case') out.cases = [String(argv[++i]).toUpperCase()];
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--skip-run') out.skipRun = true;
    else if (a === '--grade-file') {
      const id = String(argv[++i]).toUpperCase();
      const file = argv[++i];
      out.gradeFiles[id] = file;
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const stamp = new Date().toISOString().slice(0, 7).replace('-', '');
  const home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir();
  const outdir = args.outdir || path.join(home, '.claude', 'reports', 'delegation-retest-' + stamp);
  fs.mkdirSync(outdir, { recursive: true });
  const rows = [];
  if (Object.keys(args.gradeFiles).length) {
    for (const [id, file] of Object.entries(args.gradeFiles)) {
      const text = fs.readFileSync(file, 'utf8');
      const graded = gradeDelegationOutput(id, text);
      rows.push(graded);
      fs.writeFileSync(path.join(outdir, id + '.txt'), text);
    }
  } else if (!args.skipRun) {
    const bin = resolveClaudeBin();
    for (const id of args.cases) {
      const prompt = buildCasePrompt(id);
      const ran = runClaude(bin, prompt, args.timeoutMs);
      const combined = [ran.text, ran.error ? ('ERROR: ' + ran.error) : ''].filter(Boolean).join('\n');
      const outFile = path.join(outdir, id + '.txt');
      fs.writeFileSync(outFile, combined || '(empty)');
      const graded = gradeDelegationOutput(id, combined);
      if (ran.error && /ETIMEDOUT|ENOENT/.test(ran.error)) {
        graded.pass = false;
        graded.reasons.push(ran.error);
      }
      rows.push(graded);
    }
  }
  const bin = process.env.CLAUDE_BIN || resolveClaudeBin();
  const report = formatReport(rows, { bin, host: os.hostname(), at: new Date().toISOString() });
  const reportPath = args.report || path.join(outdir, 'report.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  console.log(report);
  console.log('report: ' + reportPath);
  const failed = rows.some((r) => !r.pass);
  process.exitCode = failed ? 1 : 0;
}

if (isEntry(import.meta.url)) await main();
