import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upsertEnvValue } from './env-kv.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const URL_MAX_AGE_MS = 540_000;
const DEFAULT_URL_TIMEOUT_MS = 15_000;

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

export function parseArgs(args) {
  const port = Number(option(args, '--port', DEFAULT_PORT));
  const urlTimeoutMs = Number(option(args, '--url-timeout-ms', DEFAULT_URL_TIMEOUT_MS));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port は 0〜65535 の整数で指定してください');
  if (!Number.isFinite(urlTimeoutMs) || urlTimeoutMs <= 0) throw new Error('--url-timeout-ms は正の数で指定してください');
  return { port, cli: option(args, '--cli', ''), urlTimeoutMs };
}

export function resolveHome(env = process.env) {
  return env.ORGIAST_HOME || os.homedir();
}

export function resolveCli({ explicit = '', home = resolveHome(), exists = fs.existsSync } = {}) {
  if (explicit) {
    if (!exists(explicit)) throw new Error(`指定された Genspark CLI が見つかりません: ${explicit}`);
    return { command: process.execPath, args: [explicit, 'login', '--no-open'] };
  }
  const bundled = path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@genspark', 'cli', 'dist', 'index.js');
  if (exists(bundled)) return { command: process.execPath, args: [bundled, 'login', '--no-open'] };
  // npm の Windows shim (*.cmd) は shell なしの spawn では直接実行できない。
  if (process.platform === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'gsk login --no-open'] };
  return { command: 'gsk', args: ['login', '--no-open'] };
}

async function readApiKey(configFile) {
  try {
    const parsed = JSON.parse(await fsp.readFile(configFile, 'utf8'));
    return typeof parsed.api_key === 'string' ? parsed.api_key.trim() : '';
  } catch {
    return '';
  }
}

async function saveApiKey(envFile, apiKey) {
  await fsp.mkdir(path.dirname(envFile), { recursive: true });
  let current = '';
  try { current = await fsp.readFile(envFile, 'utf8'); } catch {}
  const updated = upsertEnvValue(current, 'GSK_API_KEY', apiKey);
  await fsp.writeFile(envFile, updated.endsWith('\n') ? updated : `${updated}\n`, { encoding: 'utf8', mode: 0o600 });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticTail(output) {
  const masked = output
    .replace(/(code=)[^\s&]+/gi, '$1***')
    .replace(/gsk_[^\s]+/g, '***');
  return masked.trim().slice(-300);
}

export async function startKeeper({ args = process.argv.slice(2), env = process.env, log = console.log, errorLog = console.error } = {}) {
  const { port, cli: explicitCli, urlTimeoutMs } = parseArgs(args);
  const home = resolveHome(env);
  const configFile = path.join(home, '.genspark-tool-cli', 'config.json');
  const envFile = path.join(home, '.claude', 'genspark.env');
  const cli = resolveCli({ explicit: explicitCli, home });
  const state = { url: '', issuedAt: 0, attempts: 0, child: null, pending: null, finishing: false };
  let monitor;

  const stopChild = () => {
    if (state.child && state.child.exitCode === null && !state.child.killed) state.child.kill();
    state.child = null;
  };

  const getFreshUrl = () => {
    const age = Date.now() - state.issuedAt;
    if (state.url && age >= 0 && age <= URL_MAX_AGE_MS) return Promise.resolve(state.url);
    if (state.pending) return state.pending;
    stopChild();
    state.url = '';
    state.issuedAt = 0;
    state.attempts += 1;

    state.pending = new Promise((resolve, reject) => {
      let settled = false;
      let stderr = '';
      let output = '';
      const child = spawn(cli.command, cli.args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      state.child = child;
      const finish = (failure, url = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure) reject(failure);
        else resolve(url);
      };
      const inspect = () => {
        const match = output.match(/Login URL:\s*(\S+)/);
        if (!match) return;
        state.url = match[1];
        state.issuedAt = Date.now();
        finish(null, state.url);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; inspect(); });
      child.stderr.on('data', (chunk) => { stderr += chunk; output += chunk; inspect(); });
      child.on('error', (error) => finish(new Error(`gsk を起動できませんでした: ${messageOf(error)}`)));
      child.on('exit', (code) => {
        if (!settled) {
          const detail = stderr.trim().split(/\r?\n/).slice(-1)[0];
          finish(new Error(`gsk が Login URL を出さずに終了しました (exit ${code})${detail ? `: ${detail}` : ''}`));
        }
      });
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill();
          const detail = diagnosticTail(output);
          finish(new Error(`gsk から Login URL を ${urlTimeoutMs}ms 以内に取得できませんでした${detail ? `: 子プロセス出力末尾: ${detail}` : ''}`));
        }
      }, urlTimeoutMs);
    }).finally(() => { state.pending = null; });
    return state.pending;
  };

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', `http://${HOST}`).pathname;
    if (request.method !== 'GET') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
      response.end('GET のみ利用できます');
      return;
    }
    if (pathname === '/status') {
      const apiKey = await readApiKey(configFile);
      const ageSec = state.issuedAt ? Math.max(0, Math.floor((Date.now() - state.issuedAt) / 1000)) : null;
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ authorized: Boolean(apiKey), hasUrl: Boolean(state.url), ageSec, attempts: state.attempts }));
      return;
    }
    if (pathname !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }
    try {
      const url = await getFreshUrl();
      response.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
      response.end();
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`Genspark ログインURLを発行できませんでした: ${messageOf(error)}`);
    }
  });

  const close = async () => {
    clearInterval(monitor);
    stopChild();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`127.0.0.1:${port} で待ち受けできません: ${messageOf(error)}`));
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  log(`[READY] http://${HOST}:${address.port}/ で待機しています`);

  monitor = setInterval(async () => {
    if (state.finishing) return;
    const apiKey = await readApiKey(configFile);
    if (!apiKey) return;
    state.finishing = true;
    try {
      await saveApiKey(envFile, apiKey);
      log('[OK] 認可完了。GSK_API_KEY を ~/.claude/genspark.env に保存しました');
      await close();
    } catch (error) {
      state.finishing = false;
      errorLog(`[ERROR] GSK_API_KEY を保存できませんでした: ${messageOf(error)}`);
    }
  }, 200);
  monitor.unref?.();

  return { server, state, close, configFile, envFile };
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  startKeeper().catch((error) => {
    console.error(`[ERROR] ${messageOf(error)}`);
    process.exitCode = 1;
  });
}
