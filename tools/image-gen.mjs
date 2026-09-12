#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const DEFAULT_MODEL = 'nano-banana-2-flash-lite';
const DEFAULT_TIMEOUT_SECONDS = 300;
const USAGE = '使い方: node tools/image-gen.mjs "<プロンプト>" [--model <id>] [--aspect <比>] [--size <サイズ>] [--ref <url> ...] [--out <パス>] [--json] [--timeout <秒>]';

export function loadGskApiKey({ env = process.env, homeDir = os.homedir() } = {}) {
  return env.GSK_API_KEY || readEnvValue(path.join(homeDir, '.claude', 'genspark.env'), 'GSK_API_KEY');
}

export function parseArgs(argv) {
  const options = { model: DEFAULT_MODEL, aspectRatio: undefined, imageSize: undefined, refUrls: [], outPath: undefined, json: false, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, help: false };
  const promptParts = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help') options.help = true;
    else if (['--model', '--aspect', '--size', '--ref', '--out', '--timeout'].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} の値がありません`);
      if (arg === '--model') options.model = value;
      else if (arg === '--aspect') options.aspectRatio = value;
      else if (arg === '--size') options.imageSize = value;
      else if (arg === '--ref') options.refUrls.push(value);
      else if (arg === '--out') options.outPath = value;
      else {
        options.timeoutSeconds = Number(value);
        if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) throw new Error('--timeout は正の秒数で指定してください');
      }
    } else if (arg.startsWith('--')) throw new Error(`不明なオプション: ${arg}`);
    else promptParts.push(arg);
  }
  return { ...options, prompt: promptParts.join(' ').trim() };
}

function quoteForShell(arg) {
  if (/"/.test(arg)) throw new Error(`シェルに渡せない文字（"）が引数に含まれています: ${arg}`);
  return /[\s&|<>^%!(),;]/.test(arg) ? `"${arg}"` : arg;
}

function requestGsk({ args, timeoutSeconds, apiKey, spawnImpl, cleanup }) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { cleanup?.(); } finally { callback(); }
    };
    const shell = process.platform === 'win32';
    let spawnArgs;
    try { spawnArgs = shell ? args.map(quoteForShell) : args; } catch (error) { cleanup?.(); reject(error); return; }
    const previousNoDeprecation = process.noDeprecation;
    try {
      process.noDeprecation = true;
      child = spawnImpl(shell ? 'gsk.cmd' : 'gsk', spawnArgs, {
        shell, windowsHide: true,
        env: { ...process.env, GSK_API_KEY: apiKey }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      cleanup?.();
      reject(error);
      return;
    } finally {
      process.noDeprecation = previousNoDeprecation;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (code !== 0) return reject(new Error(`Genspark CLI exit ${code}: ${stderr.slice(0, 300)}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`Genspark CLI の JSON 応答を解析できません: ${error.message}`)); }
    }));
    timer = setTimeout(() => {
      child.kill();
      const error = new Error(`Genspark CLI timed out after ${timeoutSeconds} seconds`);
      error.name = 'AbortError';
      finish(() => reject(error));
    }, timeoutSeconds * 1000);
  });
}

export async function generateImage({
  prompt, model = DEFAULT_MODEL, aspectRatio, imageSize, refUrls = [], outPath,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, apiKey, spawnImpl = spawn, tmpDir,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt が必要です');
  if (!Array.isArray(refUrls)) throw new Error('refUrls は配列で指定してください');
  const resolvedApiKey = apiKey ?? loadGskApiKey();
  if (!resolvedApiKey) throw new Error('GSK_API_KEY がありません。~/.claude/genspark.env を確認してください');

  const tempDir = fs.mkdtempSync(path.join(tmpDir || os.tmpdir(), 'gsk-image-'));
  let raw;
  try {
    const argsPath = path.join(tempDir, 'args.json');
    const serverArgs = { query: prompt, model };
    if (aspectRatio !== undefined) serverArgs.aspect_ratio = aspectRatio;
    if (imageSize !== undefined) serverArgs.image_size = imageSize;
    if (refUrls.length) serverArgs.image_urls = refUrls;
    fs.writeFileSync(argsPath, JSON.stringify(serverArgs));
    const args = ['img', '--args-file', argsPath, '--output', 'json', '--model', model];
    if (outPath) args.push('--output-file', outPath);
    raw = await requestGsk({
      args, timeoutSeconds, apiKey: resolvedApiKey, spawnImpl,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const generated = raw?.data?.generated_images?.[0];
  if (!generated || generated.status !== 'SUCCESS') {
    const reason = generated?.failure_reason || raw?.message || '生成画像がありません';
    throw new Error(`Genspark image generation failed: ${reason}`);
  }
  return {
    provider: 'gsk', model: generated.model || model, taskId: generated.task_id,
    imageUrl: generated.image_urls?.[0], imageUrlNoWatermark: generated.image_urls_nowatermark?.[0],
    localPath: raw.data?.local_path || outPath, width: generated.width, height: generated.height,
  };
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let options;
  try { options = parseArgs(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}\n`); return 1; }
  if (options.help || !options.prompt) { stderr.write(`${USAGE}\n`); return 1; }
  try {
    const result = await generateImage({ ...options, ...dependencies });
    stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.localPath || result.imageUrl}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
