#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLlmClient } from './line-digest.mjs';
import { isEntry } from './is-entry.mjs';
import { runTaskLedger } from './task-ledger.mjs';

const BEGIN = '<!-- NEXT-ACTIONS:BEGIN -->';
const END = '<!-- NEXT-ACTIONS:END -->';
const ALLOWED_PROVIDERS = new Set(['groq', 'deepseek']);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function landedPrNumbersFromMain(execImpl, cwd) {
  try {
    const subjects = await new Promise((resolve, reject) => {
      execImpl('git', ['log', 'origin/main', '--format=%s'], { encoding: 'utf8', cwd },
        (error, stdout) => error ? reject(error) : resolve(String(stdout || '')));
    });
    return new Set([...subjects.matchAll(/\(#(\d+)\)/g)].map((match) => Number(match[1])));
  } catch {
    return null;
  }
}

function loadSuppressRules(file) {
  try {
    const parsed = JSON.parse(readFile(file));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((rule) => {
      try {
        return typeof rule?.pattern === 'string' && typeof rule?.reason === 'string'
          ? [{ ...rule, regex: new RegExp(rule.pattern, rule.flags || 'i') }]
          : [];
      } catch { return []; }
    });
  } catch { return []; }
}

function candidateText(action) {
  return Object.values(action || {}).filter((value) => typeof value === 'string').join(' ');
}

function landedPrReferences(action) {
  const text = candidateText(action);
  const numbers = [...text.matchAll(/\bPR\s*#?\s*(\d+)/gi)].map((match) => Number(match[1]));
  if (/(?:pull request|プルリク|マージ|レビュー)/i.test(text)) {
    numbers.push(...[...text.matchAll(/#(\d+)/g)].map((match) => Number(match[1])));
  }
  return new Set(numbers);
}

/**
 * origin/main に着地済みの PR、または設定済みの抑止ルールに一致する候補を分ける。
 * landedPrNumbers が null の場合は git 照合を行わず、候補を素通しする。
 */
export function filterLandedAndSuppressed(candidates, { landedPrNumbers = null, suppressRules = [] } = {}) {
  const actions = [], excluded = [];
  for (const action of candidates) {
    const landed = landedPrNumbers && [...landedPrReferences(action)].find((number) => landedPrNumbers.has(number));
    const suppressed = suppressRules.find((rule) => {
      rule.regex.lastIndex = 0;
      return rule.regex.test(candidateText(action));
    });
    if (landed) excluded.push({ action, reason: `PR #${landed} は origin/main に着地済み` });
    else if (suppressed) excluded.push({ action, reason: suppressed.reason });
    else actions.push(action);
  }
  return { actions, excluded };
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

/**
 * アクションオブジェクトから PR 番号を抽出する。
 * 全フィールドから PR#<数字> を、first_step から gh pr <サブコマンド> <数字> を検出する。
 */
function extractPrNumbers(action) {
  const text = Object.values(action).join(' ');
  const fromPrHash = [...text.matchAll(/PR#(\d+)/g)].map((m) => Number(m[1]));
  const fromGhPr = [...(action.first_step || '').matchAll(/gh pr \w+ (\d+)/g)].map((m) => Number(m[1]));
  return new Set([...fromPrHash, ...fromGhPr]);
}

/**
 * 単一PRの状態を gh pr view で取得する。10秒でタイムアウトする。
 * @returns {Promise<string>} state（'OPEN'/'MERGED'/'CLOSED' 等）または 'FETCH_FAILED'
 */
async function prStateView(execImpl, number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const raw = await new Promise((resolve, reject) => {
      execImpl('gh', ['pr', 'view', String(number), '--repo', 'kimkon1011/orgiast-claude-rules', '--json', 'state'],
        { encoding: 'utf8', signal: controller.signal },
        (error, stdout) => error ? reject(error) : resolve(String(stdout || ''))
      );
    });
    return JSON.parse(raw)?.state;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 推奨アクションから、MERGED または CLOSED の PR を含むものを除外する。
 * PR の状態取得に失敗した場合はそのアクションを残し、理由を標準エラーへ1行出す。
 * 同じ番号への gh 呼び出しは1回だけ行う。
 */
async function filterStalePrActions(actions, execImpl, errorLog) {
  const actionNumbers = actions.map(extractPrNumbers);
  const allNumbers = new Set(actionNumbers.flatMap((numbers) => [...numbers]));
  if (!allNumbers.size) return actions;

  const states = new Map();   // number -> 'OPEN'|'MERGED'|'CLOSED'|'FETCH_FAILED'
  const fetchErrors = new Map(); // number -> error message

  for (const number of allNumbers) {
    try {
      const state = await prStateView(execImpl, number);
      states.set(number, state);
    } catch (error) {
      states.set(number, 'FETCH_FAILED');
      fetchErrors.set(number, String(error?.message || error).replace(/\s+/g, ' ').trim());
    }
  }

  const excludedNumbers = new Set();
  const result = actions.map((action, i) => {
    const numbers = [...actionNumbers[i]];
    const mergedOrClosed = numbers.filter((n) => ['MERGED', 'CLOSED'].includes(states.get(n)));

    if (mergedOrClosed.length > 0) {
      for (const n of mergedOrClosed) excludedNumbers.add(n);
      return null; // 除外
    }

    return action;
  }).filter(Boolean);

  if (fetchErrors.size) {
    const reasons = [...fetchErrors]
      .sort(([a], [b]) => a - b)
      .map(([number, reason]) => `変更依頼 #${number} の状態を確認できませんでした（${reason || '不明なエラー'}）`)
      .join(' / ');
    errorLog(`next-actions: ${reasons}`);
  }

  if (excludedNumbers.size) {
    errorLog(`next-actions: MERGED/CLOSED のPRを含む候補を${actions.length - result.length}件除外: ${[...excludedNumbers].sort((a, b) => a - b).map((n) => `PR#${n}`).join(', ')}`);
  }
  return result;
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

const BACKUP_TITLE_RE = /(?:backup|バックアップ|ClaudeDailyDriveBackup|DailyDriveBackup)/i;

/**
 * バックアップ系タスクを推奨アクションに出す前に、成果物の実在で裏取りする。
 * rclone が使えない環境では例外で落とさず「未確認」として従来どおり出す。
 */
async function filterBackupActions(actions, execImpl, log, now = new Date()) {
  const backupActions = actions.filter((a) => BACKUP_TITLE_RE.test(a.title));
  if (!backupActions.length) return actions;
  let hasRecentBackup = false;
  try {
    const raw = await runExec(execImpl, 'rclone', ['lsl', 'claude-backup:Claude-Backups']);
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    hasRecentBackup = raw.split(/\r?\n/).some((line) => line.includes(today) || line.includes(yesterday));
  } catch {
    // rclone が使えない環境では「未確認」として除外しない
    return actions;
  }
  if (hasRecentBackup) {
    const filtered = actions.filter((a) => !BACKUP_TITLE_RE.test(a.title));
    for (const a of backupActions) {
      log(`next-actions: バックアップ成功を確認したため「${a.title}」を除外`);
    }
    return filtered;
  }
  return actions;
}

const SYSTEM_PATTERNS = [
  ['backup', /(?:backup|バックアップ|rclone|ClaudeDailyDriveBackup|DailyDriveBackup)/i],
  ['mail-relay', /(?:event-shop-mail-relay|mail[ -]?relay|メール中継)/i],
  ['pr', /(?:PR\s*#?\d+|pull request|プルリク|PR(?:の|を|へ|マージ|確認))/i],
];

function systemsIn(text) {
  return new Set(SYSTEM_PATTERNS.filter(([, pattern]) => pattern.test(String(text || ''))).map(([name]) => name));
}

function windowsAbsolutePaths(text) {
  return [...String(text || '').matchAll(/[A-Za-z]:\\[^\s、。]+/g)].map((match) => match[0].replace(/[)）\]】"']+$/, ''));
}

/**
 * 推奨アクション内の対象システムの不一致と、first_step の絶対パス実在性を検算する。
 * LLM は使わず、既知システムの語彙とパスから決定的に判定する。
 */
export function verifyActionGrounding(action, options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const titleSystems = systemsIn(action?.title);
  const whySystems = systemsIn(action?.why);
  const stepSystems = systemsIn(action?.first_step);
  const tagSystems = systemsIn([action?.source, action?.tag, action?.tags].flat().filter(Boolean).join(' '));
  const issues = [];
  const intersection = (left, right) => [...left].some((value) => right.has(value));

  if (titleSystems.size && whySystems.size && !intersection(titleSystems, whySystems)) {
    issues.push(`title の対象（${[...titleSystems].join(', ')}）と why の対象（${[...whySystems].join(', ')}）が不一致`);
  }
  const statedSystems = new Set([...titleSystems, ...whySystems, ...tagSystems]);
  if (stepSystems.size && statedSystems.size && !intersection(stepSystems, statedSystems)) {
    issues.push(`first_step の対象（${[...stepSystems].join(', ')}）が title / why の対象と不一致`);
  }
  for (const absolutePath of windowsAbsolutePaths(action?.first_step)) {
    if (!existsSync(absolutePath)) issues.push(`first_step の絶対パスが存在しない: ${absolutePath}`);
  }
  return { ok: issues.length === 0, issues };
}

export function markUngroundedActions(actions, options = {}) {
  return actions.map((action) => {
    const verification = verifyActionGrounding(action, options);
    if (verification.ok) return action;
    const warning = `【裏取り未済】${verification.issues.join(' / ')}`;
    return { ...action, why: warning, first_step: warning };
  });
}

function sanitizeFirstStep(actions) {
  return actions.map((action) => {
    const step = action.first_step || '';
    const [absolutePath] = windowsAbsolutePaths(step);
    if (!absolutePath) return action;
    const segments = absolutePath.split(/[\\/]/).filter((segment) => segment && !/^[A-Za-z]:$/.test(segment));
    const title = String(action.title || '').toLowerCase();
    return segments.some((segment) => title.includes(segment.toLowerCase()))
      ? action
      : { ...action, first_step: '' };
  });
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
  const items = actions.map((a, i) => {
    const noteLine = a.note ? `\n   - note: ${a.note}` : '';
    return `${i + 1}. ${a.title} [${a.source}]\n   - why: ${a.why}\n   - first_step: ${a.first_step}${noteLine}`;
  }).join('\n');
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
  const log = options.log || console.log, errorLog = options.error || console.error;
  const landedPrNumbers = await landedPrNumbersFromMain(options.gitExecImpl || execImpl, options.cwd || REPO_ROOT);
  const suppressRules = loadSuppressRules(options.suppressFile || path.join(REPO_ROOT, 'config', 'next-actions-suppress.json'));
  const filtered = filterLandedAndSuppressed(actions, { landedPrNumbers, suppressRules });
  actions = filtered.actions;
  actions = await filterStalePrActions(actions, execImpl, errorLog);
  actions = await filterBackupActions(actions, execImpl, log, now);
  actions = sanitizeFirstStep(actions);
  // 生成結果では CI ホストに存在しない別PCの絶対パスを偽陽性にしない。
  // パス実在性が必要な呼び出し元は verifyActionGrounding の existsSync で検証する。
  actions = markUngroundedActions(actions, { existsSync: () => true });
  if (!actions.length) {
    actions = [{
      title: '新しい依頼と未処理事項を確認',
      why: '候補が処理済みだったため（LLM未使用・機械選択）',
      first_step: 'PR一覧と next-session.md を確認する',
      source: 'TODO'
    }];
  }
  const ledgerLines = ['## 別アカウント/他PCへの依頼（台帳）'];
  const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  try {
    const ledger = await (options.listLedger || runTaskLedger)({ command: 'list' }, { homeDir: home });
    if (!ledger?.ok || !Array.isArray(ledger.rows)) throw new Error('台帳の応答が不正です');
    for (const row of ledger.rows.filter((row) => ['依頼中', '対応中'].includes(row.状態))) {
      const hours = Math.max(0, Math.floor((now.getTime() - Date.parse(row.最終更新)) / 3600000));
      const elapsed = Number.isFinite(hours) ? `${Math.floor(hours / 24)}日${hours % 24}時間` : '不明';
      ledgerLines.push(`- [${oneLine(row.taskId)}] ${oneLine(row.件名)} / 担当PC: ${oneLine(row.担当PC)} / 停滞: ${elapsed} / ${oneLine(row.成果物リンク)}`);
    }
    if (ledgerLines.length === 1) ledgerLines.push('該当なし');
  } catch (error) {
    if (error.code === 'TASK_SHEET_NOT_CONFIGURED') {
      ledgerLines.push('この席は台帳未設定（~/.claude/task-sheet.env が無い）。他PCへの依頼一覧はこの席では表示しない。');
    } else {
      ledgerLines.push(`台帳取得失敗: ${oneLine(error.message)}`);
    }
  }
  const excludedLines = ['## 除外した候補（着地済み・決定済み）'];
  if (filtered.excluded.length) {
    for (const item of filtered.excluded) excludedLines.push(`- ${oneLine(item.action.title)} — ${oneLine(item.reason)}`);
  } else excludedLines.push('該当なし');
  const body = `${render(actions, now)}\n\n${ledgerLines.join('\n')}\n\n${excludedLines.join('\n')}`, outputFile = path.join(base, 'next-actions.md');
  if (!cli.dryRun) { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(outputFile, replaceNextActionsSection(readFile(outputFile), body), 'utf8'); }
  if (cli.json) log(JSON.stringify({ actions }, null, 2));
  else if (cli.dryRun) log(body);
  log(`ok:アクション${actions.length}件 provider=${usedProvider}`);
  return { actions, provider: usedProvider, prompt, body, outputFile };
}

if (isEntry(import.meta.url)) runNextActions({ args: process.argv.slice(2) }).catch((error) => { console.error(error.message); process.exitCode = 1; });
