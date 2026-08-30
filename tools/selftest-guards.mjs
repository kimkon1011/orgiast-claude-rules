#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseEnvText } from './env-kv.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const toolsDir = path.join(repo, 'tools');
let failed = 0;
function run(script, input, args = [], env = {}) {
  // 既定で版ドリフト照合を止める。テストごとに GitHub API を叩くと未認証の 60req/h に当たり、
  // 「照合できず」がレポートに混ざって無関係な assert を落とす。実 fetch を通したい
  // テストだけ VERSION_DRIFT_SKIP: '' を明示的に渡す。
  const result = spawnSync(process.execPath, [path.join(toolsDir, script), ...args], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', env: { VERSION_DRIFT_SKIP: '1', ...process.env, ...env }, cwd: repo,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}: ${error.message}`); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function makeTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function writeCostEnforce(home, mode) {
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'cost-enforce.json'), JSON.stringify({ mode }));
}

test('fleet-poller: rules-resync はリポの .mjs を優先する', () => {
  // 凍結コピー(~/.claude/hooks/onboarding-sync.ps1)を先に叩くと、中央キューから配っても
  // 古い実装が動くだけで配布が届かない端末を治せない。
  const source = fs.readFileSync(path.join(toolsDir, 'fleet-poller.mjs'), 'utf8');
  const at = source.indexOf("task === 'rules-resync'");
  const block = source.slice(at, source.indexOf("task === 'cost-report'", at));
  const mjsAt = block.indexOf("'onboarding-sync.mjs'");
  const ps1At = block.indexOf("'onboarding-sync.ps1'");
  assert(at >= 0 && mjsAt >= 0 && (ps1At < 0 || mjsAt < ps1At), 'rules-resync が凍結 .ps1 を先に実行している');
});
test('onboarding-sync.ps1: hooks配下の自分自身を更新する', () => {
  const source = fs.readFileSync(path.join(toolsDir, 'onboarding-sync.ps1'), 'utf8');
  const updateBlock = source.slice(source.indexOf('Write-SyncLog "repo updated ($repoSyncMethod)"'), source.indexOf('} catch { Write-SyncLog "repo sync failed:', source.indexOf('Write-SyncLog "repo updated ($repoSyncMethod)"')));
  assert(updateBlock.includes("'.claude\\hooks\\onboarding-sync.ps1'") && updateBlock.includes('Copy-Item') && updateBlock.includes('Get-FileHash'), '自己更新のバイト同一判定またはコピー処理が不足');
});
test('onboarding-sync.ps1: PowerShell 5.1 でも ONBOARDING を取得できる', () => {
  // pwsh が無いPCの hook は powershell(5.1) で起動され、5.1 は [System.Net.Http.HttpClient] を
  // 解決できずルール同期だけが静かに止まる。HttpClient 失敗時の代替経路を必須にする。
  const source = fs.readFileSync(path.join(toolsDir, 'onboarding-sync.ps1'), 'utf8');
  const at = source.indexOf('[System.Net.Http.HttpClient]::new()');
  const block = source.slice(at, source.indexOf('if (-not $bodyBytes', at));
  assert(at >= 0 && block.includes('Invoke-WebRequest') && block.includes('RawContentStream'), 'HttpClient 失敗時のフォールバック取得が無い');
});
test('install-orgiast.ps1: 未コミットの作業ツリーを削除しない', () => {
  const source = fs.readFileSync(path.join(toolsDir, 'install-orgiast.ps1'), 'utf8');
  const statusAt = source.indexOf('status --porcelain');
  const removeAt = source.indexOf('Remove-Item $REPO -Recurse');
  assert(statusAt >= 0 && removeAt > statusAt && source.slice(statusAt, removeAt).includes('$gotRepo = $true'), '未コミット判定が削除より前にない');
});

