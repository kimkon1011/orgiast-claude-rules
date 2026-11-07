import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execute, buildPrompt } from './venue-search.mjs';

const argv = ['--region', '東京', '--capacity', '300', '--purpose', '学会シンポジウム'];
const venue = { name: '東京ホール', url: 'https://example.com/hall', capacityNote: '着席300名', accessNote: '駅徒歩5分', costNote: '50万円', boothNote: '天井高5m・電源あり', sourceQuery: '東京 学会' };
const search1 = { provider: 'gemini', answer: '東京ホールは300名。天井高5m。', urls: [{ url: venue.url, title: venue.name, snippet: '駅徒歩5分' }] };
const search2 = { provider: 'groq', answer: '展示設備についての検索回答', urls: [venue.url, 'https://example.com/second'] };

function harness(responses = [search1, search2, JSON.stringify([venue])]) {
  const calls = [];
  const writes = [];
  let output = '';
  let errors = '';
  const deps = {
    spawnFn(command, args, options) {
      const index = calls.length;
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { calls[index].killed = true; };
      queueMicrotask(() => {
        const response = responses[index];
        if (response?.hang) return;
        if (response instanceof Error) { child.emit('error', response); return; }
        if (response?.exitCode) {
          child.stderr.end('模擬CLIエラー');
          child.emit('close', response.exitCode);
          return;
        }
        child.stdout.end(typeof response === 'string' ? response : JSON.stringify(response));
        child.emit('close', 0);
      });
      return child;
    },
    writeFile: async (file, content) => { writes.push({ file, content }); },
    now: () => new Date(2026, 9, 10, 12, 34, 56),
    homeDir: path.join(os.tmpdir(), 'venue mock home'),
    stdout: { write: (text) => { output += text; } },
    stderr: { write: (text) => { errors += text; } },
  };
  return { deps, calls, writes, output: () => output, errors: () => errors };
}

test('要件を2本のクエリに含め、検索URLを重複除去してLLMへ渡す', async () => {
  const h = harness();
  assert.equal(await execute([...argv, '--provider', 'groq', '--timeout', '30'], h.deps), 0);
  assert.equal(h.calls.length, 3);
  for (const call of h.calls.slice(0, 2)) {
    assert.equal(call.command, process.execPath);
    assert.equal(path.basename(call.args[0]), 'web-search.mjs');
    for (const word of ['東京', '300', '学会シンポジウム']) assert.ok(call.args[1].includes(word));
    assert.deepEqual(call.args.slice(2), ['--json', '--provider', 'groq', '--timeout', '30']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, path.dirname(path.dirname(call.args[0])));
  }
  const llm = h.calls[2];
  assert.equal(path.basename(llm.args[0]), 'llm-ask.mjs');
  assert.deepEqual(llm.args.slice(1, 4), ['--provider', 'gemini', '--system']);
  const sources = JSON.parse(llm.args.at(-1).split('\n検索資料: ')[1]);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, venue.name);
  assert.match(sources[0].snippet, /駅徒歩5分/);
  assert.match(sources[0].snippet, /展示設備/);
});

for (const response of [JSON.stringify([venue]), `回答です\n\`\`\`json\n${JSON.stringify([venue])}\n\`\`\``, `抽出結果: ${JSON.stringify([venue])}\n以上`]) {
  test(`JSON抽出: ${response.slice(0, 15)}`, async () => {
    const h = harness([search1, search2, response]);
    assert.equal(await execute([...argv, '--date', '2026-12-01', '--budget', '50万円', '--notes', 'プロジェクター必須'], h.deps), 0);
    const report = h.writes[0].content;
    for (const text of ['# 会場候補レポート', '東京', '300名', '学会シンポジウム', '2026-12-01', '50万円', 'プロジェクター必須', '候補 1. 東京ホール', venue.url, venue.capacityNote, venue.accessNote, venue.boothNote, 'gemini, groq']) assert.ok(report.includes(text), text);
    assert.equal(h.writes[0].file, path.join(h.deps.homeDir, '.claude', 'venue-search', '20261010-123456-report.md'));
    assert.equal(h.output(), `report: ${h.writes[0].file}\ncandidates: 1\n`);
    assert.equal(h.errors(), '');
  });
}

