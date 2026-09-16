import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeRecord, llmFailureReason } from './session-auto-close.mjs';

const execFileAsync = promisify(execFile);
const sessionId = 'f84f4059-586b-4161-a9ab-c026ad9adb7e';
const closedAt = '2026-09-14T00:00:00.000Z';

function record(overrides = {}) {
  return {
    sessionId,
    status: '要確認',
    ageDays: 45,
    displayTitle: '残作業の確認',
    cwd: 'fixture',
    file: 'fixture.jsonl',
    mtime: '2026-07-31T00:00:00.000Z',
    nextAction: '',
    llm: { verdict: '不明', confidence: 0, next: '' },
    ...overrides,
  };
}

for (const [name, input, expected] of [
  ['llmフィールド無し', {}, '(llmフィールド無し)'],
  ['verdict=失敗', { llm: { verdict: '失敗', confidence: 0 } }, '(verdict=失敗)'],
  ['verdict=不明', { llm: { verdict: '不明', confidence: 0 } }, '(verdict=不明)'],
  ['confidence<60', { llm: { verdict: '未完了', confidence: 42 } }, '(confidence=42 <60)'],
]) {
  test(`llmFailureReason: ${name}`, () => {
    assert.equal(llmFailureReason(input), expected);
  });
}

test('llmFailureReason: errorを改行なしで理由に続ける', () => {
  assert.equal(
    llmFailureReason({ llm: { verdict: '失敗', confidence: 0, error: 'groq:\n  LLM応答を解析できません' } }),
    '(verdict=失敗) groq: LLM応答を解析できません',
  );
});

test('llmFailureReason: 既存の失敗条件の真偽値を維持する', () => {
  const values = [
    undefined, null, false,
    { verdict: '失敗', confidence: 100 },
    { verdict: '不明', confidence: 100 },
    { verdict: '未完了', confidence: 59 },
    { verdict: '未完了', confidence: 60 },
    { verdict: '完了', confidence: 100 },
    { verdict: '完了', confidence: '42' },
    { verdict: '完了', confidence: undefined },
    { verdict: '完了', confidence: NaN },
  ];
  for (const llm of values) {
    const input = { llm };
    const before = !input.llm || input.llm.verdict === '失敗' || input.llm.verdict === '不明' || input.llm.confidence < 60;
    assert.equal(Boolean(llmFailureReason(input)), before);
  }
});

test('3回連続失敗は3回目に記帳し、古いsessionsと別セッションの回数を保持する', () => {
  let ledger = {
    version: 1,
    sessions: { existing: { reason: 'completed', title: '既存' } },
  };
  for (let count = 1; count <= 3; count++) {
    const outcome = closeRecord(record(), ledger, { closedAt });
    assert.equal(outcome.streak, count);
    assert.equal(outcome.deferred, count < 3);
    assert.equal(outcome.llmFallback, count === 3);
    assert.equal(ledger.llmFailureStreak[sessionId], count);
    if (count < 3) assert.equal(ledger.sessions[sessionId], undefined);
    ledger = JSON.parse(JSON.stringify(ledger));
    ledger.llmFailureStreak.other = 2;
  }
  assert.equal(ledger.sessions[sessionId].reason, 'handoff');
  assert.equal(ledger.sessions[sessionId].llmFallback, true);
  assert.equal(ledger.sessions[sessionId].closedAt, closedAt);
  assert.equal(ledger.sessions[sessionId].nextAction, 'セッションを再開して残作業を確認する');
  assert.deepEqual(ledger.sessions.existing, { reason: 'completed', title: '既存' });
  assert.equal(ledger.llmFailureStreak.other, 2);
});

for (const [status, ageDays, expected] of [
  ['完了っぽい', 30, 'completed'],
  ['完了っぽい', 29.9, 'handoff'],
  ['要確認', 90, 'handoff'],
]) {
  test(`フォールバックと--no-llmは同じ規則: ${status}/${ageDays}日`, () => {
    const input = record({ status, ageDays });
    const fallbackLedger = { version: 1, sessions: {}, llmFailureStreak: { [sessionId]: 2 } };
    const noLlmLedger = { version: 1, sessions: {} };
    const fallback = closeRecord(input, fallbackLedger, { closedAt });
    const deterministic = closeRecord(input, noLlmLedger, { noLlm: true, closedAt });
    assert.equal(fallback.reason, expected);
    assert.equal(deterministic.reason, expected);
    assert.equal(fallbackLedger.sessions[sessionId].llmFallback, true);
    assert.equal(Object.hasOwn(noLlmLedger.sessions[sessionId], 'llmFallback'), false);
  });
}

