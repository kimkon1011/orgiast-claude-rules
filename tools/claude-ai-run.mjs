#!/usr/bin/env node
// claude.ai コネクタ（Drive/Docs/Sheets/Calendar/Gmail）と RemoteTrigger を有効にした
// 子 claude プロセスを起動する共通ラッパ。
// この PC（DESKTOP-63MQR3L）の自動セッションは ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL（DeepSeek プロキシ）で
// 起動しており、認証系 env が存在すると claude.ai コネクタが無効化される。
// 認証系 env を外した子プロセスで claude を起動することで、~/.claude/.credentials.json の
// claude.ai OAuth ログインが利用され、コネクタと RemoteTrigger が正常に読み込まれる（2026-10-14 実証）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { isUnspawnable, resolveClaudeExecutableFromDisk } from './claude-exe.mjs';

export const AUTH_ENV_KEYS = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
]);

const AUTH_ENV_PATTERN = /^anthropic_(auth_token|base_url|api_key)$/i;

// 親 env から認証系キーだけを外した新しいオブジェクトを返す。親は変更しない。
// Windows の env は大文字小文字を区別しないので、/^anthropic_(auth_token|base_url|api_key)$/i に一致するキーを全部落とす。
// 戻り値の2つ目に「実際に落としたキー名の一覧」を返す（値は含めない）。
export function buildConnectorEnv(parentEnv = process.env) {
  const env = {};
  const stripped = [];
  for (const [key, value] of Object.entries(parentEnv)) {
    if (AUTH_ENV_PATTERN.test(key)) {
      stripped.push(key);
    } else {
      env[key] = value;
    }
  }
  return { env, stripped };
}

// 子に渡す argv を作る。既定: ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'text']
// options.model があれば ['--model', model] を挟む。
export function buildChildArgs(options = {}) {
  const args = ['-p'];
  if (options.model) {
    args.push('--model', options.model);
  }
  args.push('--permission-mode', 'bypassPermissions', '--output-format', 'text');
  return args;
}

// 子プロンプトを組み立てる。instruction の先頭に必ず次の1行を付ける:
//   [headless:claude-ai-run] 回答は1つの最終メッセージに全文を出す。「前の回答のとおり」等の参照は禁止。
// (2026-10-14 実測: claude -p は最終メッセージしか返さないため、全文を1メッセージに寄せる指示が必須)
export function buildPrompt(instruction) {
  const header = '[headless:claude-ai-run] 回答は1つの最終メッセージに全文を出す。「前の回答のとおり」等の参照は禁止。';
  const trimmed = String(instruction || '').trim();
  return trimmed ? `${header}\n${trimmed}` : header;
}

// argv パーサ。--dry-run / --check / --model <name> / --timeout <sec> / --cwd <path> / --prompt-file <path> / 位置引数=指示
export function parseArgs(argv) {
  const options = {
    dryRun: false,
    check: false,
    model: '',
    timeoutSec: 300,
    cwd: process.cwd(),
    promptFile: '',
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (['--model', '--timeout', '--cwd', '--prompt-file'].includes(arg)) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`${arg} に値が必要です`);
      }
      if (arg === '--model') options.model = val;
      if (arg === '--timeout') {
        const sec = Number(val);
        if (Number.isNaN(sec) || sec <= 0) {
          throw new Error(`--timeout には正の数値を指定してください: ${val}`);
        }
        options.timeoutSec = sec;
      }
      if (arg === '--cwd') options.cwd = val;
      if (arg === '--prompt-file') options.promptFile = val;
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`不明なオプションです: ${arg}`);
    }
    positional.push(arg);
  }
  return { ...options, positional };
}

