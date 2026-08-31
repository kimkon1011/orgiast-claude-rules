#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const QUESTIONS = [
  { group: 'A', q: 'ESM のツールで自ファイルの場所を基準に相対パスを組むとき、Windows で踏む罠は何？', kw: ['fileURLToPath', 'C:\\C:', 'pathname'] },
  { group: 'A', q: 'GAS の google.script.run で Date 型を返すとどうなる？', kw: ['返せない', 'Date を返', 'null', 'シリアライズ'] },
  { group: 'A', q: '展示会ブースの壁面で寸法に端数が出たとき、どうやって埋める？', kw: ['防炎', '白布', '白い布'] },
  { group: 'A', q: '懇親会費を見積もるときの決まりは？', kw: ['20%', '2割', 'バッファ'] },
  { group: 'A', q: '自社や取引先の Wikipedia 記事に自社サイトへのリンクを足してもいい？', kw: ['足さない', '追加しない', 'COI', '利益相反'] },
  { group: 'A', q: '外部の人に URL を渡した Google Docs を整理したいとき、やってはいけないことは？', kw: ['trash', 'ゴミ箱', '削除しない'] },
  { group: 'B', q: 'Claude Code が exit 3221226505 (0xC0000409) で落ちる。原因は何？', kw: ['コミット', 'commit', 'ページファイル', 'メモリ', 'Windows'] },
  { group: 'B', q: 'GitHub Actions で、後続のステップが実行されずに素通りしてしまうのはなぜ？', kw: ['silent skip', '前のステップ', '失敗', 'スキップ'] },
  { group: 'B', q: 'PowerShell や C# の System.Windows.Forms.Screen でスクリーンショットを撮るとき注意する点は？', kw: ['DPI', 'スケーリング', '解像度'] },
  { group: 'B', q: 'GAS でスプレッドシートに貼り付けた画像を読み取れる？', kw: ['getBlob', 'OverGridImage', '読めない', '取得できない'] },
  { group: 'B', q: 'pull_request の GitHub Actions ワークフローは、どちらのブランチのファイルが使われる？', kw: ['base', 'ベース', 'マージ先'] },
  { group: 'B', q: '中継キューに、どうやっても解決できないアイテムが1件あるとどうなる？', kw: ['リトライ', '毎晩', '打ち切り', '無限'] },
];

const TIMEOUT_MS = 180_000;
const CONCURRENCY = 4;
const SOURCE_PROJECT_ID = 'c--Users-uers-Downloads-CLAUDE-md--';
const V1_NAME = 'MEMORY.md.bak-20260830-194304';

function projectId(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/gu, '-');
}

