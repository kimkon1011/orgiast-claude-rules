import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ACTIONS,
  PAYLOAD_HINTS,
  buildTriggerPrompt,
  parseActionArgs,
  validateAction,
} from './remote-trigger.mjs';

const tool = fileURLToPath(new URL('./remote-trigger.mjs', import.meta.url));

// 実測で get_run_log の run 識別子は session_id だった（run_id ではない）。
// 引数名を間違えるとエラーにならず空振りするため、うっかり run_id に戻さないよう固定する。
test('PAYLOAD_HINTS: get_run_log は session_id を使う（run_id ではない）', () => {
  assert.match(PAYLOAD_HINTS.get_run_log, /"session_id":"cse_/);
  assert.doesNotMatch(PAYLOAD_HINTS.get_run_log, /run_id/);
  assert.match(PAYLOAD_HINTS.run, /"trigger_id":"trig_/);
  assert.match(PAYLOAD_HINTS.list_runs, /"trigger_id":"trig_/);
});

test('validateAction: 既知のアクションは通過し、未知のアクションは例外を投げる', () => {
  assert.equal(validateAction('run'), 'run');
  assert.equal(validateAction('list_triggers'), 'list_triggers');
  assert.equal(validateAction('get_run_log'), 'get_run_log');

  for (const act of ACTIONS) {
    assert.equal(validateAction(act), act);
  }

  assert.throws(
    () => validateAction('unknown_action'),
    /未知の action です: unknown_action/
  );
  assert.throws(
    () => validateAction(''),
    /未知の action です:/
  );
});

test('parseActionArgs: payload を正しくパースする', () => {
  const parsed = parseActionArgs(['run', '{"trigger_id":"trig_x"}']);
  assert.equal(parsed.action, 'run');
  assert.deepEqual(parsed.payload, { trigger_id: 'trig_x' });
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.timeoutSec, 300);
  assert.equal(parsed.help, false);
});

test('parseActionArgs: 不正な JSON で例外を投げる', () => {
  assert.throws(
    () => parseActionArgs(['run', '{invalid-json']),
    /不正な JSON payload です/
  );
  assert.throws(
    () => parseActionArgs(['run', '123']),
    /不正な JSON payload です: payload は JSON オブジェクトである必要があります/
  );
  assert.throws(
    () => parseActionArgs(['run', '["array"]']),
    /不正な JSON payload です: payload は JSON オブジェクトである必要があります/
  );
});

test('parseActionArgs: payload 省略時は空オブジェクトとなりオプションを解釈する', () => {
  const parsed = parseActionArgs(['list_triggers', '--dry-run', '--timeout', '60']);
  assert.equal(parsed.action, 'list_triggers');
  assert.deepEqual(parsed.payload, {});
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.timeoutSec, 60);
});

test('buildTriggerPrompt: trig_x と "action":"run" が含まれるプロンプトを構築する', () => {
  const prompt = buildTriggerPrompt('run', { trigger_id: 'trig_x' });
  assert.match(prompt, /trig_x/);
  assert.match(prompt, /"action":"run"/);
  assert.match(
    prompt,
    /claude\.ai コネクタの RemoteTrigger ツールを、次の JSON を引数としてそのまま1回だけ呼び出してください/
  );
  assert.match(
    prompt,
    /ツールの戻り値だけを最終メッセージとして出力してください/
  );
  assert.match(
    prompt,
    /remote_trigger_unavailable/
  );
});

test('buildTriggerPrompt: payload 省略時は {"action":"<action>"} が組み立てられる', () => {
  const prompt = buildTriggerPrompt('list_triggers');
  assert.match(prompt, /\{"action":"list_triggers"\}/);
});

test('CLI --dry-run: 子プロセスを起動せず exit 0 で終了し正しい JSON を出力する', () => {
  const result = spawnSync(
    process.execPath,
    [tool, 'run', '{"trigger_id":"trig_x"}', '--dry-run'],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.action, 'run');
  assert.deepEqual(data.payload, { action: 'run', trigger_id: 'trig_x' });
  assert.match(data.prompt, /trig_x/);
  assert.match(data.prompt, /"action":"run"/);
  assert.equal(data.promptVia, 'stdin');
  assert.ok(data.promptChars > 0);
  assert.equal(typeof data.connectorCredentialPresent, 'boolean');
  assert.ok(Array.isArray(data.strippedKeys));
});

test('CLI --help / 引数なし: 使い方と ACTIONS 一覧を stderr に出力し exit 2 で終了する', () => {
  const resultNoArgs = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
  assert.equal(resultNoArgs.status, 2);
  assert.match(resultNoArgs.stderr, /使い方: node tools\/remote-trigger\.mjs/);
  assert.match(resultNoArgs.stderr, /list_triggers/);
  assert.match(resultNoArgs.stderr, /run/);

  const resultHelp = spawnSync(process.execPath, [tool, '--help'], { encoding: 'utf8' });
  assert.equal(resultHelp.status, 2);
  assert.match(resultHelp.stderr, /使い方: node tools\/remote-trigger\.mjs/);
});