test('途中の成功は失敗カウンタを削除し、再判定時の失敗は1から始まる', () => {
  const ledger = { version: 1, sessions: {} };
  closeRecord(record(), ledger, { closedAt });
  closeRecord(record(), ledger, { closedAt });
  const success = closeRecord(record({ llm: { verdict: '完了', confidence: 90 } }), ledger, { closedAt });
  assert.equal(success.deferred, false);
  assert.equal(success.reason, 'completed');
  assert.equal(Object.hasOwn(ledger.llmFailureStreak, sessionId), false);
  assert.equal(Object.hasOwn(ledger.sessions[sessionId], 'llmFallback'), false);

  // --forceによる再判定相当。以前の成功より前の失敗回数を引き継がない。
  const failedAgain = closeRecord(record(), ledger, { closedAt });
  assert.equal(failedAgain.streak, 1);
  assert.equal(failedAgain.deferred, true);
});

test('低confidenceも連続失敗として数え、confidence=60の成功で削除する', () => {
  const ledger = { version: 1, sessions: {} };
  const low = record({ llm: { verdict: '完了', confidence: 42 } });
  assert.equal(closeRecord(low, ledger).streak, 1);
  assert.equal(closeRecord(low, ledger).streak, 2);
  const success = closeRecord(record({ llm: { verdict: '未完了', confidence: 60 } }), ledger);
  assert.equal(success.reason, 'handoff');
  assert.equal(success.llmFallback, false);
  assert.equal(Object.hasOwn(ledger.llmFailureStreak, sessionId), false);
});

// 実CLIを一時ディレクトリで動かす。台帳の保存条件、再読込、exit code、dryを検証する。
// homedirだけを固定し、実際の~/.claudeには一切触れない。triageは固定応答を返す。
async function autoCloseFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-auto-close-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'session-auto-close.mjs');
  const source = await fs.readFile(new URL('./session-auto-close.mjs', import.meta.url), 'utf8');
  const redactUrl = new URL('./redact-secrets.mjs', import.meta.url).href;
  const isEntryUrl = new URL('./is-entry.mjs', import.meta.url).href;
  await fs.writeFile(script, source
    .replace("import os from 'node:os';", 'const os = { homedir: () => process.env.AUTO_CLOSE_TEST_HOME };')
    .replace("'./redact-secrets.mjs'", JSON.stringify(redactUrl))
    .replace("'./is-entry.mjs'", JSON.stringify(isEntryUrl)), 'utf8');
  const inputPath = path.join(root, 'triage-result.json');
  await fs.writeFile(path.join(root, 'session-triage.mjs'), `
import { readFile } from 'node:fs/promises';
process.stdout.write(await readFile(process.env.AUTO_CLOSE_TEST_INPUT, 'utf8'));
`, 'utf8');
  const claude = path.join(root, '.claude');
  const ledger = path.join(claude, 'session-closed-ledger.json');
  const handoffs = path.join(claude, 'session-handoffs.md');
  return {
    ledger,
    handoffs,
    async run(sessions, args = []) {
      await fs.writeFile(inputPath, JSON.stringify({
        summary: { counts: { '要確認': sessions.length } },
        sessions,
      }), 'utf8');
      try {
        const result = await execFileAsync(process.execPath, [script, ...args], {
          timeout: 30_000,
          env: {
            ...process.env,
            AUTO_CLOSE_TEST_HOME: root,
            AUTO_CLOSE_TEST_INPUT: inputPath,
          },
        });
        return { ...result, code: 0 };
      } catch (error) {
        if (typeof error.code !== 'number') throw error;
        return { stdout: error.stdout, stderr: error.stderr, code: error.code };
      }
    },
    async readLedger() {
      return JSON.parse(await fs.readFile(ledger, 'utf8'));
    },
  };
}

