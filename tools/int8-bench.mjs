#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { generateImage, generateVideo } from './image-gen.mjs';
import { isEntry } from './is-entry.mjs';

const DEFAULT_MODEL = 'nano-banana-2-flash-lite';
const DEFAULT_PROMPT = 'A modern exhibition booth with three blue and white panels and a wooden reception counter, wide view.';
const CSV_COLUMNS = [
  'timestamp', 'model', 'precision', 'mode', 'prompt', 'run', 'source',
  'ttft_seconds', 'total_seconds', 'local_vram_delta_mb', 'error', 'error_message',
];

export function parseArgs(argv, date = new Date()) {
  const options = {
    precision: 'auto', model: DEFAULT_MODEL, prompt: DEFAULT_PROMPT,
    video: false, count: 3, json: false,
    outPath: path.join('outputs', 'P-0417', `benchmark-results-${date.toISOString().slice(0, 10)}.csv`),
  };
  const valueOptions = new Map([
    ['--precision', 'precision'], ['--model', 'model'], ['--prompt', 'prompt'],
    ['--count', 'count'], ['--out', 'outPath'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--video') options.video = true;
    else if (arg === '--json') options.json = true;
    else {
      const key = valueOptions.get(arg);
      if (!key) throw new Error(`不明なオプション: ${arg}`);
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} の値がありません`);
      options[key] = value.trim();
    }
  }
  if (!options.prompt) throw new Error('--prompt は空にできません');
  if (!options.model || !options.outPath) throw new Error('--model と --out は空にできません');
  if (!['int8', 'fp16', 'auto'].includes(options.precision)) {
    throw new Error('--precision は int8、fp16、auto のいずれかを指定してください');
  }
  if (!/^\d+$/.test(String(options.count)) || !Number.isSafeInteger(Number(options.count)) || Number(options.count) < 1) {
    throw new Error('--count は正の整数で指定してください');
  }
  options.count = Number(options.count);
  return options;
}

export function readVramMb(exec = execFileSync) {
  try {
    const output = exec('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^\d+(?:\r?\n\d+)*$/.test(output)) return null;
    return output.split(/\r?\n/).reduce((sum, value) => sum + Number(value), 0);
  } catch {
    return null;
  }
}

function csvCell(value) {
  const cell = String(value ?? '');
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function appendCsv(outPath, rows) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'a');
  try {
    const header = fs.fstatSync(fd).size === 0 ? CSV_COLUMNS.join(',') + '\r\n' : '';
    const body = rows.map((row) => CSV_COLUMNS.map((key) => csvCell(row[key])).join(',')).join('\r\n');
    fs.writeFileSync(fd, header + body + '\r\n');
  } finally {
    fs.closeSync(fd);
  }
}

function simulatedTiming({ video, precision }, run) {
  const baseline = video ? 18 : 4;
  const factor = precision === 'int8' ? 0.7 : 1;
  const total = Number((baseline * factor + (run - 1) * 0.1).toFixed(3));
  return { source: 'mock', ttft_seconds: total, total_seconds: total };
}

export async function runBenchmark(options, {
  apiKey = process.env.GSK_API_KEY, image = generateImage, video = generateVideo,
  vram = readVramMb, now = () => performance.now(),
} = {}) {
  const generate = options.video ? video : image;
  const results = [];
  let mock = !apiKey?.trim();
  for (let run = 1; run <= options.count; run += 1) {
    const row = {
      timestamp: new Date().toISOString(), model: options.model, precision: options.precision,
      mode: options.video ? 'video' : 'image', prompt: options.prompt, run, source: 'gsk',
      ttft_seconds: null, total_seconds: null, local_vram_delta_mb: null, error: false, error_message: null,
    };
    if (!mock) {
      const before = vram();
      const started = now();
      try {
        await generate({ prompt: options.prompt, model: options.model, precision: options.precision, apiKey });
        // gsk returns one completed JSON response. This is the first observable result.
        row.ttft_seconds = (now() - started) / 1000;
        row.total_seconds = row.ttft_seconds;
      } catch (error) {
        if (error.code === 'ENOENT') mock = true;
        else {
          row.total_seconds = (now() - started) / 1000;
          row.error = true;
          row.error_message = error.message;
        }
      }
      if (!mock) {
        const after = vram();
        if (before !== null && after !== null) row.local_vram_delta_mb = after - before;
      }
    }
    if (mock) Object.assign(row, simulatedTiming(options, run));
    results.push(row);
  }
  return results;
}

export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  try {
    const options = parseArgs(argv);
    const results = await runBenchmark(options, dependencies);
    appendCsv(options.outPath, results);
    const failures = results.filter((row) => row.error);
    if (options.json) stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    else {
      const source = results.every((row) => row.source === 'mock') ? '模擬結果' : '測定結果';
      stdout.write(`${source} ${results.length} 件（エラー ${failures.length} 件）を ${options.outPath} に保存しました\n`);
      for (const row of failures) stderr.write(`${row.run} 回目: ${row.error_message}\n`);
    }
    return failures.length ? 1 : 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