test('parseEnvText: BOM・表記ゆれ・重複・CRLF', () => {
  const parsed = parseEnvText('\uFEFF# comment\r\n export A=v1\r\n B = "v2"\r\n   C = \'v3\' \r\nA=last\r\n');
  assert(parsed.A === 'last' && parsed.B === 'v2' && parsed.C === 'v3', JSON.stringify(parsed));
});
test('env-repair: checkは非破壊、通常実行はbackup付き修復', () => {
  const temp = makeTempHome('orgiast-env-repair-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'groq.env'); const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('GROQ_API_KEY=secret\r\n')]); fs.writeFileSync(file, original);
  const check = run('env-repair.mjs', undefined, ['--check'], { ORGIAST_HOME: temp }); assert(check.stdout.includes('BOM検出: 1件'), check.stdout || check.stderr); assert(fs.readFileSync(file).equals(original), '--checkが書き換えた');
  const repair = run('env-repair.mjs', undefined, [], { ORGIAST_HOME: temp }); const data = fs.readFileSync(file); assert(repair.stdout.includes('BOM修復: 1件') && data.toString() === 'GROQ_API_KEY=secret\r\n', repair.stdout || repair.stderr); assert(fs.readdirSync(claude).some((x) => x.endsWith('-bom')), 'backupなし');
});
test('llm-ask: BOM付きenvのキー状態を値なしで診断', () => {
  const temp = makeTempHome('orgiast-llm-key-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true }); fs.writeFileSync(path.join(claude, 'groq.env'), '\uFEFF export GROQ_API_KEY = "secret-value"\r\n');
  const r = run('llm-ask.mjs', undefined, ['--provider', 'groq', '--print-key-status'], { ORGIAST_HOME: temp, GROQ_API_KEY: '' }); assert(r.status === 0 && r.stdout.includes('設定済み') && !r.stdout.includes('secret-value'), r.stdout || r.stderr);
});
test('hook-selfcheck: BOMを修復し、正常時はBOM報告なし', () => {
  const temp = makeTempHome('orgiast-hook-bom-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  // 必須hookを登録済みにしてBOMメッセージだけを観測する。
  const hooks = {}; for (const [event, script] of [['PreToolUse','model-agent-guard.mjs'],['UserPromptSubmit','cost-routing-gate.mjs'],['UserPromptSubmit','session-purpose-gate.mjs'],['SessionStart','hook-selfcheck.mjs'],['UserPromptSubmit','makimono-gate.mjs']]) (hooks[event] ||= []).push({ hooks: [{ command: script }] }); fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ hooks }));
  const file = path.join(claude, 'groq.env'); fs.writeFileSync(file, '\uFEFFGROQ_API_KEY=x\n'); const first = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo }); assert(first.stdout.includes('BOM を除去しました(1件)') && !fs.readFileSync(file).subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])), first.stdout || first.stderr);
  const second = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo }); assert(!second.stdout.includes('BOM を除去'), second.stdout || second.stderr);
});
test('register-hooks: BOM付き settings.json でも登録でき、BOM が除去される', () => {
  const temp = makeTempHome('orgiast-settings-bom-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'settings.json'); fs.writeFileSync(file, '\uFEFF{"hooks":{}}');
  const r = run('register-hooks.mjs', undefined, ['--hooks-only'], { ORGIAST_HOME: temp, ORGIAST_REPO: repo }); const data = fs.readFileSync(file);
  assert(r.status === 0 && r.stdout.includes('追加'), r.stdout || r.stderr); assert(!data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOMが残っている'); JSON.parse(data.toString('utf8'));
});
test('register-hooks: 旧PCを .mjs へ移行し、独自設定を保ったまま冪等', () => {
  const temp = makeTempHome('orgiast-hooks-upgrade-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'settings.json');
  const legacy = { model: 'opus', hooks: { SessionStart: [
    { hooks: [{ type: 'command', command: 'pwsh -NoProfile -File "C:\\Users\\old\\.claude\\hooks\\onboarding-sync.ps1"', timeout: 20 }] },
    { hooks: [{ type: 'command', command: 'echo user-hook' }] },
  ] } };
  fs.writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
  // 旧 .ps1 しかない状態を onboarding-sync.mjs の欠落として検知できなければ、移行処理は発火しない。
  const selfcheck = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo });
  assert(selfcheck.status === 0 && selfcheck.stdout.includes('SessionStart/onboarding-sync.mjs') && selfcheck.stdout.includes('欠落していたため自動登録'), selfcheck.stdout || selfcheck.stderr);
  const first = run('register-hooks.mjs', undefined, ['--hooks-only'], { ORGIAST_HOME: temp, ORGIAST_REPO: repo });
  assert(first.status === 0, first.stdout || first.stderr);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sessionCommands = (after.hooks?.SessionStart || []).flatMap((group) => (group.hooks || []).map((hook) => String(hook.command || '')));
  assert(sessionCommands.filter((command) => command.includes('onboarding-sync.mjs')).length === 1, JSON.stringify(sessionCommands));
  assert(!sessionCommands.some((command) => command.includes('onboarding-sync.ps1')), JSON.stringify(sessionCommands));
  assert(sessionCommands.includes('echo user-hook') && after.model === 'opus', 'ユーザー独自フックまたは独自キーが失われた');
  const stable = fs.readFileSync(file, 'utf8');
  const second = run('register-hooks.mjs', undefined, ['--hooks-only'], { ORGIAST_HOME: temp, ORGIAST_REPO: repo });
  assert(second.status === 0 && fs.readFileSync(file, 'utf8') === stable, second.stdout || second.stderr || '2回目で settings.json が変化した');
});
test('hook-selfcheck: BOM付き settings.json でクラッシュしない', () => {
  const temp = makeTempHome('orgiast-selfcheck-settings-bom-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), '\uFEFF{"hooks":{}}');
  const r = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo });
  assert(r.status === 0 && !`${r.stdout}${r.stderr}`.includes('Unexpected token'), r.stdout || r.stderr);
});