// spawn を注入可能にしてテストする本体。spawnFn の既定は node:child_process の spawn。
// 戻り値 { code, stdout, stderr, timedOut }
export function runConnectorPrompt({
  spawnFn = spawn,
  executable,
  args,
  prompt = '',
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 300 * 1000,
  streamStdout = false,
  streamStderr = false,
} = {}) {
  const { env: connectorEnv } = buildConnectorEnv(env);
  const childEnv = { ...connectorEnv, ORGIAST_HEADLESS_JOB: 'claude-ai-run' };
  const childArgs = args || buildChildArgs();
  const bin = executable || 'claude';

  return new Promise((resolve) => {
    let stdoutText = '';
    let stderrText = '';
    let timedOut = false;
    let timer = null;

    const child = spawnFn(bin, childArgs, {
      windowsHide: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {}
      }, timeoutMs);
    }

    if (child.stdin) {
      child.stdin.on('error', () => {}); // 子が先に死んだときの EPIPE で親を落とさない
      if (prompt) {
        child.stdin.end(prompt);
      } else {
        child.stdin.end();
      }
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdoutText += chunk.toString();
        if (streamStdout) process.stdout.write(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrText += chunk.toString();
        if (streamStderr) process.stderr.write(chunk);
      });
    }

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      const msg = `claude CLI を起動できません: ${error.message}\n`;
      stderrText += msg;
      if (streamStderr) process.stderr.write(msg);
      resolve({ code: 1, stdout: stdoutText, stderr: stderrText, timedOut: false });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const finalCode = timedOut ? 124 : (code ?? 1);
      resolve({ code: finalCode, stdout: stdoutText, stderr: stderrText, timedOut });
    });
  });
}

function readInstruction(promptFile, positional) {
  if (promptFile) {
    return fs.readFileSync(promptFile, 'utf8').trim();
  }
  return positional.join(' ').trim();
}

async function main(args) {
  const usage = '使い方: node tools/claude-ai-run.mjs [--dry-run] [--check] [--model <name>] [--timeout <sec>] [--cwd <path>] [--prompt-file <path>] ["<指示>"]';
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }

  if (parsed.help) {
    console.error(usage);
    return 2;
  }

  let instruction = '';
  if (!parsed.check) {
    try {
      instruction = readInstruction(parsed.promptFile, parsed.positional);
    } catch (error) {
      console.error(`指示ファイルの読み込みに失敗しました: ${error.message}\n${usage}`);
      return 2;
    }
    if (!instruction) {
      console.error(`指示が指定されていません。\n${usage}`);
      return 2;
    }
  }

  const home = process.env.ORGIAST_HOME || os.homedir();
  const credPath = path.join(home, '.claude', '.credentials.json');
  const connectorCredentialPresent = fs.existsSync(credPath);

  const { executable } = await resolveClaudeExecutableFromDisk(process);
  const childArgs = parsed.check ? ['mcp', 'list'] : buildChildArgs({ model: parsed.model });
  const prompt = parsed.check ? '' : buildPrompt(instruction);
  const { stripped } = buildConnectorEnv(process.env);

  if (parsed.dryRun) {
    const dryRunOutput = {
      executable,
      argv: [executable, ...childArgs],
      promptVia: 'stdin',
      promptChars: prompt.length,
      strippedKeys: stripped,
      connectorCredentialPresent,
    };
    console.log(JSON.stringify(dryRunOutput, null, 2));
    return 0;
  }

  if (!connectorCredentialPresent) {
    console.error('[claude-ai-run] 警告: ~/.claude/.credentials.json が存在しません。claude.ai OAuth ログインが無い場合コネクタが動作しない可能性があります。');
  }

  if (executable === 'claude' && process.platform === 'win32') {
    console.error('[claude-ai-run] claude.exe が見つかりません(候補0件)。CLAUDE_CLI に claude.exe の絶対パスを設定してください。');
    return 4;
  }
  if (isUnspawnable(executable, process.platform)) {
    console.error(`[claude-ai-run] ${executable} は shell 無しで起動できません(.bat/.cmd)。CLAUDE_CLI に claude.exe を指定してください。`);
    return 4;
  }

  const res = await runConnectorPrompt({
    executable,
    args: childArgs,
    prompt,
    cwd: path.resolve(parsed.cwd),
    timeoutMs: parsed.timeoutSec * 1000,
    streamStdout: true,
    streamStderr: true,
  });

  return res.code;
}

if (isEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
