#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { createLlmClient } from './line-digest.mjs';
import { isEntry } from './is-entry.mjs';

const BEGIN = '<!-- NEXT-ACTIONS:BEGIN -->';
const END = '<!-- NEXT-ACTIONS:END -->';
const ALLOWED_PROVIDERS = new Set(['groq', 'deepseek']);

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
}

function lastJson(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim()).slice(-200);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const value = JSON.parse(lines[i]); if (Array.isArray(value?.top)) return value; } catch {}
  }
  return null;
}

function runExec(execImpl, file, args) {
  return new Promise((resolve, reject) => {
    execImpl(file, args, { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(String(stdout || '')));
  });
}

function parseArgs(args) {
  const providerAt = args.indexOf('--provider');
  const provider = providerAt >= 0 ? args[providerAt + 1] : 'groq';
  if (!ALLOWED_PROVIDERS.has(provider)) throw new Error('--provider は groq または deepseek を指定してください');
  return { provider, dryRun: args.includes('--dry-run'), json: args.includes('--json') };
}

function parseLlmActions(raw) {
  const clean = String(raw ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const value = JSON.parse(clean);
  if (!Array.isArray(value.actions) || !value.actions.length) throw new Error('actions がありません');
  const clip = (text, length) => [...String(text ?? '').trim()].slice(0, length).join('');
  const actions = value.actions.slice(0, 3).map((item) => {
    const title = clip(item?.title, 40);
    const whyText = item?.why && String(item.why).trim() ? item.why : '優先候補として選定されたため';
    const why = clip(whyText, 60);
    const first_step = clip(item?.first_step, 80);
    const sourceText = item?.source && String(item.source).trim() ? item.source : '入力情報';
    const source = clip(sourceText, 80);
    return { title, why, first_step, source };
  });
  if (actions.some((a) => !a.title || !a.first_step)) throw new Error('title または first_step が空です');
  return actions;
}

function fallbackActions({ p1, errors, prs, todo }) {
  const suffix = '（LLM未使用・機械選択）';
  const groups = { p1: [], errors: [], prs: [], todo: [] };
  for (const task of p1) {
    groups.p1.push({
      title: String(task.title || `P1タスク ${task.id || ''}`).slice(0, 40),
      why: `P1指定のため最優先 ${suffix}`.slice(0, 60),
      first_step: `タスク ${task.id || task.title || ''} の詳細を確認する`.slice(0, 80),
      source: 'P1タスク'
    });
  }
  for (const line of errors) {
    groups.errors.push({
      title: '夜間ジョブの異常を調査',
      why: `夜間処理に異常があるため ${suffix}`.slice(0, 60),
      first_step: String(line).trim().slice(0, 80),
      source: '夜間ログ'
    });
  }
  const oldest = [...prs].filter((pr) => !pr.isDraft).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0] ||
                 [...prs].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
  if (oldest) {
    groups.prs.push({
      title: `PR#${oldest.number} ${oldest.title}`.slice(0, 40),
      why: `未処理PRで更新が最も古いため ${suffix}`.slice(0, 60),
      first_step: `gh pr view ${oldest.number} --repo kimkon1011/orgiast-claude-rules`.slice(0, 80),
      source: `PR#${oldest.number}`
    });
  }
  const todoLines = String(todo).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(?:[-*]|\d+[.)])\s+/.test(line));
  for (const line of todoLines) {
    groups.todo.push({
      title: line.replace(/^(?:[-*]|\d+[.)])\s+/, '').slice(0, 40),
      why: `残TODOとして記録されているため ${suffix}`.slice(0, 60),
      first_step: 'next-session.md の該当TODOを確認して着手する',
      source: 'TODO'
    });
  }
  const choices = [], titles = new Set();
  const add = (action) => {
    if (action && !titles.has(action.title)) {
      titles.add(action.title);
      choices.push(action);
      return true;
    }
    return false;
  };
  const keys = ['p1', 'errors', 'prs', 'todo'];
  for (const key of keys) {
    if (groups[key].length > 0) {
      add(groups[key][0]);
    }
  }
  for (const key of keys) {
    for (let i = 1; i < groups[key].length; i++) {
      if (choices.length >= 3) break;
      add(groups[key][i]);
    }
  }
  if (!choices.length) {
    add({
      title: '新しい依頼と未処理事項を確認',
      why: `入力に候補がないため ${suffix}`.slice(0, 60),
      first_step: 'PR一覧と next-session.md を確認する',
      source: 'TODO'
    });
  }
  return choices.slice(0, 3);
}