test('model-agent-guard: Fable5 deny', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-deny-test-'));
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'x' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout); assert(output.hookSpecificOutput.permissionDecision === 'deny', r.stdout || r.stderr);
});
test('Fable5明示指定: allow作成後は同一セッションで許可', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-allow-test-'));
  const sessionId = 'selftest-fable-session';
  const gate = run('cost-routing-gate.mjs', { prompt: 'Fable5で要約して', session_id: sessionId }, [], { ORGIAST_HOME: temp });
  const allowPath = path.join(temp, '.claude', 'fable-allow.json');
  assert(fs.existsSync(allowPath), gate.stdout || gate.stderr || 'allowファイルが作成されない');
  const allow = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
  assert(allow.sessionId === sessionId && Date.parse(allow.until) > Date.now(), JSON.stringify(allow));
  const guard = run('model-agent-guard.mjs', { session_id: sessionId, tool_name: 'Agent', tool_input: { model: 'fable', prompt: '要約して' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(guard.stdout);
  assert(output.hookSpecificOutput.permissionDecision !== 'deny' && output.hookSpecificOutput.additionalContext.includes('§1.16例外'), guard.stdout || guard.stderr);
});
test('Fable5例外: 期限切れallowはdeny', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-expired-test-'));
  const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'fable-allow.json'), JSON.stringify({ until: new Date(Date.now() - 1000).toISOString(), sessionId: 'expired' }));
  const r = run('model-agent-guard.mjs', { session_id: 'expired', tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'x' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout); assert(output.hookSpecificOutput.permissionDecision === 'deny', r.stdout || r.stderr);
});
test('Fable5否定指定: allowを作成しない', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-negative-test-'));
  const r = run('cost-routing-gate.mjs', { prompt: 'Fable5は使うな', session_id: 'negative' }, [], { ORGIAST_HOME: temp });
  assert(!fs.existsSync(path.join(temp, '.claude', 'fable-allow.json')), r.stdout || r.stderr);
});
function writeFableTranscript(home, name, rows) {
  const file = path.join(home, `${name}.jsonl`);
  fs.writeFileSync(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  return file;
}
function assistantRow(model, outputTokens = 100, timestamp = '2026-08-18T02:06:00.000Z') {
  return { type: 'assistant', timestamp, message: { model, usage: { output_tokens: outputTokens } } };
}
test('fable-session-guard: 最新応答がFable5なら切替警告を注入', () => {
  const home = makeTempHome('orgiast-fable-session-warn-');
  const transcript = writeFableTranscript(home, 'warn', [assistantRow('claude-opus-5'), assistantRow('claude-fable-5', 1200)]);
  const r = run('fable-session-guard.mjs', { transcript_path: transcript, session_id: 'warn', hook_event_name: 'UserPromptSubmit' }, [], { ORGIAST_HOME: home });
  assert(r.status === 0 && r.stdout.includes('🚨') && r.stdout.includes('/model opus'), r.stdout || r.stderr);
});
test('fable-session-guard: 最新応答がOpusなら無出力', () => {
  const home = makeTempHome('orgiast-fable-session-opus-');
  const transcript = writeFableTranscript(home, 'opus', [assistantRow('claude-fable-5'), assistantRow('claude-opus-5')]);
  const r = run('fable-session-guard.mjs', { transcript_path: transcript, session_id: 'opus' }, [], { ORGIAST_HOME: home });
  assert(r.status === 0 && r.stdout === '', r.stdout || r.stderr);
});
test('fable-session-guard: 同一sessionの未失効allowなら無出力', () => {
  const home = makeTempHome('orgiast-fable-session-allow-'); const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  const transcript = writeFableTranscript(home, 'allowed', [assistantRow('claude-fable-5')]);
  fs.writeFileSync(path.join(claude, 'fable-allow.json'), JSON.stringify({ sessionId: 'allowed', until: new Date(Date.now() + 60_000).toISOString() }));
  const r = run('fable-session-guard.mjs', { transcript_path: transcript, session_id: 'allowed' }, [], { ORGIAST_HOME: home });
  assert(r.status === 0 && r.stdout === '', r.stdout || r.stderr);
});
test('fable-session-guard: 別sessionまたは失効allowでは警告', () => {
  const home = makeTempHome('orgiast-fable-session-invalid-allow-'); const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  const transcript = writeFableTranscript(home, 'target', [assistantRow('claude-fable-5')]);
  fs.writeFileSync(path.join(claude, 'fable-allow.json'), JSON.stringify({ sessionId: 'other', until: new Date(Date.now() + 60_000).toISOString() }));
  const other = run('fable-session-guard.mjs', { transcript_path: transcript, session_id: 'target' }, [], { ORGIAST_HOME: home });
  fs.writeFileSync(path.join(claude, 'fable-allow.json'), JSON.stringify({ sessionId: 'target', until: new Date(Date.now() - 1000).toISOString() }));
  const expired = run('fable-session-guard.mjs', { transcript_path: transcript, session_id: 'target' }, [], { ORGIAST_HOME: home });
  assert(other.stdout.includes('🚨') && expired.stdout.includes('🚨'), `${other.stdout}\n${expired.stdout}`);
});
test('fable-session-guard: transcript欠損と壊れたstdinは無言exit 0', () => {
  const home = makeTempHome('orgiast-fable-session-broken-');
  const missing = run('fable-session-guard.mjs', { transcript_path: path.join(home, 'missing.jsonl'), session_id: 'missing' }, [], { ORGIAST_HOME: home });
  const broken = spawnSync(process.execPath, [path.join(toolsDir, 'fable-session-guard.mjs')], { input: '{broken', encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home }, cwd: repo });
  assert(missing.status === 0 && missing.stdout === '' && broken.status === 0 && broken.stdout === '', JSON.stringify({ missing, broken: { status: broken.status, stdout: broken.stdout, stderr: broken.stderr } }));
});
test('fable-session-guard: 巨大transcriptも末尾の最新モデルだけで判定', () => {
  const home = makeTempHome('orgiast-fable-session-large-');
  const fableLine = JSON.stringify(assistantRow('claude-fable-5'));
  const opusLine = JSON.stringify(assistantRow('claude-opus-5'));
  const prefix = `${fableLine}\n`.repeat(Math.ceil(1_100_000 / (fableLine.length + 1)));
  const latestOpus = path.join(home, 'latest-opus.jsonl'); fs.writeFileSync(latestOpus, prefix + opusLine + '\n');
  const quiet = run('fable-session-guard.mjs', { transcript_path: latestOpus, session_id: 'latest-opus' }, [], { ORGIAST_HOME: home });
  const opusPrefix = `${opusLine}\n`.repeat(Math.ceil(1_100_000 / (opusLine.length + 1)));
  const latestFable = path.join(home, 'latest-fable.jsonl'); fs.writeFileSync(latestFable, opusPrefix + fableLine + '\n');
  const warned = run('fable-session-guard.mjs', { transcript_path: latestFable, session_id: 'latest-fable' }, [], { ORGIAST_HOME: home });
  assert(quiet.status === 0 && quiet.stdout === '' && warned.stdout.includes('🚨'), `${quiet.stdout}\n${warned.stdout}\n${quiet.stderr}${warned.stderr}`);
});
test('fable-session-guard: process.exitを使わずisEntryで起動', () => {
  const source = fs.readFileSync(path.join(toolsDir, 'fable-session-guard.mjs'), 'utf8');
  assert(!/process\.exit\s*\(/.test(source) && /isEntry\(import\.meta\.url\)/.test(source), '安全なhookエントリ要件を満たしていない');
});
test('model-agent-guard: 実装は warn', () => {
  const temp = makeTempHome('orgiast-model-agent-warn-test-');
  writeCostEnforce(temp, 'warn');
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'ログイン機能を実装して' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout);
  assert(output.hookSpecificOutput.additionalContext && !output.hookSpecificOutput.permissionDecision, r.stdout || r.stderr);
});
test('model-agent-guard: block昇格時は実装委譲を deny', () => {
  const temp = makeTempHome('orgiast-model-agent-block-test-');
  writeCostEnforce(temp, 'block');
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'ログイン機能を実装して' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout);
  assert(output.hookSpecificOutput.permissionDecision === 'deny', r.stdout || r.stderr);
});
test('model-agent-guard: Explore 調査は無出力', () => {
  const temp = makeTempHome('orgiast-model-agent-explore-test-');
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: '設定を調査して' } }, [], { ORGIAST_HOME: temp });
  assert(r.stdout === '', `stdout=${r.stdout}`);
});
test('model-agent-guard: Write は無出力', () => {
  const temp = makeTempHome('orgiast-model-agent-write-test-');
  const r = run('model-agent-guard.mjs', { tool_name: 'Write', tool_input: {} }, [], { ORGIAST_HOME: temp });
  assert(r.stdout === '', `stdout=${r.stdout}`);
});
test('cost-routing-gate: 実装宣言', () => {
  const temp = makeTempHome('orgiast-routing-implementation-test-');
  const r = run('cost-routing-gate.mjs', { prompt: 'ログイン機能を実装して' }, [], { ORGIAST_HOME: temp });
  JSON.parse(r.stdout); assert(r.stdout.includes('[委譲判定]'), r.stdout || r.stderr);
});
test('cost-routing-gate: 300件は夜間バッチ', () => {
  const temp = makeTempHome('orgiast-routing-batch-test-');
  const r = run('cost-routing-gate.mjs', { prompt: '300件の会社を分類して' }, [], { ORGIAST_HOME: temp });
  assert(r.stdout.includes('夜間バッチ') && r.stdout.includes('§2.8.1') && r.stdout.includes('batch-enqueue'), r.stdout || r.stderr);
});
test('cost-routing-gate: 夜間トリガーは夜間判定宣言を要求', () => {
  const temp = makeTempHome('orgiast-routing-nightly-declaration-test-');
  const r = run('cost-routing-gate.mjs', { prompt: '300件の会社を分類して' }, [], { ORGIAST_HOME: temp });
  assert(r.stdout.includes('[夜間判定]'), r.stdout || r.stderr);
});
test('cost-routing-gate: 夜間判定済みなら再注入しない', () => {
  const temp = makeTempHome('orgiast-routing-nightly-declared-test-');
  const r = run('cost-routing-gate.mjs', { prompt: '[夜間判定] 300件の会社を分類して' }, [], { ORGIAST_HOME: temp });
  assert(!r.stdout.includes('§2.8.1'), r.stdout || r.stderr);
});
test('cost-routing-gate: 急ぎ明示は即時実行', () => {
  const temp = makeTempHome('orgiast-routing-nightly-urgent-test-');
  const r = run('cost-routing-gate.mjs', { prompt: '500件を今すぐ分類して' }, [], { ORGIAST_HOME: temp });
  assert(r.stdout.includes('[夜間判定]') && r.stdout.includes('即時実行') && !r.stdout.includes('batch-enqueue'), r.stdout || r.stderr);
});
test('cost-routing-gate: 小規模は夜間判定を注入しない', () => {
  const temp = makeTempHome('orgiast-routing-nightly-small-test-');
  const r = run('cost-routing-gate.mjs', { prompt: '1件だけ分類して' }, [], { ORGIAST_HOME: temp });
  assert(!r.stdout.includes('§2.8.1'), r.stdout || r.stderr);
});
test('cost-routing-gate: codex語で全体を無効化しない', () => {
  const temp = makeTempHome('orgiast-routing-codex-test-');
  const r = run('cost-routing-gate.mjs', { prompt: 'Codexとか使ってやすくしてる？' }, [], { ORGIAST_HOME: temp });
  assert(r.stdout.includes('additionalContext') && r.stdout.includes('監督の担当'), r.stdout || r.stderr);
});
test('hook-selfcheck: 偽HOMEで欠落を自動修復', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-hook-test-'));
  const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}\n');
  const r = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo });
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert(r.stdout.includes('欠落していたため自動登録'), r.stdout || r.stderr);
  assert(JSON.stringify(settings).includes('model-agent-guard.mjs') && JSON.stringify(settings).includes('cost-routing-gate.mjs'), '必須hookが登録されていない');
});
test('codex-do: --cwd 省略でも指示文が消えない', () => {
  const temp = makeTempHome('orgiast-codex-args-test-');
  const r = run('codex-do.mjs', undefined, ['ログイン機能を実装して', '--dry-run'], { ORGIAST_HOME: temp });
  assert(r.status !== 2 && !/使い方:/.test(r.stderr || ''), '第1引数が捨てられている');
  assert(/ログイン機能を実装して/.test(r.stdout || ''), '指示文がプロンプトに含まれない');
});