test('CLI: 記帳ゼロの失敗回も永続化し、3回目はexit 0と引き継ぎになる', async (t) => {
  const fixture = await autoCloseFixture(t);
  for (let count = 1; count <= 3; count++) {
    const result = await fixture.run([record()]);
    assert.equal(result.code, count < 3 ? 1 : 0, result.stderr);
    const ledger = await fixture.readLedger();
    assert.equal(ledger.llmFailureStreak[sessionId], count);
    if (count < 3) {
      assert.equal(ledger.sessions[sessionId], undefined);
      assert.match(result.stdout, /LLM判定失敗 1件 \(不明 1件\)/);
      assert.match(result.stdout, /LLM判定失敗 \(verdict=不明\)/);
      await assert.rejects(fs.readFile(fixture.handoffs), { code: 'ENOENT' });
    } else {
      assert.equal(ledger.sessions[sessionId].reason, 'handoff');
      assert.equal(ledger.sessions[sessionId].llmFallback, true);
      assert.match(result.stdout, /llmFallback=true/);
      assert.match(result.stdout, /LLM判定失敗 0件/);
      assert.match(await fs.readFile(fixture.handoffs, 'utf8'), new RegExp(`<!-- SESSION:${sessionId} -->`));
    }
  }
  const ledgerBefore = await fs.readFile(fixture.ledger, 'utf8');
  const handoffsBefore = await fs.readFile(fixture.handoffs, 'utf8');
  const fourth = await fixture.run([record()]);
  assert.equal(fourth.code, 0);
  assert.match(fourth.stdout, /既クローズ 1件/);
  assert.equal(await fs.readFile(fixture.ledger, 'utf8'), ledgerBefore);
  assert.equal(await fs.readFile(fixture.handoffs, 'utf8'), handoffsBefore);
});

test('CLI: 成功時のカウンタ削除を保存する', async (t) => {
  const fixture = await autoCloseFixture(t);
  assert.equal((await fixture.run([record()])).code, 1);
  assert.equal((await fixture.run([record()])).code, 1);
  const result = await fixture.run([record({ llm: { verdict: '完了', confidence: 90 } })]);
  assert.equal(result.code, 0, result.stderr);
  const ledger = await fixture.readLedger();
  assert.equal(Object.hasOwn(ledger.llmFailureStreak, sessionId), false);
  assert.equal(ledger.sessions[sessionId].reason, 'completed');
  assert.equal(Object.hasOwn(ledger.sessions[sessionId], 'llmFallback'), false);
});

test('CLI: dry-runは新規台帳を作らず、既存の連続回数も進めない', async (t) => {
  const fixture = await autoCloseFixture(t);
  assert.equal((await fixture.run([record()], ['--dry'])).code, 1);
  await assert.rejects(fs.readFile(fixture.ledger), { code: 'ENOENT' });
  assert.equal((await fixture.run([record()])).code, 1);
  assert.equal((await fixture.run([record()])).code, 1);
  const before = await fs.readFile(fixture.ledger, 'utf8');
  const dryResult = await fixture.run([record()], ['--dry']);
  assert.equal(dryResult.code, 0, dryResult.stderr);
  assert.match(dryResult.stdout, /\[dry\].*llmFallback=true/);
  assert.equal(await fs.readFile(fixture.ledger, 'utf8'), before);
  await assert.rejects(fs.readFile(fixture.handoffs), { code: 'ENOENT' });
});

test('CLI: 4種類の失敗理由を行ごとに表示し、集計には内訳を出す', async (t) => {
  const fixture = await autoCloseFixture(t);
  const sessions = [
    record({ sessionId: '11111111-1111-4111-8111-111111111111', llm: undefined }),
    record({ sessionId: '22222222-2222-4222-8222-222222222222', llm: { verdict: '失敗', confidence: 0, error: 'provider: 解析不能' } }),
    record({ sessionId: '33333333-3333-4333-8333-333333333333' }),
    record({ sessionId: '44444444-4444-4444-8444-444444444444', llm: { verdict: '未完了', confidence: 42 } }),
  ];
  const result = await fixture.run(sessions);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /LLM判定失敗 \(llmフィールド無し\)/);
  assert.match(result.stdout, /LLM判定失敗 \(verdict=失敗\) provider: 解析不能/);
  assert.match(result.stdout, /LLM判定失敗 \(verdict=不明\)/);
  assert.match(result.stdout, /LLM判定失敗 \(confidence=42 <60\)/);
  assert.match(result.stderr, /LLM判定失敗 4件 \(llmフィールド無し 1件、失敗 1件、不明 1件、confidence<60 1件\)/);
});