function atomicWriteJson(filename, value) {
  const temporary = `${filename}.memory-index-ab-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filename);
}

function copyMemoryBodies(source, destination) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md' || entry.name.startsWith('MEMORY.md.bak')) continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

function setupVariant(source, cwd, memoryRoot, variant) {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(memoryRoot, { recursive: true });
  copyMemoryBodies(source, memoryRoot);
  fs.copyFileSync(path.join(source, variant === 'v1' ? V1_NAME : 'MEMORY.md'), path.join(memoryRoot, 'MEMORY.md'));
  if (variant === 'v2') fs.cpSync(path.join(source, 'index'), path.join(memoryRoot, 'index'), { recursive: true });
}

function usageTokens(json) {
  const usage = json?.usage || {};
  return {
    input: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0),
    output: Number(usage.output_tokens) || 0,
  };
}

function runClaude(executable, cwd, question) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(executable, ['-p', question, '--model', 'sonnet', '--output-format', 'json'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.unref();
      } else child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message, timedOut, ms: Date.now() - started, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ error: '180秒でタイムアウト', timedOut: true, ms: Date.now() - started, stdout, stderr });
      if (code !== 0) return resolve({ error: `claude 終了コード ${code}${signal ? ` (${signal})` : ''}`, timedOut: false, ms: Date.now() - started, stdout, stderr });
      try {
        const json = JSON.parse(stdout.trim());
        const text = typeof json.result === 'string' ? json.result : typeof json.text === 'string' ? json.text : '';
        const tokens = usageTokens(json);
        resolve({ text, inputTokens: tokens.input, outputTokens: tokens.output, ms: Number(json.duration_ms) || Date.now() - started, raw: json, stderr });
      } catch (error) {
        resolve({ error: `JSON解析失敗: ${error.message}`, timedOut: false, ms: Date.now() - started, stdout, stderr });
      }
    });
  });
}

async function removeWithRetries(target, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function rate(rows, variant, group) {
  const selected = rows.filter((row) => !group || row.group === group);
  const successes = selected.filter((row) => row[variant].recalled).length;
  return { successes, total: selected.length, percent: selected.length ? successes / selected.length * 100 : 0 };
}

function average(rows, variant, field) {
  const values = rows.map((row) => row[variant][field]).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function indexReadMeasurement(rows) {
  const evidence = rows.filter((row) => {
    const serialized = JSON.stringify(row.v2.raw || {});
    return /index[\\/][^"\\/]+\.md/i.test(serialized) && /(?:Read|tool_use|tool_result)/i.test(serialized);
  }).length;
  const traceAvailable = rows.some((row) => /tool_use|tool_result/i.test(JSON.stringify(row.v2.raw || {})));
  return traceAvailable
    ? { status: '計測済み', count: evidence, total: rows.length }
    : { status: '計測不能', count: null, total: rows.length, reason: '--output-format json の結果にツール使用履歴が含まれないため' };
}

function summarize(rows, metadata) {
  const groups = {};
  for (const group of ['A', 'B', 'all']) groups[group] = { v1: rate(rows, 'v1', group === 'all' ? null : group), v2: rate(rows, 'v2', group === 'all' ? null : group) };
  const v1Average = average(rows, 'v1', 'inputTokens');
  const v2Average = average(rows, 'v2', 'inputTokens');
  return {
    metadata,
    rows,
    recall: groups,
    averageInputTokens: {
      v1: v1Average,
      v2: v2Average,
      v1Samples: rows.filter((row) => Number.isFinite(row.v1.inputTokens)).length,
      v2Samples: rows.filter((row) => Number.isFinite(row.v2.inputTokens)).length,
      differenceV2MinusV1: v1Average === null || v2Average === null ? null : v2Average - v1Average,
    },
    v2IndexReads: indexReadMeasurement(rows),
    failures: rows.flatMap((row) => ['v1', 'v2'].filter((variant) => row[variant].error).map((variant) => ({ variant, group: row.group, question: row.question, error: row[variant].error }))),
  };
}

function mark(result, variant) {
  return result[variant].recalled ? '○' : '×';
}

function token(result, variant) {
  return Number.isFinite(result[variant].inputTokens) ? String(result[variant].inputTokens) : '-';
}

function printHuman(summary) {
  console.log('群 | 質問(先頭20字) | v1想起 | v2想起 | v1入力tok | v2入力tok');
  console.log('---|---|---|---|---:|---:');
  for (const row of summary.rows) console.log(`${row.group} | ${[...row.question].slice(0, 20).join('')} | ${mark(row, 'v1')} | ${mark(row, 'v2')} | ${token(row, 'v1')} | ${token(row, 'v2')}`);
  console.log('\n想起成功率');
  for (const group of ['A', 'B', 'all']) {
    const label = group === 'all' ? '全体' : `群${group}`;
    const value = summary.recall[group];
    console.log(`${label}: v1 ${value.v1.successes}/${value.v1.total} (${value.v1.percent.toFixed(1)}%) / v2 ${value.v2.successes}/${value.v2.total} (${value.v2.percent.toFixed(1)}%)`);
  }
  const average = summary.averageInputTokens;
  const display = (value) => value === null ? '計測不能' : value.toFixed(1);
  console.log(`\n1セッションあたり平均入力トークン（取得成功分）: v1 ${display(average.v1)} (${average.v1Samples}件) / v2 ${display(average.v2)} (${average.v2Samples}件) / 差分(v2-v1) ${display(average.differenceV2MinusV1)}`);
  const reads = summary.v2IndexReads;
  console.log(`v2 サブ索引 Read: ${reads.status === '計測済み' ? `${reads.count}/${reads.total}件` : `${reads.status}（${reads.reason}）`}`);
  console.log(`失敗: ${summary.failures.length}件`);
  for (const failure of summary.failures) console.log(`- ${failure.variant} / 群${failure.group} / ${failure.question}: ${failure.error}`);
}

function findClaude(home) {
  const candidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude.cmd')]
    : [path.join(home, '.local', 'bin', 'claude'), 'claude'];
  return candidates.find((candidate) => candidate === 'claude' || fs.existsSync(candidate)) || candidates[0];
}

export async function main(argv = process.argv.slice(2)) {
  const jsonOutput = argv.includes('--json');
  const home = os.homedir();
  const configPath = path.join(home, '.claude.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`~/.claude.json を読めないため中止: ${error.message}`); }
  const source = path.join(home, '.claude', 'projects', SOURCE_PROJECT_ID, 'memory');
  const required = [path.join(source, 'MEMORY.md'), path.join(source, V1_NAME), path.join(source, 'index')];
  for (const filename of required) if (!fs.existsSync(filename)) throw new Error(`必要な入力がありません: ${filename}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-ab-'));
  const variants = Object.fromEntries(['v1', 'v2'].map((name) => {
    const cwd = path.join(tempRoot, `ab-${name}`);
    const id = projectId(cwd);
    return [name, { cwd, id, memory: path.join(home, '.claude', 'projects', id, 'memory') }];
  }));
  const previousProjects = {};
  try {
    for (const [name, variant] of Object.entries(variants)) setupVariant(source, variant.cwd, variant.memory, name);
    const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    current.projects ||= {};
    for (const variant of Object.values(variants)) {
      previousProjects[variant.cwd] = Object.hasOwn(current.projects, variant.cwd) ? current.projects[variant.cwd] : undefined;
      current.projects[variant.cwd] = { ...(current.projects[variant.cwd] || {}), hasTrustDialogAccepted: true };
    }
    atomicWriteJson(configPath, current);
    const executable = findClaude(home);
    const jobs = ['v1', 'v2'].flatMap((variant) => QUESTIONS.map((question, index) => ({ variant, question, index })));
    const jobResults = await mapLimit(jobs, CONCURRENCY, async (job) => ({ ...job, result: await runClaude(executable, variants[job.variant].cwd, job.question.q) }));
    const rows = QUESTIONS.map((question, index) => {
      const row = { group: question.group, question: question.q, keywords: question.kw };
      for (const variant of ['v1', 'v2']) {
        const result = jobResults.find((job) => job.variant === variant && job.index === index).result;
        row[variant] = { ...result, recalled: !result.error && question.kw.some((keyword) => result.text.includes(keyword)) };
      }
      return row;
    });
    const summary = summarize(rows, { claude: executable, model: 'sonnet', concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS, inputTokenDefinition: 'input_tokens + cache_creation_input_tokens + cache_read_input_tokens' });
    if (jsonOutput) console.log(JSON.stringify(summary, null, 2)); else printHuman(summary);
    return summary;
  } finally {
    try {
      const latest = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      latest.projects ||= {};
      for (const variant of Object.values(variants)) {
        if (previousProjects[variant.cwd] === undefined) delete latest.projects[variant.cwd];
        else latest.projects[variant.cwd] = previousProjects[variant.cwd];
      }
      atomicWriteJson(configPath, latest);
    } catch (error) {
      console.error(`警告: ~/.claude.json の一時 project 設定を復元できません: ${error.message}`);
    }
    for (const variant of Object.values(variants)) await removeWithRetries(path.dirname(variant.memory));
    await removeWithRetries(tempRoot);
  }
}

if (isEntry(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