function isNightlyError(line) {
  if (line.includes('/ サマリ /') || !/(?:NG|error|失敗|fail|dead)/i.test(line)) return false;
  const withoutZeroes = line
    .replace(/error[=: ]*(?:[0-9]*0\b|-(?!\w))/gi, '')
    .replace(/失敗[:： ]*0\b/g, '')
    .replace(/fail[:：= ]*0\b/gi, '')
    .replace(/dead[:：= ]*0\b/gi, '')
    .replace(/NG[:：= ]*0\b/gi, '');
  return /(?:NG|error|失敗|fail|dead)/i.test(withoutZeroes);
}

function makePrompt(inputs) {
  return `以下のローカル情報から、明日やるべきことを優先順位順に最大3件選んでください。JSONだけを返してください。\n形式: {"actions":[{"title":"40字以内","why":"なぜ今これかを60字以内","first_step":"最初の1コマンド/1操作を80字以内","source":"PR#123|TODO|P1タスク|夜間ログ"}]}\n\n[未処理PR]\n${JSON.stringify(inputs.prs)}\n\n[残TODO]\n${inputs.todo || '(なし)'}\n\n[夜間ジョブの異常]\n${inputs.errors.join('\n') || '(なし)'}\n\n[P1タスク]\n${JSON.stringify(inputs.p1)}`;
}

export function replaceNextActionsSection(existing, body) {
  const section = `${BEGIN}\n${body.trim()}\n${END}`;
  const start = existing.indexOf(BEGIN), end = existing.indexOf(END, start + BEGIN.length);
  if (start >= 0 && end >= 0) return `${existing.slice(0, start)}${section}${existing.slice(end + END.length)}`;
  const prefix = existing.trimEnd();
  return `${prefix}${prefix ? '\n\n' : ''}${section}\n`;
}

function render(actions, now) {
  const stamp = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const items = actions.map((a, i) => `${i + 1}. ${a.title} [${a.source}]\n   - why: ${a.why}\n   - first_step: ${a.first_step}`).join('\n');
  return `## 明日の推奨アクション（${stamp}）\n\n${items}\n\nこの節は夜間に自動生成。古い場合は \`node tools/next-actions.mjs\` で再生成`;
}

export async function runNextActions(options = {}) {
  const home = options.home || os.homedir(), now = options.now instanceof Date ? options.now : (typeof options.now === 'function' ? options.now() : new Date());
  const cli = parseArgs(options.args || []), execImpl = options.execImpl || nodeExecFile;
  const base = path.join(home, '.claude'), logs = path.join(base, 'logs');
  let prs = [];
  try { const raw = await runExec(execImpl, 'gh', ['pr', 'list', '--repo', 'kimkon1011/orgiast-claude-rules', '--json', 'number,title,updatedAt,isDraft', '--limit', '30']); const parsed = JSON.parse(raw); if (Array.isArray(parsed)) prs = parsed; } catch {}
  const todo = readFile(path.join(base, 'next-session.md'));
  const day = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const errors = readFile(path.join(logs, `nightly-batch-${day}.log`)).split(/\r?\n/).filter(isNightlyError);
  const p1 = ['discord-task-digest.log', 'mail-task-digest.log'].flatMap((name) => {
    const value = lastJson(readFile(path.join(logs, name)));
    return Array.isArray(value?.top) ? value.top.filter((item) => item?.rank === 'P1') : [];
  });
  const inputs = { prs, todo, errors, p1 }, prompt = makePrompt(inputs);
  let actions, usedProvider = 'fallback', lastError;
  const llm = options.llm || createLlmClient({ home, usageFile: path.join(base, 'executor-usage.jsonl') });
  const system = '優先順位付けを行い、指定されたJSONのみを返す。';
  for (let attempt = 0; attempt < 2 && !actions; attempt++) {
    try {
      const response = await llm({ provider: cli.provider, messages: [{ role: 'system', content: attempt ? `${system} 前回の応答はJSONとして解釈できなかった。` : system }, { role: 'user', content: prompt }], responseFormat: { type: 'json_object' } });
      actions = parseLlmActions(response?.text ?? response); usedProvider = response?.provider || cli.provider;
    } catch (error) { lastError = error; }
  }
  if (!actions) {
    actions = fallbackActions(inputs);
    (options.error || console.error)(`next-actions: LLM応答をJSONとして解釈できずフォールバック: ${lastError?.message || lastError || '不明なエラー'}`);
  }
  const body = render(actions, now), outputFile = path.join(base, 'next-actions.md');
  if (!cli.dryRun) { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(outputFile, replaceNextActionsSection(readFile(outputFile), body), 'utf8'); }
  const log = options.log || console.log;
  if (cli.json) log(JSON.stringify({ actions }, null, 2));
  else if (cli.dryRun) log(body);
  log(`ok:アクション${actions.length}件 provider=${usedProvider}`);
  return { actions, provider: usedProvider, prompt, body, outputFile };
}

if (isEntry(import.meta.url)) runNextActions({ args: process.argv.slice(2) }).catch((error) => { console.error(error.message); process.exitCode = 1; });
