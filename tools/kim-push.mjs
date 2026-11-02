#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { buildTriggerPrompt } from './remote-trigger.mjs';
import { buildChildArgs, buildPrompt, buildConnectorEnv, runConnectorPrompt } from './claude-ai-run.mjs';
import { resolveClaudeExecutableFromDisk, isUnspawnable } from './claude-exe.mjs';

export const DEFAULT_TRIGGER_ID = 'trig_01LmmkjNazcVuLTAYsRmJLH5';
export async function pushKim(text, deps = {}) {
  try {
    const io = deps.fs || fs;
    const home = deps.home || process.env.ORGIAST_HOME || os.homedir();
    let config = {};
    try { config = JSON.parse(io.readFileSync(path.join(home, '.claude/kim-push.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') return { ok: false, reason: '通知設定を読めません' }; }
    const value = String(text ?? '');
    const suffix = '…(以下省略)';
    const clipped = value.length > 20_000 ? value.slice(0, 20_000 - suffix.length) + suffix : value;
    const payload = { action: 'run', trigger_id: config.triggerId || DEFAULT_TRIGGER_ID, body: { text: clipped } };
    const { executable } = await (deps.resolveExecutable || resolveClaudeExecutableFromDisk)(process);
    // この PC の hook（起動時の点検・Stop ゲート）を通すと起動に約3分半かかり、送信後も終わらず
    // 打ち切られて「失敗」扱い→再送で通知が重複した（2026-11-01 実測）。中継は RemoteTrigger を
    // 1回呼ぶだけなので hook を外し、使えるツールもそれだけに絞る。
    // --strict-mcp-config / ENABLE_CLAUDEAI_MCP_SERVERS=false を付けるとタスクスケジューラ環境では
    // RemoteTrigger が呼ばれず 840 秒打ち切りになった（対話環境では通る。2026-11-01 実測）。外部接続は読む。
    const args = [...buildChildArgs({ model: 'haiku' }), '--settings', '{"disableAllHooks":true}', '--allowedTools', 'RemoteTrigger'];
    if (deps.dryRun) return { ok: true, payload, argv: [executable, ...args] };
    if (isUnspawnable(executable, process.platform) || (process.platform === 'win32' && executable === 'claude')) {
      return { ok: false, reason: '起動可能な Claude 実行ファイルがありません' };
    }
    const result = await (deps.runConnectorPrompt || runConnectorPrompt)({
      executable, args, prompt: buildPrompt(buildTriggerPrompt('run', payload)),
      env: buildConnectorEnv(deps.env || process.env).env,
      // kim-PC はタスク起動時に claude.exe の起動だけで約2分、送信まで計7〜9分かかった（2026-11-01 実測 565 秒）。
      timeoutMs: deps.timeoutMs ?? 840_000,
      stopWhen: out => out.includes('"session_id"'),
    });
    // タスク環境では通知実行後も子が終了せずタイムアウトするため、応答で成功を判定して重複再送を防ぐ。
    if (String(result.stdout).includes('"session_id"')) return { ok: true };
    // 秘密値が切断されて伏せ字をすり抜けないよう、先に出力全体を伏せ字にする。
    const stderr = redactSecrets(result.stderr).slice(-200);
    return { ok: false, reason: `通知実行失敗（終了コード ${result.code}、timedOut ${Boolean(result.timedOut)}、セッション応答 なし、stderr ${stderr}）` };
  } catch { return { ok: false, reason: 'スマホ通知の実行に失敗しました' }; }
}

export async function main(args = process.argv.slice(2), deps = {}) {
  let file, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--text-file' && args[i + 1] && !args[i + 1].startsWith('--')) file = args[++i];
    else return 2;
  }
  if (!file) return 2;
  let text;
  try { text = (deps.fs || fs).readFileSync(file, 'utf8'); } catch { return 2; }
  const result = await pushKim(text, { ...deps, dryRun });
  (deps.log || console.log)(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}
if (isEntry(import.meta.url)) process.exitCode = await main();