for (const response of ['JSONではない', '[broken]', '[null]', '[{"name":5}]', JSON.stringify([{ ...venue, url: 'https://invented.example/hall' }])]) {
  test(`不正な抽出は検索生リストへフォールバック: ${response}`, async () => {
    const h = harness([search1, search2, response]);
    assert.equal(await execute(argv, h.deps), 0);
    assert.match(h.writes[0].content, /生リスト/);
    assert.match(h.writes[0].content, /候補 1. 東京ホール/);
    assert.match(h.writes[0].content, /候補 2. https:\/\/example.com\/second/);
    assert.match(h.writes[0].content, /- 定員: \n/);
    assert.match(h.output(), /candidates: 2\n$/);
  });
}

test('必須フラグ欠落はexitCode 2、日本語エラー、外部処理なし', async () => {
  for (const flag of ['--region', '--capacity', '--purpose']) {
    const args = [...argv];
    args.splice(args.indexOf(flag), 2);
    const h = harness();
    assert.equal(await execute(args, h.deps), 2);
    assert.ok(h.errors().includes(`必須オプション ${flag}`));
    assert.equal(h.calls.length, 0);
    assert.equal(h.writes.length, 0);
  }
});

test('不正な人数・秒数・プロバイダ・未知のフラグを拒否する', async () => {
  for (const extra of [['--capacity', '3.5'], ['--capacity', '0'], ['--capacity', '-1'], ['--capacity', 'abc'], ['--timeout', '0'], ['--timeout', 'Infinity'], ['--provider', 'unknown'], ['--unknown', 'x'], ['--notes']]) {
    const h = harness();
    assert.equal(await execute([...argv, ...extra], h.deps), 2);
    assert.equal(h.calls.length, 0);
  }
});

test('検索結果なしではLLMを呼ばず0件レポートを書く', async () => {
  const h = harness([{ urls: [] }, { urls: [] }]);
  assert.equal(await execute(argv, h.deps), 0);
  assert.equal(h.calls.length, 2);
  assert.match(h.output(), /candidates: 0/);
});

test('LLMの重複URLも除去する', async () => {
  const h = harness([search1, search2, JSON.stringify([venue, venue])]);
  assert.equal(await execute(argv, h.deps), 0);
  assert.match(h.output(), /candidates: 1/);
});

test('子CLIの異常終了・起動失敗・不正検索JSONを成功扱いしない', async () => {
  for (const responses of [[{ exitCode: 1 }], [new Error('起動失敗')], ['invalid json'], [{ answer: 'urls欠落' }, search2], [search1, search2, { exitCode: 1 }]]) {
    const h = harness(responses);
    assert.equal(await execute(argv, h.deps), 1);
    assert.match(h.errors(), /会場検索に失敗/);
    assert.equal(h.output(), '');
    assert.equal(h.writes.length, 0);
  }
});

test('タイムアウト時は子プロセスを停止する', async () => {
  const h = harness([{ hang: true }]);
  assert.equal(await execute([...argv, '--timeout', '0.01'], h.deps), 1);
  assert.equal(h.calls[0].killed, true);
  assert.match(h.errors(), /タイムアウト/);
});

test('空白・日本語パスの親ディレクトリを作成してレポートを保存する', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'venue-search-'));
  try {
    const out = path.join(dir, '会場 レポート', 'report.md');
    const h = harness();
    delete h.deps.writeFile;
    assert.equal(await execute([...argv, '--out', out], h.deps), 0);
    assert.match(await readFile(out, 'utf8'), /候補 1. 東京ホール/);
    assert.match(h.output(), /candidates: 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ファイル書き込み失敗時は成功出力をしない', async () => {
  const h = harness();
  h.deps.writeFile = async () => { throw new Error('書込失敗'); };
  assert.equal(await execute(argv, h.deps), 1);
  assert.equal(h.output(), '');
  assert.match(h.errors(), /書込失敗/);
});

test('buildPrompt は資料を12件・スニペット300字に制限する', () => {
  const sources = Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}`, title: `会場${i}`, snippet: 'x'.repeat(1000), sourceQuery: 'q' }));
  const prompt = buildPrompt({ region: '東京', capacity: 100, purpose: '学会' }, sources);
  const payload = JSON.parse(prompt.split('\n検索資料: ')[1]);
  assert.equal(payload.length, 12);
  assert.ok(payload.every((item) => item.snippet.length <= 300));
  assert.ok(prompt.length < 20000);
});
