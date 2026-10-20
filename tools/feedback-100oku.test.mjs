import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { buildEvalPrompt, buildReport, checkHealthUrls, evaluatePending, parseEvalJson, runMain } from './feedback-100oku.mjs';

const items = [{ key: 'a', kind: '要望', title: '受注改善', body: '継続率を上げる', status: 'new' }];

test('buildEvalPrompt は1行1件とJSON限定指示を含む', () => {
  const prompt = buildEvalPrompt([...items, { key: 'b', kind: '不具合', title: '停止', body: '開けない' }]);
  assert.match(prompt, /a\|要望\|受注改善\|継続率を上げる/);
  assert.match(prompt, /b\|不具合\|停止\|開けない/);
  assert.match(prompt, /JSON .*だけを返せ/);
});

test('parseEvalJson はJSON・フェンス・前後文に対応し不正JSONはnull', () => {
  const value = { a: { rank: 'A', reason: '売上' } };
  assert.deepEqual(parseEvalJson(JSON.stringify(value)), value);
  assert.deepEqual(parseEvalJson(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), value);
  assert.deepEqual(parseEvalJson(`前置き ${JSON.stringify(value)} 後置き`), value);
  assert.equal(parseEvalJson('{bad}'), null);
});

test('buildReport は集計・A最大10件・異常列挙・1900字制限に対応する', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ key: `a${index}`, title: `重要${index}`, source: index === 0 ? 'auto-health' : '' }));
  const ledger = { items: Object.fromEntries([...many.map((item) => [item.key, { rank: 'A', reason: '売上に効く' }]), ['b', { rank: 'B' }], ['c', { rank: 'C' }]]) };
  const report = buildReport([...many, { key: 'b' }, { key: 'c' }, { key: 'u' }], ledger, [{ url: 'https://bad.test', ok: false, status: 503 }], new Date('2026-09-19T00:00:00Z'));
  assert.equal((report.match(/^\[a\d+\]/gm) || []).length, 10);
  assert.match(report, /B: 1件 \/ C: 1件 \/ 未評価: 1件/);
  assert.match(report, /https:\/\/bad.test — HTTP 503/);
  assert.ok(report.length <= 1900);
  assert.match(buildReport([], { items: {} }, [], new Date('2026-09-19T00:00:00Z')), /未対応 0 件/);
});

test('ヘルスチェックはokを除外しngをstable keyで生成、disabledなら呼ばない', async () => {
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; return { ok: url.includes('ok'), status: url.includes('ok') ? 200 : 503 }; };
  const first = await checkHealthUrls(['https://ok.test/a', 'https://bad.test/health'], { fetchImpl, now: () => new Date('2026-09-19T00:00:00Z') });
  const second = await checkHealthUrls(['https://bad.test/health'], { fetchImpl });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].key, second.items[0].key);
  assert.equal(first.items[0].source, 'auto-health');
  await checkHealthUrls(['https://never.test'], { fetchImpl, disabled: true });
  assert.equal(calls, 3);
});

function spawnResult(text, onCall) {
  return (...args) => {
    onCall?.(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', text); child.emit('close', 0); });
    return child;
  };
}

for (const scenario of [
  { name: '初回タイムアウト後に成功', failures: 1, code: 0, waits: [1000] },
  { name: 'ネットワークエラー2回後に成功', failures: 2, code: 0, waits: [1000, 2000] },
  { name: '3回ともタイムアウト', failures: 3, code: 3, waits: [1000, 2000] },
]) {
  test(`runMain のヘルスチェック: ${scenario.name}`, async () => {
    const output = [];
    const waits = [];
    const signals = [];
    let calls = 0;
    const code = await runMain({
      args: ['--items-file', '/items.json', '--dry-run', '--no-llm', '--json', '--health-url', 'https://gas.test/exec'],
      home: '/test-home',
      io: {
        read: (file) => { if (file === '/items.json') return '{"items":[]}'; throw new Error('ENOENT'); },
        write: () => assert.fail('unexpected write'),
        now: () => new Date('2026-10-21T00:00:00Z'),
        stdout: (text) => output.push(JSON.parse(text)), stderr: () => {},
      },
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, 'https://gas.test/exec');
        assert.equal(options.redirect, 'follow');
        assert.ok(options.signal instanceof AbortSignal);
        signals.push(options.signal);
        if (calls <= scenario.failures) {
          if (scenario.failures === 2) throw new TypeError('fetch failed');
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        // fetch が GAS の302を追従した後の応答。
        return { ok: true, status: 200, redirected: true };
      },
      sleepImpl: async (ms) => { waits.push(ms); },
      spawnImpl: () => assert.fail('unexpected LLM call'),
      notifyImpl: () => assert.fail('unexpected notification'),
    });
    assert.equal(code, scenario.code);
    assert.equal(calls, Math.min(scenario.failures + 1, 3));
    assert.equal(new Set(signals).size, calls, '各試行に新しいタイムアウトを設定する');
    assert.deepEqual(waits, scenario.waits);
    assert.equal(output.length, 1);
    assert.deepEqual(output[0].health, [{
      url: 'https://gas.test/exec', ok: code === 0, status: code === 0 ? 200 : 0,
      error: code === 0 ? '' : 'The operation was aborted due to timeout',
      retries: calls - 1,
    }]);
    if (code === 3) assert.match(output[0].report, /【自動検知の異常】/);
    else assert.doesNotMatch(output[0].report, /【自動検知の異常】/);
  });
}

