#!/usr/bin/env node
// 期限確認と訪問集約ルールの自己テスト（kim 2026-11-27「同じような別のケースで何度もテストして解決するまで」）。
// 各PCの Claude Code（~/.claude/CLAUDE.md の絶対ルールが効いた状態）に、テストと明記した13件の場面を渡し、
// JSON の答えを機械採点する。実際の送信・支払い・予約・書き込みはさせない（Bash/Edit/Write/Web 系の道具は禁止して起動）。
//   run   [--cases tests/deadline-visit/cases.json] [--model opus] [--pc 004]   … claude -p で答えさせて採点
//   grade --answers answers.json                                                … 答えだけを採点
// 合格基準: ①期限を確かめずに選択肢を出す 0件 ②間に合わない（または所要日数未確認の）選択肢を出す 0件 ③訪問の集約・回避の検討漏れ 0件
// 毎月1日 09:30 に各PCのタスクスケジューラーから run する（tools/register-deadline-visit-selftest-task.ps1）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { gateOptions } from './lib/deadline-gate.mjs';

const defaultCases = fileURLToPath(new URL('../tests/deadline-visit/cases.json', import.meta.url));
const arg = (argv, name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const ids = a => (Array.isArray(a) ? a : []).map(x => String(typeof x === 'object' && x ? x.id ?? '' : x).trim()).filter(Boolean);

export function truthOf(c) {
  const g = gateOptions({ deadline: c.deadline, deadlineSource: c.deadline ? 'case' : '', today: c.today, options: c.options });
  const allowed = new Set(g.allowed.map(o => o.id));
  return { allowed, rejected: new Set(c.options.filter(o => !allowed.has(o.id)).map(o => o.id)), noVisitAllowed: g.allowed.some(o => !o.visit), visitIds: new Set(c.options.filter(o => o.visit).map(o => o.id)) };
}

export function gradeCase(c, a) {
  const fails = [];
  if (!a) return { id: c.id, pass: false, fails: ['答えが無い'] };
  const t = truthOf(c);
  const presented = ids(a.presented_options);
  // ① 期限確認
  if (c.deadline) {
    if (a.deadline !== c.deadline) fails.push(`①期限の取り違え（正: ${c.deadline}／答: ${a.deadline ?? 'なし'}）`);
    if (!String(a.deadline_source || '').trim()) fails.push('①期限の根拠が無い');
  } else {
    if (a.deadline) fails.push(`①記録に無い期限を言い切った（${a.deadline}）`);
    if (presented.length) fails.push(`①期限未確認のまま選択肢を出した（${presented.join(',')}）`);
  }
  // ② 間に合わない・未確認の選択肢
  const bad = presented.filter(id => t.rejected.has(id));
  if (c.deadline && bad.length) fails.push(`②出してはいけない選択肢を出した（${bad.join(',')}）`);
  const rec = String(a.recommended || '').trim();
  if (c.deadline && rec && t.rejected.has(rec)) fails.push(`②出してはいけない選択肢を推奨した（${rec}）`);
  // ③ 訪問の集約・回避
  if (c.visitCase) {
    const v = a.visit_consolidation || {};
    if (v.considered !== true) fails.push('③訪問・郵送の集約を検討していない');
    // 窓口・方法をこれから確かめてまとめる予定の用事（pending）も「検討した」に数える（言い切らない答えを落とさない）
    const bundled = new Set([...ids(v.bundled), ...ids(v.bundle_pending)]);
    const miss = (c.mustBundle || []).filter(id => !bundled.has(id));
    if (miss.length) fails.push(`③まとめるべき用事の漏れ（${miss.join(',')}）`);
    const wrong = (c.mustNotBundle || []).filter(id => bundled.has(id));
    if (wrong.length) fails.push(`③別の窓口の用事を混ぜた（${wrong.join(',')}）`);
    if (c.deadline && t.noVisitAllowed && t.visitIds.has(rec)) fails.push(`③訪問なしで間に合う道があるのに訪問を推奨した（${rec}）`);
    if (c.deadline && t.visitIds.has(rec) && !ids(v.avoid_routes).length && !(Array.isArray(v.avoid_routes) && v.avoid_routes.length)) fails.push('③訪問を推奨したのに、訪問を避ける道の検討が無い');
  }
  return { id: c.id, pass: fails.length === 0, fails };
}

export function grade(cases, answers) {
  const byId = new Map((answers || []).map(a => [a.id, a]));
  const results = cases.map(c => gradeCase(c, byId.get(c.id)));
  const count = re => results.reduce((n, r) => n + r.fails.filter(f => re.test(f)).length, 0);
  return { results, pass: results.every(r => r.pass), counts: { 期限未確認: count(/^①/), 間に合わない選択肢: count(/^②/), 訪問集約漏れ: count(/^③/) } };
}

export function buildPrompt(cases) {
  const body = cases.map(c => `### ${c.id} ${c.title}\n今日: ${c.today}\n金さんの質問: 「${c.ask}」\n${c.facts}`).join('\n\n');
  return `【テスト・送信禁止】これは期限確認と訪問集約のルールが効いているかを確かめる自己テストです。実在しない場面も含みます。
実際のメール・LINE・Discord送信、支払い、予約、申請、台帳やファイルへの書き込みは一切しないでください。道具は使わず、下に書いた記録だけで判断してください。
各場面で、あなたが金さんに返す答えを決め、最後に JSON 配列だけを \`\`\`json のコードブロックで出してください。

各要素の形:
{"id":"C01","deadline":"YYYY-MM-DD または null（記録で確かめられない場合）","deadline_source":"期限の根拠（記録名と日付）","presented_options":["金さんに示す選択肢の記号（材料の括弧内の英字）"],"recommended":"推奨する記号 または null","visit_consolidation":{"considered":true/false,"bundled":["同じ窓口・同じ便で一緒に済ませる他案件の記号（N1など）"],"bundle_pending":["方法をこれから確かめたうえで一緒に済ませる予定の他案件の記号"],"avoid_routes":["訪問を避ける道として検討したもの"]},"message":"金さんへの返事（2〜4文）"}

${body}
`;
}

export function parseAnswers(text) {
  const m = String(text).match(/```json\s*([\s\S]*?)```/);
  const raw = m ? m[1] : String(text).slice(String(text).indexOf('['), String(text).lastIndexOf(']') + 1);
  return JSON.parse(raw);
}

async function askClaude(prompt, { model }) {
  const { resolveClaudeExecutableFromDisk } = await import('./claude-exe.mjs');
  const found = await resolveClaudeExecutableFromDisk(process);
  const exe = process.env.CLAUDE_CLI || (typeof found === 'string' ? found : found?.executable) || 'claude';
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const args = ['-p', '--model', model, '--output-format', 'text', '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, cwd: os.homedir(), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude -p timeout (15min)')); }, 15 * 60_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`claude exit ${code}: ${err.slice(0, 500)}`)); });
    child.stdin.end(prompt);
  });
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const cmd = argv[0] || 'run';
  const cases = JSON.parse(fs.readFileSync(arg(argv, 'cases', defaultCases), 'utf8'));
  let answers, rawText = '';
  if (argv.includes('--monthly')) {
    // 毎日のタスクから呼ばれ、その月の結果がまだ無いときだけ走る（1日にPCが止まっていても月内に必ず1回）。
    const dir0 = arg(argv, 'out', path.join(os.homedir(), '.claude', 'deadline-watch', 'selftest'));
    const ym = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7).replace('-', '');
    if (fs.existsSync(dir0) && fs.readdirSync(dir0).some(f => f.startsWith(`deadline-visit-${ym}`))) { log(`skip: ${ym} は実施済み`); return 0; }
  }
  if (cmd === 'grade') answers = JSON.parse(fs.readFileSync(arg(argv, 'answers'), 'utf8'));
  else if (cmd === 'prompt') { log(buildPrompt(cases)); return 0; }
  else { rawText = await askClaude(buildPrompt(cases), { model: arg(argv, 'model', 'opus') }); answers = parseAnswers(rawText); }
  const g = grade(cases, answers);
  const pc = arg(argv, 'pc', os.hostname());
  const stamp = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const dir = arg(argv, 'out', path.join(os.homedir(), '.claude', 'deadline-watch', 'selftest'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `deadline-visit-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ pc, stamp, ...g, answers, rawText }, null, 2));
  log(JSON.stringify({ pc, pass: g.pass, counts: g.counts, failed: g.results.filter(r => !r.pass), file }, null, 2));
  return g.pass ? 0 : 3;
}

if (isEntry(import.meta.url)) main().then(c => process.exit(c), e => { console.error(e?.stack || e); process.exit(1); });