function makeToolAdoptionTestEnv(prefix) {
  const home = makeTempHome(prefix);
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin, { recursive: true });
  for (const tool of ['codex', 'gemini']) {
    const shim = path.join(bin, tool); fs.writeFileSync(shim, `#!/bin/sh\necho ${tool}-test\n`); fs.chmodSync(shim, 0o755);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, `${tool}.cmd`), `@echo ${tool}-test\r\n`);
  }
  return { home, env: { ORGIAST_HOME: home, PATH: bin + path.delimiter + (process.env.PATH || ''), DISCORD_COST_WEBHOOK: '' } };
}
test('tool-adoption-check: timeoutは未導入や手動installにしない', () => {
  const home = makeTempHome('orgiast-adoption-timeout-test-');
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const r = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], {
    ORGIAST_HOME: home, PATH: bin, DISCORD_COST_WEBHOOK: '', TOOL_ADOPTION_FORCE_TIMEOUT: 'codex,gemini', TOOL_ADOPTION_FORCE_ABSENT: 'codex,gemini', TOOL_ADOPTION_FAKE_DISTRO: '',
  });
  assert(r.status === 0 && (r.stdout.match(/判定不能\(プローブがタイムアウト・次回再判定\)/g) || []).length === 2, r.stdout || r.stderr);
  assert(!r.stdout.includes('未導入') && !r.stdout.includes('npm i -g'), r.stdout);
  assert(!fs.existsSync(path.join(home, '.claude', 'tool-adoption-install.state')), 'timeoutで自動導入が開始された');
});
// 版ドリフト判定で top-level await が入ったため、末尾の process.exit() が Windows で
// libuv assertion クラッシュ(0xC0000409)を起こす。出力は正常に見えるので exit code で縛る。
test('tool-adoption-check: --dry-run は exit 0 (top-level await後のprocess.exitを禁止)', () => {
  const { home, env } = makeToolAdoptionTestEnv('orgiast-adoption-exit-test-');
  // ここだけ VERSION_DRIFT_SKIP を外して実 fetch を通す(pending handle が無いと再現しない)。
  const r = run('tool-adoption-check.mjs', undefined, ['--dry-run'], { ...env, VERSION_DRIFT_SKIP: '', TOOL_ADOPTION_FORCE_PRESENT: 'codex,gemini', TOOL_ADOPTION_FAKE_DISTRO: '' });
  assert(r.status === 0, `exit=${r.status} (Windowsのlibuv assertionは 3221226505)\n${r.stderr.slice(-200)}`);
  assert(fs.existsSync(home), 'テスト用HOMEが消えている');
});
test('tool-adoption-check: FORCE_MISSINGは未導入と導入導線を維持', () => {
  const home = makeTempHome('orgiast-adoption-missing-test-');
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const r = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], {
    ORGIAST_HOME: home, PATH: bin + path.delimiter + (process.env.PATH || ''), DISCORD_COST_WEBHOOK: '', TOOL_ADOPTION_FORCE_MISSING: 'codex,gemini', TOOL_ADOPTION_FAKE_DISTRO: 'Ubuntu', TOOL_ADOPTION_INSTALL_CMD: 'echo install-test',
  });
  assert(r.status === 0 && (r.stdout.match(/未導入/g) || []).length >= 2, r.stdout || r.stderr);
  assert(r.stdout.includes('Codex 導入をバックグラウンドで開始') && r.stdout.includes('Gemini CLI 導入をバックグラウンドで開始'), r.stdout);
});
test('tool-adoption-check: timeoutでも存在フォールバックで導入済み', () => {
  const { home, env } = makeToolAdoptionTestEnv('orgiast-adoption-presence-test-');
  const r = run('tool-adoption-check.mjs', undefined, ['--dry-run'], { ...env, TOOL_ADOPTION_FORCE_TIMEOUT: 'codex,gemini', TOOL_ADOPTION_FORCE_PRESENT: 'codex,gemini', TOOL_ADOPTION_FAKE_DISTRO: '' });
  assert(r.status === 0 && !r.stdout.includes('未導入') && !r.stdout.includes('判定不能'), r.stdout || r.stderr);
  assert((r.stdout.match(/バージョン取得はタイムアウト/g) || []).length === 2, r.stdout);
});
test('tool-adoption-check: 全体デッドライン超過でもレポートを完走', () => {
  const { env } = makeToolAdoptionTestEnv('orgiast-adoption-deadline-test-');
  const r = run('tool-adoption-check.mjs', undefined, ['--dry-run'], { ...env, TOOL_ADOPTION_DEADLINE_MS: '1' });
  assert(r.status === 0 && r.stdout.includes('※一部の判定はデッドライン超過でスキップしました(次回再判定)'), r.stdout || r.stderr);
  assert(r.stdout.includes('※使用痕跡はセッションファイル/キー/MCP登録のみ判定。会話内容は読んでいません。') && r.stdout.includes('--dry-run: Discord未送信'), r.stdout);
});
test('tool-adoption-check: 新しい同一target stateなら導入をスキップ', () => {
  const { home, env } = makeToolAdoptionTestEnv('orgiast-adoption-state-test-');
  const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  // 導入先は win32 だと 'wsl'、それ以外は 'native'。'native' 固定で書くと Windows で
  // 重複判定が外れて導入が走り、テストが環境依存で落ちる(実測)。
  const expectedTarget = process.platform === 'win32' ? 'wsl' : 'native';
  fs.writeFileSync(path.join(claude, 'tool-adoption-install.state'), JSON.stringify({ started: new Date().toISOString(), target: expectedTarget }));
  const r = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], { ...env, TOOL_ADOPTION_FORCE_MISSING: 'codex', TOOL_ADOPTION_FAKE_DISTRO: 'Ubuntu', TOOL_ADOPTION_INSTALL_CMD: '/bin/echo should-not-run' });
  assert(r.status === 0 && !r.stdout.includes('バックグラウンドで開始しました'), r.stdout || r.stderr);
  assert(!fs.existsSync(path.join(claude, 'tool-adoption-install.log')), '重複導入プロセスが起動された');
});
test('tool-adoption-check: detached導入は同期的にブロックしない', () => {
  const { home, env } = makeToolAdoptionTestEnv('orgiast-adoption-detached-test-');
  const adoptionEnv = { ...env, TOOL_ADOPTION_FORCE_MISSING: 'codex', TOOL_ADOPTION_FAKE_DISTRO: 'Ubuntu', TOOL_ADOPTION_INSTALL_CMD: '/bin/sleep 5' };
  const started = Date.now();
  const r = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], adoptionEnv);
  const elapsed = Date.now() - started;
  assert(r.status === 0 && r.stdout.includes('バックグラウンドで開始しました'), r.stdout || r.stderr);
  assert(elapsed < 3000, `detached起動が ${elapsed}ms ブロックした`);
  const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'tool-adoption-install.state'), 'utf8'));
  assert(state.target === 'wsl' || state.target === 'native', JSON.stringify(state));
  const second = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], adoptionEnv);
  assert(second.status === 0 && !second.stdout.includes('バックグラウンドで開始しました'), second.stdout || second.stderr);
});

