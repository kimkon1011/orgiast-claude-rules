#!/usr/bin/env node
// このスクリプトは、このPC（DESKTOP-63MQR3L）の自動セッションから claude.ai コネクタの
// RemoteTrigger ツール（claude.ai Routines API）を呼び出すための薄い CLI ラッパ。
// 【重要制約】
// RemoteTrigger で利用可能なアクションは list_triggers / get_trigger / create_trigger /
// update_trigger / list_runs / run / get_run_log / create_webhook_trigger のみ。
// 環境（environment）の egress 許可ドメインは RemoteTrigger API では読み書きできず、
// claude.ai 側の Web UI 操作でのみ変更可能（2026-10-14 実証）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { isUnspawnable, resolveClaudeExecutableFromDisk } from './claude-exe.mjs';
import {
  buildChildArgs,
  buildConnectorEnv,
  buildPrompt,
  runConnectorPrompt,
} from './claude-ai-run.mjs';

export const ACTIONS = Object.freeze([
  'list_triggers',
  'get_trigger',
  'create_trigger',
  'update_trigger',
  'list_runs',
  'run',
  'get_run_log',
  'create_webhook_trigger',
]);

// 実測で確認した payload の形（2026-10-14 の runs/2026-10-14-3.rt-*.md）。
// get_run_log の run 識別子は session_id（値は cse_...）で、run_id ではない。
export const PAYLOAD_HINTS = Object.freeze({
  run: '{"trigger_id":"trig_..."}',
  list_runs: '{"trigger_id":"trig_..."}',
  get_trigger: '{"trigger_id":"trig_..."}',
  get_run_log: '{"session_id":"cse_..."}',
});

export function validateAction(action) {
  if (!ACTIONS.includes(action)) {
    throw new Error(`未知の action です: ${action}。有効な action 一覧: ${ACTIONS.join(', ')}`);
  }
  return action;
}

export function parseActionArgs(argv) {
  let dryRun = false;
  let help = false;
  let timeoutSec = 300;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--timeout') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error('--timeout に値が必要です');
      }
      const sec = Number(val);
      if (Number.isNaN(sec) || sec <= 0) {
        throw new Error(`--timeout には正の数値を指定してください: ${val}`);
      }
      timeoutSec = sec;
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`不明なオプションです: ${arg}`);
    }
    positional.push(arg);
  }

  const action = positional[0] || '';
  let payload = {};
  if (positional.length > 1 && positional[1] !== '') {
    try {
      payload = JSON.parse(positional[1]);
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('payload は JSON オブジェクトである必要があります');
      }
    } catch (e) {
      throw new Error(`不正な JSON payload です: ${e.message}`);
    }
  }

  return { action, payload, dryRun, timeoutSec, help };
}

export function buildTriggerPrompt(action, payload = {}) {
  validateAction(action);
  const fullPayload = { action, ...payload };
  const payloadJson = JSON.stringify(fullPayload);

  return [
    'claude.ai コネクタの RemoteTrigger ツールを、次の JSON を引数としてそのまま1回だけ呼び出してください。値の改変・追加・推測は禁止。',
    payloadJson,
    '呼び出し後、ツールの戻り値だけを最終メッセージとして出力してください。前後の説明・挨拶・Markdown コードフェンスは付けないでください。',
    'ツールが使えない場合は {"error":"remote_trigger_unavailable","detail":"<理由>"} の1行だけを出力してください。',
  ].join('\n\n');
}

async function main(args) {
  const usage = [
    '使い方: node tools/remote-trigger.mjs <action> [\'<payload-json>\'] [--dry-run] [--timeout <sec>]',
    '',
    '利用可能な action 一覧:',
    ...ACTIONS.map((act) => `  - ${act}${PAYLOAD_HINTS[act] ? `   例: ${PAYLOAD_HINTS[act]}` : ''}`),
  ].join('\n');

  let parsed;
  try {
    parsed = parseActionArgs(args);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }

  if (parsed.help || !parsed.action) {
    console.error(usage);
    return 2;
  }

  try {
    validateAction(parsed.action);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }

  const fullPayload = { action: parsed.action, ...parsed.payload };
  const rawPrompt = buildTriggerPrompt(parsed.action, parsed.payload);
  const prompt = buildPrompt(rawPrompt);

  const home = process.env.ORGIAST_HOME || os.homedir();
  const credPath = path.join(home, '.claude', '.credentials.json');
  const connectorCredentialPresent = fs.existsSync(credPath);
  const { executable } = await resolveClaudeExecutableFromDisk(process);
  const childArgs = buildChildArgs();
  const { stripped } = buildConnectorEnv(process.env);

  if (parsed.dryRun) {
    const dryRunOutput = {
      action: parsed.action,
      payload: fullPayload,
      prompt,
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
    console.error('[remote-trigger] 警告: ~/.claude/.credentials.json が存在しません。claude.ai OAuth ログインが無い場合コネクタが動作しない可能性があります。');
  }

  if (executable === 'claude' && process.platform === 'win32') {
    console.error('[remote-trigger] claude.exe が見つかりません(候補0件)。CLAUDE_CLI に claude.exe の絶対パスを設定してください。');
    return 4;
  }
  if (isUnspawnable(executable, process.platform)) {
    console.error(`[remote-trigger] ${executable} は shell 無しで起動できません(.bat/.cmd)。CLAUDE_CLI に claude.exe を指定してください。`);
    return 4;
  }

  const res = await runConnectorPrompt({
    executable,
    args: childArgs,
    prompt,
    cwd: process.cwd(),
    timeoutMs: parsed.timeoutSec * 1000,
    streamStdout: true,
    streamStderr: true,
  });

  return res.code;
}

if (isEntry(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
