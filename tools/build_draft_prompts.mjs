#!/usr/bin/env node
/**
 * Build proposal/estimate prompt files from notice text.
 * Usage:
 *   node tools/build_draft_prompts.mjs --date YYYY-MM-DD --job slug=file1.txt,file2.txt [--job ...]
 *   node tools/build_draft_prompts.mjs --date YYYY-MM-DD --jobs-file jobs.json
 * jobs.json: { "slug": ["01.txt", "01-a1.txt"], ... }
 * Legacy (no args): 2026-11-20 hard-coded three jobs.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function flags(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
}

const common = fs.readFileSync(path.join(root, 'prompts/03-draft-common.md'), 'utf8');
const date = flag('--date') || '2026-11-20';
const txtBase = flag('--txt-dir') || path.join(root, 'data/notices', date, 'txt');
const out = flag('--out-dir') || path.join(root, 'prompts/drafts');
fs.mkdirSync(out, { recursive: true });

let jobs = {};
const jobsFile = flag('--jobs-file');
if (jobsFile) {
  jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
} else {
  for (const raw of flags('--job')) {
    const [slug, files] = raw.split('=');
    if (!slug || !files) continue;
    jobs[slug] = files.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

if (!Object.keys(jobs).length && !args.includes('--date') && !jobsFile && !flags('--job').length) {
  jobs = {
    'kagawa-dentoukougei': ['05.txt', 'kagawa-02_shiyousyo_ido.txt', 'kagawa-03_ishihyoumeisyo_ido.txt', 'kagawa-04_douisyo_ido.txt'],
    'wakayama-police-kunren': ['02.txt'],
    'shimonoseki-kankyo-douga': ['shimonoseki-youryou.txt', 'shimonoseki-shiyousho.txt', 'shimonoseki-hyouka.txt'],
  };
}

const COMPANY = '株式会社オージャスト／〒537-0001 大阪市東成区深江北2-15-24／代表取締役 野村功勇／TEL 06-6977-5204／インボイス登録番号 T9120001143926';

for (const [slug, files] of Object.entries(jobs)) {
  const sources = files.map((f) => {
    const p = path.join(txtBase, f);
    if (!fs.existsSync(p)) throw new Error(`missing text: ${p}`);
    return `\n\n## 原文: ${f}\n\n${fs.readFileSync(p, 'utf8')}`;
  }).join('');
  const shared = `${common}\n\n# 今回の原文資料${sources}\n`;
  fs.writeFileSync(path.join(out, `${slug}.md`), shared, 'utf8');
  const proposal = `${shared}\n\n# 作成指示\n提案書をMarkdownで作成してください。公告・仕様書にない会社実績、数値、体制人数は捏造せず【要記入：…】としてください。会社情報は${COMPANY}のみ使用できます。冒頭に「下書き（未提出・社内確認用）」を記載してください。\n`;
  const estimate = `${shared}\n\n# 作成指示\n見積書をMarkdownで作成してください。宛名・件名は原文どおりにし、すべての金額行の先頭に【推計】を付けてください。上限額がある場合は超えず、税込・税抜は原文どおりにしてください。会社情報は${COMPANY}のみ使用できます。冒頭に「下書き（未提出・社内確認用）」を記載してください。\n`;
  fs.writeFileSync(path.join(out, `${slug}-proposal.md`), proposal, 'utf8');
  fs.writeFileSync(path.join(out, `${slug}-estimate.md`), estimate, 'utf8');
  console.log(`wrote prompts for ${slug} (${files.length} sources)`);
}