test('codex-do: dry-run に MEMORY.md を同梱', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-codex-test-'));
  const target = path.join(temp, 'target'); fs.mkdirSync(target, { recursive: true });
  const slug = target.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const memoryDir = path.join(temp, '.claude', 'projects', slug, 'memory'); fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), 'SELFTEST_MEMORY_MARKER\n');
  const r = run('codex-do.mjs', undefined, ['テスト実装', '--cwd', target, '--dry-run'], { ORGIAST_HOME: temp });
  assert(r.status === 0 && r.stdout.includes('SELFTEST_MEMORY_MARKER'), r.stdout || r.stderr);
});


// ---- マキモノ連携 ----
// gate は UserPromptSubmit hook。top-level await の中で process.exit() を呼ぶと Windows の Node が
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` で異常終了する(v24.14.1 実測・3/3再現)。
// stdout に候補を書けていても exit!=0 だと Claude Code が hook 失敗として扱い注入が丸ごと捨てられ、
// しかも落ちるのはキャッシュ切れ(24h毎)の初回プロンプトだけなので、気付かないまま機能が死ぬ。
test('makimono-gate: process.exit を使わない(Windowsでhookが落ちて注入が捨てられる)', () => {
  const source = fs.readFileSync(path.join(toolsDir, 'makimono-gate.mjs'), 'utf8');
  assert(!/process\.exit\s*\(/.test(source), 'process.exit が残っている(top-level awaitと併用するとWindowsで落ちる)');
  assert(/await main\(\)/.test(source), 'main() を await していない');
});

// カタログを事前投入して fetch させない(ネットワークとマキモノ本番APIに依存しないため)。
const MAKIMONO_ITEM = {
  slug: 'selftest-discord-bot', title: 'Discord 日報Bot 開発指示書', summary: 'KPIを毎朝通知する',
  category: '業務自動化', tags: ['discord', 'bot'], is_free: true, price: 0, content_tokens: 300, roi: 600,
  links: { raw: '/api/v1/files/selftest-discord-bot/raw' },
};
function seedMakimonoCatalog(prefix, items = [MAKIMONO_ITEM]) {
  const home = makeTempHome(prefix);
  const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, '.makimono-cache.json'), JSON.stringify({ __catalog__: { at: new Date().toISOString(), items } }));
  return home;
}
test('makimono-gate: キャッシュ済み候補を注入して exit 0', () => {
  const home = seedMakimonoCatalog('orgiast-makimono-gate-test-');
  const r = run('makimono-gate.mjs', { session_id: 'selftest-1', prompt: 'Discordに毎朝KPIを通知するbotを作って' }, [], { ORGIAST_HOME: home });
  assert(r.status === 0 && !r.stderr.includes('Assertion failed'), `status=${r.status} ${r.stderr}`);
  const output = JSON.parse(r.stdout);
  assert(output.hookSpecificOutput?.hookEventName === 'UserPromptSubmit', r.stdout);
  assert(output.hookSpecificOutput.additionalContext.includes('Discord 日報Bot 開発指示書'), r.stdout);
});
test('makimono-gate: 無関係なプロンプトには何も注入しない', () => {
  const home = seedMakimonoCatalog('orgiast-makimono-quiet-test-');
  const r = run('makimono-gate.mjs', { session_id: 'selftest-2', prompt: '今日の天気はどう?' }, [], { ORGIAST_HOME: home });
  assert(r.status === 0 && r.stdout.trim() === '', r.stdout || r.stderr);
});
test('makimono-gate: 同一セッションで同じ指示書を再提案しない', () => {
  const home = seedMakimonoCatalog('orgiast-makimono-dedupe-test-');
  const input = { session_id: 'selftest-3', prompt: 'Discordに通知するbotを作って' };
  const first = run('makimono-gate.mjs', input, [], { ORGIAST_HOME: home });
  const second = run('makimono-gate.mjs', input, [], { ORGIAST_HOME: home });
  assert(first.stdout.includes('selftest-discord-bot'), first.stdout || first.stderr);
  assert(second.status === 0 && second.stdout.trim() === '', second.stdout || second.stderr);
});
test('makimono-publish: 秘匿値・社内固有名は送信せず下書きへ退避し、値を伏せる', () => {
  const home = makeTempHome('orgiast-makimono-publish-test-');
  const file = path.join(home, 'draft.md');
  fs.writeFileSync(file, ['# 手順', 'オージャストの案件を通知する。', 'APIキー: sk-selftestSECRETVALUE0123456789', ''].join('\n'));
  const r = run('makimono-publish.mjs', undefined, ['--file', file, '--submit', '--title', 'テスト指示書', '--summary', '20文字以上のサマリーをここに書いておく', '--category', '業務自動化'], { ORGIAST_HOME: home });
  assert(r.status === 2, `status=${r.status} ${r.stdout} ${r.stderr}`);
  assert(r.stderr.includes('送信せず下書きへ退避'), r.stderr || r.stdout);
  assert(!r.stderr.includes('selftestSECRETVALUE'), '秘匿値がそのまま出力された');
  assert(!fs.existsSync(path.join(home, '.claude', 'makimono-submissions.json')), '送信ログが作られた(送信された疑い)');
  const drafts = path.join(home, '.claude', 'makimono-drafts');
  assert(fs.existsSync(drafts) && fs.readdirSync(drafts).length === 1, '下書きへ退避されていない');
});
test('makimono-publish: 一般化済み本文は送信禁止パターン0件', () => {
  const home = makeTempHome('orgiast-makimono-clean-test-');
  const file = path.join(home, 'clean.md');
  fs.writeFileSync(file, ['# チャットへ日次通知する', 'メール例: <user>@<example.com>', '手順: 集計して通知チャンネルへ送る。', ''].join('\n'));
  const r = run('makimono-publish.mjs', undefined, ['--file', file, '--scan'], { ORGIAST_HOME: home });
  assert(r.status === 0 && r.stdout.includes('送信禁止パターン: 0件'), r.stdout || r.stderr);
});
test('hook-selfcheck: makimono-gate の欠落を自動登録する', () => {
  const home = makeTempHome('orgiast-makimono-hook-test-');
  const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  const hooks = {};
  for (const [event, script] of [['PreToolUse', 'model-agent-guard.mjs'], ['UserPromptSubmit', 'cost-routing-gate.mjs'], ['UserPromptSubmit', 'session-purpose-gate.mjs'], ['SessionStart', 'hook-selfcheck.mjs']]) (hooks[event] ||= []).push({ hooks: [{ command: script }] });
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ hooks }));
  const r = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: home, ORGIAST_REPO: repo });
  assert(r.stdout.includes('makimono-gate.mjs'), `自動登録メッセージなし stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`);
  const after = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  const commands = (after.hooks?.UserPromptSubmit || []).flatMap((g) => (g.hooks || []).map((h) => String(h.command || '')));
  assert(commands.some((c) => c.includes('makimono-gate.mjs')), JSON.stringify(commands));
});
function makeFleetReportHome(prefix, withEnv = true) {
  const home = makeTempHome(prefix); const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  if (withEnv) {
    fs.writeFileSync(path.join(claude, 'fleet-sheet.env'), '\uFEFFexport FLEET_SHEET_URL=https://example.invalid/report\r\nFLEET_SHEET_TOKEN=test-token\r\n');
    fs.writeFileSync(path.join(claude, 'cost-reporter.env'), 'REPORTER_LABEL=selftest-known\n');
  }
  return { home, claude };
}
test('fleet-sheet-report: URL/TOKEN未設定ならstderr 1行でexit 0', () => {
  const { home } = makeFleetReportHome('orgiast-fleet-no-env-', false);
  const r = run('fleet-sheet-report.mjs', undefined, ['--dry-run'], { ORGIAST_HOME: home });
  assert(r.status === 0 && r.stdout === '' && r.stderr.trim().split(/\r?\n/).length === 1 && r.stderr.includes('FLEET_SHEET_URL/TOKEN 未設定'), JSON.stringify(r));
});
test('install/verify: 配布する ~/.claude/*.env を両方の総合チェックが網羅', () => {
  const psInstall = fs.readFileSync(path.join(toolsDir, 'install-orgiast.ps1'), 'utf8');
  const shInstall = fs.readFileSync(path.join(toolsDir, 'install-orgiast.sh'), 'utf8');
  const distributed = new Set();
  const psVars = new Map();
  for (const match of psInstall.matchAll(/\$(\w+)\s*=\s*Join-Path\s+\$HOMEDIR\s+['"]\.claude[\\/]([^'"\\/]+\.env)['"]/gi)) psVars.set(match[1], match[2]);
  for (const [variable, name] of psVars) {
    const write = new RegExp(`(?:Set-Content[^\\r\\n]*\\$${variable}\\b|\\$${variable}[^\\r\\n]*\\|\\s*Set-Content)`, 'i');
    if (write.test(psInstall)) distributed.add(name);
  }
  for (const match of psInstall.matchAll(/Set-Content[^\r\n]*Join-Path\s+\$HOMEDIR\s+['"]\.claude[\\/]([^'"\\/]+\.env)['"]/gi)) distributed.add(match[1]);
  for (const line of shInstall.split(/\r?\n/)) if (/write_env_if_missing|>\s*"\$CLAUDE_DIR\//.test(line)) {
    for (const match of line.matchAll(/\$CLAUDE_DIR\/([^"'\s/]+\.env)/g)) distributed.add(match[1]);
  }
  assert(distributed.size > 0, 'installer から ~/.claude/*.env を1件も抽出できなかった');
  const missing = [];
  for (const [checker, source] of [
    ['verify-setup.ps1', fs.readFileSync(path.join(toolsDir, 'verify-setup.ps1'), 'utf8')],
    ['selftest-install.sh', fs.readFileSync(path.join(toolsDir, 'selftest-install.sh'), 'utf8')],
  ]) for (const name of [...distributed].sort()) if (!source.includes(name)) missing.push(`${name} -> ${checker}`);
  assert(missing.length === 0, `総合チェックに未掲載: ${missing.join(', ')}`);
});
test('外部送受信ツール: 設定不足をstderr 1行以上で観測可能にしてexit 0', () => {
  // 第3要素 quietStdout: stdout が「呼び出し側が解釈する経路」のツールだけ true。
  // cost-work-loop は指示書本文を stdout に出すのが正常動作なので、そこを空だと要求すると
  // 本番側を黙らせる誤修正を誘発する(実際に一度そうなった)。観測点は stderr に統一する。
  const targets = [
    ['fleet-sheet-report.mjs', ['--dry-run'], true],
    ['interaction-rollout.mjs', [], true],
    ['fleet-triage-report.mjs', [], true],
    ['claude-cost-reporter.mjs', ['--force'], true],
    ['cost-work-loop.mjs', ['--post', '--days', '1'], false],
  ];
  for (const [script, args, quietStdout] of targets) {
    if (!fs.existsSync(path.join(toolsDir, script))) continue;
    const home = makeTempHome(`orgiast-silent-${script.replace(/\W/g, '-')}-`);
    const r = run(script, undefined, args, {
      ORGIAST_HOME: home, USERPROFILE: home, FLEET_SHEET_URL: '', FLEET_SHEET_TOKEN: '',
      DISCORD_COST_WEBHOOK: '', COST_WEBHOOK: '', COST_WORK_REPOS: home,
    });
    assert(r.status === 0, `${script}: exit=${r.status}\n${r.stderr}`);
    if (quietStdout) assert(r.stdout === '', `${script}: stdoutを汚している: ${JSON.stringify(r.stdout.slice(0, 200))}`);
    assert(r.stderr.trim() !== '' && r.stderr.trim().split(/\r?\n/).length >= 1, `${script}: 設定不足なのにstderrが無い`);
  }
});
test('fleet-sheet-report: stateから必要フィールドを組み立てる', () => {
  const { home, claude } = makeFleetReportHome('orgiast-fleet-state-');
  fs.writeFileSync(path.join(claude, 'cost-loop-state.json'), JSON.stringify({ t: '2026-08-19T00:00:00Z', claudeUSD: 12.3, delegRatio: 0.42 }));
  fs.writeFileSync(path.join(claude, 'cost-enforce.json'), JSON.stringify({ mode: 'warn', reason: 'selftest', delegRatio: 0.42, target: 0.3 }));
  fs.writeFileSync(path.join(claude, '.tool-adoption-state.json'), JSON.stringify({ codexAuthed: true, fable5OutTok: 0 }));
  fs.writeFileSync(path.join(claude, '.cost-reporter-state.json'), JSON.stringify({ topModels: [{ model: 'claude-opus-5', outTok: 10, usd: 1 }], fable5Detected: false }));
  fs.writeFileSync(path.join(claude, 'executor-usage.jsonl'), '{"provider":"kimi"}\n{"provider":"kimi"}\n{"provider":"groq"}\n');
  const r = run('fleet-sheet-report.mjs', undefined, ['--dry-run'], { ORGIAST_HOME: home }); const payload = JSON.parse(r.stdout);
  for (const key of ['token','label','mappedName','hostname','username','gitEmail','reportedAt','claudeUsd','mainModel','delegRatio','cheapAiUse','codexLogin','fable5','disciplineAlert']) assert(Object.hasOwn(payload, key), `不足: ${key}`);
  assert(payload.claudeUsd === 12.3 && payload.mainModel === 'claude-opus-5' && payload.cheapAiUse.includes('kimi:2'), r.stdout);
});
test('fleet-sheet-report: 未登録ラベルを推測せずmappedName null', () => {
  const { home } = makeFleetReportHome('orgiast-fleet-unmapped-');
  const r = run('fleet-sheet-report.mjs', undefined, ['--dry-run'], { ORGIAST_HOME: home });
  assert(r.status === 0 && JSON.parse(r.stdout).mappedName === null, r.stdout || r.stderr);
});
test('fleet-sheet-report: state欠損・破損でも既定値で継続', () => {
  const { home, claude } = makeFleetReportHome('orgiast-fleet-broken-');
  fs.writeFileSync(path.join(claude, 'cost-loop-state.json'), '{broken');
  fs.writeFileSync(path.join(claude, 'executor-usage.jsonl'), 'broken\n');
  const r = run('fleet-sheet-report.mjs', undefined, ['--dry-run'], { ORGIAST_HOME: home }); const payload = JSON.parse(r.stdout);
  assert(r.status === 0 && payload.claudeUsd === 0 && payload.codexLogin === '判定不能', r.stdout || r.stderr);
});
test('fleet upsert純関数: 保護列・連投・未マッピング・ヘッダ並替え', () => {
  const source = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'UpsertLogic.gs'), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);
  const headers = Object.values(context.FLEET_HEADERS_); const c = context.fleetResolveColumns(headers);
  const base = headers.map(() => ''); base[c.staff] = '人'; base[c.selfPc] = '申告PC'; base[c.memo] = '保護'; base[c.hostname] = 'host'; base[c.consistency] = 'kim本人・要委譲徹底';
  const payload = { label: 'host', mappedName: '申告PC', hostname: 'ignored-hostname', reportedAt: 'now', claudeUsd: 1, mainModel: 'model', delegRatio: 0.5, cheapAiUse: 'kimi:1', codexLogin: '済', fable5: '未検出', disciplineAlert: 'warn' };
  const first = context.fleetPlanUpsert(headers, [base], payload); const second = context.fleetPlanUpsert(headers, [base], payload);
  assert(first.action === 'updated' && second.rowIndex === 0 && !Object.hasOwn(first.values, String(c.staff)) && !Object.hasOwn(first.values, String(c.memo)) && !Object.hasOwn(first.values, String(c.consistency)), JSON.stringify(first));
  const unmapped = context.fleetPlanUpsert(headers, [base], { ...payload, label: 'new-host', mappedName: null });
  assert(unmapped.action === 'appended' && unmapped.values[c.consistency] === '未マッピング(要 fleet-pc-map.json 追記)', JSON.stringify(unmapped));
  const reordered = [...headers].reverse(); const rc = context.fleetResolveColumns(reordered); const planned = context.fleetPlanUpsert(reordered, [], { ...payload, mappedName: null });
  assert(planned.values[rc.hostname] === 'host' && rc.hostname !== c.hostname, JSON.stringify(planned));
});
test('fleet upsert純関数: 自己申告3列を書き、A〜E列とO列を保護してヘッダ並替えに追従', () => {
  const source = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'UpsertLogic.gs'), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);
  const headers = Object.values(context.FLEET_HEADERS_).reverse(); const c = context.fleetResolveColumns(headers);
  const row = headers.map(() => '');
  for (const key of ['staff', 'done', 'executed', 'selfPc', 'memo']) row[c[key]] = `保護-${key}`;
  row[c.hostname] = 'host'; row[c.consistency] = 'kim手書き';
  const plan = context.fleetPlanUpsert(headers, [row], { label: 'host', username: 'os-user', hostname: 'real-host', gitEmail: '未設定' });
  assert(plan.values[c.osUser] === 'os-user' && plan.values[c.realHostname] === 'real-host' && plan.values[c.gitEmail] === '未設定', JSON.stringify(plan));
  for (const key of ['staff', 'done', 'executed', 'selfPc', 'memo', 'consistency']) assert(!Object.hasOwn(plan.values, String(c[key])), `${key}列を上書き`);
});
test('fleet WebApp: 不足する自己申告ヘッダだけを右端に冪等追加', () => {
  const logic = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'UpsertLogic.gs'), 'utf8');
  const webapp = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'WebApp.gs'), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext((logic + '\n' + webapp).replace(/\bconst\s+/g, 'var '), context);
  const original = Object.values(context.FLEET_HEADERS_).filter((header) => !['OSユーザー名', '実ホスト名', 'Gitメール'].includes(header));
  const once = context.fleetPlanHeaders(original); const twice = context.fleetPlanHeaders(once);
  assert(JSON.stringify(once) === JSON.stringify(twice), JSON.stringify({ once, twice }));
  assert(JSON.stringify(once.slice(0, original.length)) === JSON.stringify(original) && once.slice(-3).join('|') === 'OSユーザー名|実ホスト名|Gitメール', JSON.stringify(once));
});
test('fleet upsert純関数: 紐付いた既存行のO列(kim手書き)は map 未登録でも保持し、空labelで行を奪わない', () => {
  const source = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'UpsertLogic.gs'), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);
  const headers = Object.values(context.FLEET_HEADERS_); const c = context.fleetResolveColumns(headers);
  // fleet-pc-map.json が空(={})の初期状態では mappedName が常に null になる。
  // それでも F列一致で既存行に紐付いたなら O列の手書きメモを潰してはいけない。
  const mapped = headers.map(() => ''); mapped[c.selfPc] = '金功勇PC'; mapped[c.hostname] = 'kim-PC'; mapped[c.consistency] = 'kim本人・要委譲徹底';
  const kept = context.fleetPlanUpsert(headers, [mapped], { label: 'kim-PC', mappedName: null });
  assert(kept.action === 'updated' && !Object.hasOwn(kept.values, String(c.consistency)), JSON.stringify(kept));
  // label が空でも「F列が空の行」に一致して他PCの行を奪わないこと(新規追記になる)。
  const blank = headers.map(() => ''); blank[c.selfPc] = '別PC';
  const noHijack = context.fleetPlanUpsert(headers, [blank], { label: '', mappedName: null });
  assert(noHijack.action === 'appended' && noHijack.rowIndex === 1, JSON.stringify(noHijack));
});
test('fleet upsert純関数: ヘッダの全角半角・空白差でも列を解決できる', () => {
  const source = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'UpsertLogic.gs'), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);
  const canonical = Object.values(context.FLEET_HEADERS_);
  // 実セルが全角括弧・前後空白・全角英数で書かれていても解決できること(実表記は目視できない)。
  const messy = canonical.map(function (h) { return ' ' + h.split('(').join('（').split(')').join('）') + ' '; });
  const c = context.fleetResolveColumns(messy);
  assert(Object.keys(c).length === canonical.length, JSON.stringify(c));
  const planned = context.fleetPlanUpsert(messy, [], { label: 'host-x', mappedName: null });
  assert(planned.action === 'appended' && planned.values[c.hostname] === 'host-x', JSON.stringify(planned));
});
test('fleet upsert純関数: D列重複でもF列labelで別行に入り他PCの行を奪わない', () => {
  const source = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'UpsertLogic.gs'), 'utf8');
  const context = {}; vm.createContext(context); vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);
  const headers = Object.values(context.FLEET_HEADERS_); const c = context.fleetResolveColumns(headers);
  const row1 = headers.map(() => ''); row1[c.selfPc] = '金功勇PC'; row1[c.hostname] = 'kim-PC';
  const row2 = headers.map(() => ''); row2[c.selfPc] = '金功勇PC'; row2[c.hostname] = 'kimko-PC';
  const payload = { label: 'kimko-PC', mappedName: '金功勇PC' };
  const existing = context.fleetPlanUpsert(headers, [row1, row2], payload);
  assert(existing.action === 'updated' && existing.rowIndex === 1, JSON.stringify(existing));
  const newPc = context.fleetPlanUpsert(headers, [row1, row2], { label: 'third-PC', mappedName: '金功勇PC' });
  assert(newPc.action === 'appended' && newPc.rowIndex === 2, JSON.stringify(newPc));
  const blank = headers.map(() => ''); blank[c.selfPc] = '金功勇PC';
  const bindBlank = context.fleetPlanUpsert(headers, [row1, blank], { label: 'third-PC', mappedName: '金功勇PC' });
  assert(bindBlank.action === 'updated' && bindBlank.rowIndex === 1 && bindBlank.values[c.hostname] === 'third-PC', JSON.stringify(bindBlank));
});
test('fleet WebApp: ヘッダタブ解決キャッシュとScriptLockを使う', () => {
  const source = fs.readFileSync(path.join(repo, 'gas', 'fleet-status-sheet', 'WebApp.gs'), 'utf8');
  assert(source.includes("getProperty('SHEET_TAB_NAME')") && source.includes('spreadsheet.getSheets()') && source.includes("throw new Error('fleet status tab not found')"), 'タブ解決要件が不足');
  assert(source.includes('LockService.getScriptLock()') && source.includes('tryLock(20000)') && source.includes("status: 503, error: 'busy'") && source.includes('lock.releaseLock()'), 'ロック要件が不足');
});

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nALL PASS');
