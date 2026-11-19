import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drw-${name}-`));
  return dir;
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

describe('delegation-ratio-watch', () => {
  for (const saver of ['saveResult', 'writeFixTicket']) {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      test(`${saver}: retries transient ${code} when concurrent tasks replace state`, async () => {
        const module = await import('./delegation-ratio-watch.mjs');
        const home = tmpHome('rename-retry');
        const delays = [];
        let attempts = 0;
        try {
          const file = module[saver]({ alert: true, reasons: ['previous'] }, home);
          const fsImpl = { ...fs, renameSync(from, to) {
            if (++attempts < 3) {
              assert.deepEqual(JSON.parse(fs.readFileSync(to, 'utf8')).reasons, ['previous']);
              throw Object.assign(new Error('sharing violation'), { code });
            }
            fs.renameSync(from, to);
          } };
          assert.equal(module[saver]({ alert: true, reasons: ['current'] }, home,
            { fsImpl, sleepImpl: ms => delays.push(ms) }), file);
          assert.equal(attempts, 3);
          assert.deepEqual(delays, [100, 200]);
          assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).reasons, ['current']);
          assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
      });
    }

    for (const [code, expectedAttempts] of [['EPERM', 21], ['ENOSPC', 1]]) {
      test(`${saver}: preserves previous state and reports persistent ${code}`, async () => {
        const module = await import('./delegation-ratio-watch.mjs');
        const home = tmpHome('rename-failure');
        let attempts = 0, waits = 0;
        const error = Object.assign(new Error('cannot replace state'), { code });
        try {
          const file = module[saver]({ alert: true, reasons: ['previous'] }, home);
          const fsImpl = { ...fs, renameSync() { attempts++; throw error; } };
          assert.throws(() => module[saver]({ alert: true, reasons: ['current'] }, home,
            { fsImpl, sleepImpl: () => waits++ }), e => e === error);
          assert.equal(attempts, expectedAttempts);
          assert.equal(waits, expectedAttempts - 1);
          assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).reasons, ['previous']);
          assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
      });
    }
  }

  test('安いAI実作業(out>200, ok)を正しく数える', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test1');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date(Date.now() - 3600000).toISOString(), provider: 'deepseek', model: 'deepseek-flash', status: 'ok', out: 500 },
        { t: new Date(Date.now() - 7200000).toISOString(), provider: 'groq', model: 'gpt-oss-120b', status: 'ok', out: 50 },
        { t: new Date(Date.now() - 1800000).toISOString(), provider: 'gemini', model: 'gemini-flash', status: 'ok', out: 300 },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.cheapAi.workCount, 2);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('deferred の no_fallback_flag と all_backends_failed を分けて数える', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test2');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'no_fallback_flag' },
        { t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'no_fallback_flag' },
        { t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'all_backends_failed' },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.deferred.noFallback, 2);
      assert.equal(result.deferred.allBackendsFailed, 1);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('24時間より古い行は集計しない', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test3');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date(Date.now() - 25 * 3600000).toISOString(), provider: 'deepseek', status: 'ok', out: 500 },
        { t: new Date(Date.now() - 3600000).toISOString(), provider: 'groq', status: 'ok', out: 300 },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.cheapAi.workCount, 1);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('quota_wait 中の呼出し数を lane-health.json から判定', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test4');
    try {
      const lh = path.join(home, '.claude', 'lane-health.json');
      fs.mkdirSync(path.dirname(lh), { recursive: true });
      fs.writeFileSync(lh, JSON.stringify({
        lanes: {
          glm: { alive: false, reason: 'quota_wait', until: Date.now() + 7 * 86400000 },
          groq: { alive: true, reason: 'probe_ok' },
        },
      }));
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      writeLines(usage, [
        { t: new Date().toISOString(), provider: 'glm', status: 'http_429' },
        { t: new Date().toISOString(), provider: 'glm', status: 'http_429' },
        { t: new Date().toISOString(), provider: 'groq', status: 'ok', out: 500 },
      ]);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.quotaWaitCalls, 2);
      assert.deepEqual(result.providers, ['glm']);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('deferred ≥ 10 で alert=true', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test5');
    try {
      const usage = path.join(home, '.claude', 'executor-usage.jsonl');
      fs.mkdirSync(path.dirname(usage), { recursive: true });
      const rows = [];
      for (let i = 0; i < 15; i++) {
        rows.push({ t: new Date().toISOString(), provider: 'codex', status: 'deferred', fallbackSkipped: 'no_fallback_flag' });
      }
      writeLines(usage, rows);
      const result = compute({ home, executorUsageFile: usage });
      assert.equal(result.alert, true);
      assert.ok(result.reasons.some(r => /deferred/.test(r)));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('weightedTokens: flat 形式 Opus=5, Sonnet=3, Haiku=1', async () => {
    const { weightedTokens } = await import('./delegation-ratio-watch.mjs');
    const base = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 };
    // Opus: 5 * (100 + 1.25*10 + 0.1*20 + 5*50) = 5 * 364.5 = 1822.5
    assert.equal(weightedTokens({ ...base, model: 'claude-opus-5-5' }), 1822.5);
    // Sonnet: 3 * 364.5 = 1093.5
    assert.equal(weightedTokens({ ...base, model: 'claude-sonnet-5-5' }), 1093.5);
    // Haiku: 1 * 364.5 = 364.5
    assert.equal(weightedTokens({ ...base, model: 'claude-haiku-5-5' }), 364.5);
  });

  // --- 新規テスト: 不具合1・2 の修正確認 ---

  test('ネスト形式（message.model / message.usage.*）で totalRows>0 かつ重み正しい', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test-nested');
    try {
      const projDir = path.join(home, '.claude', 'projects', 'test-project');
      fs.mkdirSync(projDir, { recursive: true });
      const now = Date.now();
      // 実データ形式: { type, timestamp, requestId, message: { id, model, usage: {...} } }
      writeLines(path.join(projDir, 'session.jsonl'), [
        {
          type: 'assistant',
          timestamp: new Date(now - 3600000).toISOString(),
          requestId: 'req-001',
          message: {
            id: 'msg-001',
            model: 'claude-opus-5-5',
            usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
          },
        },
        {
          type: 'assistant',
          timestamp: new Date(now - 7200000).toISOString(),
          requestId: 'req-002',
          message: {
            id: 'msg-002',
            model: 'claude-sonnet-5-5',
            usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
          },
        },
        {
          type: 'assistant',
          timestamp: new Date(now - 1800000).toISOString(),
          requestId: 'req-003',
          message: {
            id: 'msg-003',
            model: 'claude-haiku-5-5',
            usage: { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        },
      ]);
      const result = compute({ home, now });
      assert.equal(result.claude.totalRows, 3, 'totalRows should be 3');
      assert.ok(result.claude.totalWeighted > 0, 'totalWeighted should be > 0');
      // Opus: 5*(100+1.25*10+0.1*20+5*50) = 5*364.5 = 1822.5
      // Sonnet: 3*(200+0+0.1*50+5*100) = 3*(200+5+500) = 3*705 = 2115
      // Haiku: 1*(50+0+0+5*10) = 1*100 = 100
      // total = 1822.5+2115+100 = 4037.5, opusWeighted = 1822.5
      assert.equal(result.claude.totalWeighted, 4037.5);
      assert.equal(result.claude.opusWeighted, 1822.5);
      // opusRatio = 1822.5/4037.5 ≈ 45.14%
      assert.ok(result.claude.opusRatio < 50, `opusRatio should be < 50%, got ${result.claude.opusRatio}%`);
      assert.ok(result.claude.opusRatio > 40, `opusRatio should be > 40%, got ${result.claude.opusRatio}%`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('サブディレクトリの .jsonl も再帰的に収集する', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test-subdir');
    try {
      const projDir = path.join(home, '.claude', 'projects', 'test-project');
      const now = Date.now();
      // ルート直下
      writeLines(path.join(projDir, 'main.jsonl'), [
        {
          type: 'assistant', timestamp: new Date(now - 3600000).toISOString(), requestId: 'req-a',
          message: { id: 'msg-a', model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        },
      ]);
      // サブディレクトリ subagents/
      const subDir = path.join(projDir, 'subagents');
      fs.mkdirSync(subDir, { recursive: true });
      writeLines(path.join(subDir, 'agent-1.jsonl'), [
        {
          type: 'assistant', timestamp: new Date(now - 7200000).toISOString(), requestId: 'req-b',
          message: { id: 'msg-b', model: 'claude-opus-5-5', usage: { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        },
      ]);
      // mtime が since より古いファイル（25時間前のタイムスタンプで file 作成しても mtime は今なので、これは実際の mtime フィルタが効かない。
      // 代わりにファイルの中身の timestamp が古い → extractUsage で弾かれることを確認）
      writeLines(path.join(subDir, 'old-agent.jsonl'), [
        {
          type: 'assistant', timestamp: new Date(now - 25 * 3600000).toISOString(), requestId: 'req-old',
          message: { id: 'msg-old', model: 'claude-opus-5-5', usage: { input_tokens: 999, output_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        },
      ]);
      const result = compute({ home, now });
      // 2行（main + subagents/agent-1）。古い方は timestamp で弾かれる
      assert.equal(result.claude.totalRows, 2, 'should find rows in subdirectories too');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('message.id + requestId の重複行は1回だけ数える', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test-dedup');
    try {
      const projDir = path.join(home, '.claude', 'projects', 'test-project');
      fs.mkdirSync(projDir, { recursive: true });
      const now = Date.now();
      // 同じ message.id + requestId が2行（重複）
      const row = {
        type: 'assistant',
        timestamp: new Date(now - 3600000).toISOString(),
        requestId: 'req-001',
        message: {
          id: 'msg-001',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
        },
      };
      writeLines(path.join(projDir, 'session.jsonl'), [row, row]);
      const result = compute({ home, now });
      assert.equal(result.claude.totalRows, 1, 'duplicate rows should be counted once');
      // Opus weighted once = 5*(100+1.25*10+0.1*20+5*50) = 1822.5
      assert.equal(result.claude.totalWeighted, 1822.5);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('weightedTokens: ネスト形式（message.usage）も正しく計算', async () => {
    const { weightedTokens } = await import('./delegation-ratio-watch.mjs');
    const nested = {
      message: {
        model: 'claude-opus-5-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
      },
    };
    // 5*(100+1.25*10+0.1*20+5*50) = 1822.5
    assert.equal(weightedTokens(nested), 1822.5);

    const nestedSonnet = {
      message: {
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
      },
    };
    assert.equal(weightedTokens(nestedSonnet), 1093.5);
  });

  test('opusRatio: Opus 100% で正しく計算', async () => {
    const { compute } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test-opus-ratio');
    try {
      const projDir = path.join(home, '.claude', 'projects', 'test-project');
      fs.mkdirSync(projDir, { recursive: true });
      const now = Date.now();
      writeLines(path.join(projDir, 'session.jsonl'), [
        { type: 'assistant', timestamp: new Date(now - 3600000).toISOString(), requestId: 'req-1', message: { id: 'msg-1', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      ]);
      const result = compute({ home, now });
      assert.equal(result.claude.totalRows, 1);
      assert.equal(result.claude.opusRatio, 100, 'opusRatio should be 100% when only Opus');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('notifyInbox の引数が --add --body-file --kind --key 形式', async () => {
    const { notifyInbox } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test-inbox-args');
    let calledArgs = null;
    const execMock = (node, args) => { calledArgs = args; return { status: 0 }; };
    try {
      const result = {
        alert: true,
        reasons: ['代替されなかった deferred が 12 件（閾値 10）'],
        claude: { opusRatio: 80, totalWeighted: 5000, opusWeighted: 4000 },
        cheapAi: { workCount: 5 },
        deferred: { noFallback: 12, allBackendsFailed: 0 },
        quotaWaitCalls: 0,
      };
      notifyInbox(result, home, execMock);
      assert.ok(calledArgs, 'execImpl should be called');
      assert.ok(calledArgs.includes('--add'), `expected --add in ${JSON.stringify(calledArgs)}`);
      assert.ok(calledArgs.includes('--body-file'), `expected --body-file in ${JSON.stringify(calledArgs)}`);
      assert.ok(calledArgs.includes('--kind'), `expected --kind in ${JSON.stringify(calledArgs)}`);
      assert.ok(calledArgs.includes('info'), `expected info in ${JSON.stringify(calledArgs)}`);
      assert.ok(calledArgs.includes('--source'), `expected --source in ${JSON.stringify(calledArgs)}`);
      assert.ok(calledArgs.includes('delegation-ratio-watch'), `expected delegation-ratio-watch in ${JSON.stringify(calledArgs)}`);
      assert.ok(calledArgs.includes('--key'), `expected --key in ${JSON.stringify(calledArgs)}`);
      assert.ok(calledArgs.some(a => a.startsWith('delegation-ratio-')), `expected delegation-ratio-* key in ${JSON.stringify(calledArgs)}`);
      // --urgent は deferred≥10 && quotaWaitCalls≥50 の両方の時だけ。今回は quotaWaitCalls=0 なので付かない
      assert.ok(!calledArgs.includes('--urgent'), 'should not include --urgent when quotaWaitCalls < 50');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('notifyInbox: 深刻な異常では --urgent 付き', async () => {
    const { notifyInbox } = await import('./delegation-ratio-watch.mjs');
    const home = tmpHome('test-inbox-urgent');
    let calledArgs = null;
    const execMock = (node, args) => { calledArgs = args; return { status: 0 }; };
    try {
      const result = {
        alert: true,
        reasons: ['代替されなかった deferred が 12 件（閾値 10）', 'quota_wait 中の呼出しが 60 件（閾値 50）'],
        claude: { opusRatio: 80, totalWeighted: 5000, opusWeighted: 4000 },
        cheapAi: { workCount: 5 },
        deferred: { noFallback: 12, allBackendsFailed: 0 },
        quotaWaitCalls: 60,
      };
      notifyInbox(result, home, execMock);
      assert.ok(calledArgs.includes('--urgent'), 'should include --urgent when both deferred≥10 and quotaWaitCalls≥50');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('buildInboxText: kim が読んで判断できる形式', async () => {
    const { buildInboxText } = await import('./delegation-ratio-watch.mjs');
    const result = {
      reasons: ['代替されなかった deferred が 12 件（閾値 10）'],
      claude: { opusRatio: 75, totalWeighted: 5000 },
      cheapAi: { workCount: 5 },
      deferred: { noFallback: 12 },
      quotaWaitCalls: 3,
    };
    const text = buildInboxText(result);
    assert.ok(text.includes('委譲率異常'), 'should have subject line');
    assert.ok(text.includes('起きたこと'), 'should have "起きたこと" section');
    assert.ok(text.includes('deferred が 12 件'), 'should include specific numbers');
    assert.ok(text.includes('判断してほしいこと'), 'should have "判断してほしいこと"');
    assert.ok(text.includes('返事の例'), 'should have "返事の例"');
  });

  test('notifyInbox: alert=false では呼ばれない', async () => {
    const { notifyInbox } = await import('./delegation-ratio-watch.mjs');
    let called = false;
    const execMock = () => { called = true; };
    const result = { alert: false, reasons: [] };
    const r = notifyInbox(result, os.homedir(), execMock);
    assert.equal(r, null);
    assert.equal(called, false);
  });
});