test('リダイレクト先のHTTP障害は再試行で隠さず報告する', async () => {
  const health = await checkHealthUrls(['https://gas.test/exec'], {
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'follow');
      return { ok: false, status: 503, redirected: true };
    },
    sleepImpl: () => assert.fail('HTTPエラーでは再試行しない'),
  });
  assert.equal(health.results[0].ok, false);
  assert.equal(health.results[0].error, 'HTTP 503');
  assert.equal(health.results[0].retries, 0);
  assert.equal(health.items.length, 1);
});

test('台帳は既評価をスキップし未評価だけ1回のLLMで追加する', async () => {
  const ledger = { version: 1, items: { old: { rank: 'B' } } };
  let calls = 0; let commandArgs;
  const spawnImpl = spawnResult('{"fresh":{"rank":"A","reason":"受注増"}}', (args) => { calls += 1; commandArgs = args; });
  const result = await evaluatePending([{ key: 'old' }, { key: 'fresh', kind: '要望', title: '改善' }], ledger, { spawnImpl, now: () => new Date('2026-09-19T00:00:00Z'), toolDir: '/repo/tools' });
  assert.deepEqual(result, { attempted: 1, added: 1 });
  assert.equal(calls, 1);
  assert.match(commandArgs[1].at(-1), /fresh/);
  assert.doesNotMatch(commandArgs[1].at(-1), /old\|/);
  assert.equal(ledger.items.fresh.model, 'groq');
});

test('runMain はitems-file・dry-run・no-llmで異常を報告しexit 3', async () => {
  const home = path.join(path.sep, 'home', 'test');
  const files = new Map([['/items.json', JSON.stringify({ items })]]);
  const stdout = []; const writes = [];
  const io = {
    read: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    write: (file, text) => { writes.push(file); files.set(file, text); }, exists: (file) => files.has(file),
    now: () => new Date('2026-09-19T00:00:00Z'), stdout: (text) => stdout.push(text), stderr: () => {},
  };
  let spawned = 0;
  const code = await runMain({ args: ['--items-file', '/items.json', '--dry-run', '--no-llm', '--health-url', 'https://bad.test'], home, io, fetchImpl: async () => ({ ok: false, status: 500 }), spawnImpl: () => { spawned += 1; } });
  assert.equal(code, 3);
  assert.equal(spawned, 0);
  assert.equal(writes.length, 0);
  assert.match(stdout.join('\n'), /自動検知 1 件/);
});

test('runMain はA案件・異常が無いときはDMを送らない（feedback-nagとの二重報告防止）', async () => {
  const home = path.join(path.sep, 'home', 'test');
  const itemsFile = path.join(home, 'items.json');
  const files = new Map([
    [itemsFile, JSON.stringify({ items })],
    [path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'token'],
    [path.join(home, '.claude', 'orgiast-discord-user-id.txt'), 'user'],
  ]);
  const stdout = [];
  const io = {
    read: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    write: (file, text) => files.set(file, text), exists: (file) => files.has(file),
    now: () => new Date('2026-09-19T00:00:00Z'), stdout: (text) => stdout.push(text), stderr: () => {},
  };
  let notified = 0;
  const code = await runMain({
    args: ['--items-file', itemsFile, '--no-llm', '--no-health'],
    home, io, fetchImpl: async () => ({ ok: true, status: 200 }),
    spawnImpl: spawnResult('{}'), notifyImpl: async () => { notified += 1; return { delivered: 'dm' }; },
  });
  assert.equal(code, 0);
  assert.equal(notified, 0, 'A・異常ゼロの夜に notify してはならない');
  assert.match(stdout.join('\n'), /未対応 1 件/);
});

test('runMain はA案件があるときだけDMを送る', async () => {
  const home = path.join(path.sep, 'home', 'test');
  const itemsFile = path.join(home, 'items.json');
  const files = new Map([
    [itemsFile, JSON.stringify({ items })],
    [path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'token'],
    [path.join(home, '.claude', 'orgiast-discord-user-id.txt'), 'user'],
    [path.join(home, '.claude', 'feedback-100oku-ledger.json'), JSON.stringify({ version: 1, items: { a: { rank: 'A', reason: '受注直結' } } })],
  ]);
  const stdout = [];
  const io = {
    read: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    write: (file, text) => files.set(file, text), exists: (file) => files.has(file),
    now: () => new Date('2026-09-19T00:00:00Z'), stdout: (text) => stdout.push(text), stderr: () => {},
  };
  let notified = 0; let report = '';
  const code = await runMain({
    args: ['--items-file', itemsFile, '--no-llm', '--no-health'],
    home, io, fetchImpl: async () => ({ ok: true, status: 200 }),
    spawnImpl: spawnResult('{}'), notifyImpl: async (text) => { notified += 1; report = text; return { delivered: 'dm' }; },
  });
  assert.equal(code, 0);
  assert.equal(notified, 1);
  assert.match(report, /【A・100億円直結】/);
});
