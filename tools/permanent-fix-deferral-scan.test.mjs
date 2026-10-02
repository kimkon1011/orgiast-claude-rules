import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scan, detect } from './permanent-fix-deferral-scan.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deferral-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  return home;
}
test('3台帳で先送り・待機を検出し、無関係な行を除外、sinceと日別集計を適用', t => {
  const home = fixture(t);
  const quotes = ['恒久修正は次セッションで行う', '後日に実装する', '少々お待ちください', '修正が完了しました'];
  for (const source of scan({ home }).sources) {
    const entries = quotes.map((quote, i) => ({ ts: `2026-09-${i === 0 ? '24' : '26'}T00:00:00Z`, verdict: 'pass', sessionId: 'abcdefgh1234', excerpt: quote, violations: [{ quote }] }));
    fs.writeFileSync(source.file, entries.map(JSON.stringify).join('\n') + '\nmalformed\nnull\n');
  }
  for (const source of scan({ home }).sources) {
    assert.equal(source.total, 6);
    assert.equal(source.hits, 3);
    assert.deepEqual(source.byDay, { '2026-09-24': 1, '2026-09-26': 2 });
    assert.equal(source.rows[0].match, quotes[0]);
    assert.equal(source.rows[0].sessionId, 'abcdefgh1234');
  }
  for (const source of scan({ home, since: '2026-09-26T00:00:00Z' }).sources) {
    assert.equal(source.hits, 2);
    assert.equal(source.total, 6);
  }
});
test('untilで上限を切れる（境界のts===untilは含めない）', t => {
  const home = fixture(t);
  const quotes = ['恒久修正は次セッションで行う'];
  for (const source of scan({ home }).sources) {
    const entries = [
      { ts: '2026-09-24T00:00:00Z', sessionId: 'before', excerpt: quotes[0], violations: [{ quote: quotes[0] }] },
      { ts: '2026-09-26T00:00:00Z', sessionId: 'boundary', excerpt: quotes[0], violations: [{ quote: quotes[0] }] }
    ];
    fs.writeFileSync(source.file, entries.map(JSON.stringify).join('\n') + '\n');
  }
  for (const source of scan({ home, until: '2026-09-26T00:00:00Z' }).sources) {
    assert.equal(source.hits, 1);
    assert.equal(source.rows[0].sessionId, 'before');
  }
  for (const source of scan({ home, since: '2026-09-24T00:00:00Z', until: '2026-09-26T00:00:00Z' }).sources) {
    assert.equal(source.hits, 1);
    assert.equal(source.rows[0].sessionId, 'before');
    assert.equal(source.total, 2);
  }
  for (const source of scan({ home, since: '2026-09-26T00:00:00Z', until: '2026-09-26T00:00:00Z' }).sources) {
    assert.equal(source.hits, 0);
  }
});
test('台帳がなくても空のレポートを返す', t => {
  for (const source of scan({ home: fixture(t) }).sources) {
    assert.equal(source.hits, 0);
    assert.equal(source.total, 0);
    assert.deepEqual(source.rows, []);
  }
});
test('CLIはJSON・人間向け表示・不正ISOの終了コードを守る', t => {
  const home = fixture(t);
  const run = args => spawnSync(process.execPath, [path.join(import.meta.dirname, 'permanent-fix-deferral-scan.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const json = run(['--json']);
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).sources.length, 3);
  assert.match(run([]).stdout, /hits=0 \/ 0/);
  for (const value of ['invalid', '2026-02-30T00:00:00Z', '']) {
    const result = run(['--since', value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
});

test('CLIの--untilは不正ISOでexit 2、正常値では窓を絞る', t => {
  const home = fixture(t);
  const run = args => spawnSync(process.execPath, [path.join(import.meta.dirname, 'permanent-fix-deferral-scan.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  for (const value of ['invalid', '2026-02-30T00:00:00Z', '']) {
    const result = run(['--until', value]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
  fs.writeFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'),
    JSON.stringify({ ts: '2026-09-26T00:00:00Z', excerpt: '恒久修正は次セッションで行う' }) + '\n');
  assert.match(run(['--until', '2026-09-26T00:00:00Z']).stdout, /stop-gate-runner-ledger\.jsonl: hits=0 \/ 1/);
});
test('既知の実違反原文を検出する', () => {
  const quotes = [
    'やりますか。これは配布の挙動を変えるので、勝手には進めません。',
    `次に kim がすること: \`task:nightly\` に自動修復を付けてよいかの可否。Codex のサインインも未実施のままです。`
  ];
  for (const quote of quotes) assert.ok(detect(quote).length >= 1, quote);
  assert.equal(detect(quotes[0])[0].pattern, 'P4');
  assert.equal(detect(quotes[1])[0].pattern, 'P3');
});
test('手渡しなし・進捗報告・修正完了は検出しない', () => {
  for (const quote of [
    '次に kim がすること: なし',
    '次に kim がすること: ありません（このタスクは自動完結。強いて言えば、明朝の price-snapshots を次セッションが読み戻します）',
    '修正が完了しました'
  ]) assert.deepEqual(detect(quote), [], quote);
});
test('委譲の完了待ちはW(待機)であって先送り(P1-P4)ではない', () => {
  const quote = 'Codex の2本の完了を待っています。';
  assert.deepEqual(detect(quote).map(found => found.pattern), ['W']);
});
test('全台帳で最初の一致だけをパターン別に集計する', t => {
  const home = fixture(t);
  const quotes = ['恒久修正は次セッションで行う', '後日に実装する',
    '次に kim がすること: 自動修復の可否', 'やりますか。配布を変えます。', '少々お待ちください'];
  for (const source of scan({ home }).sources) {
    assert.deepEqual(source.byPattern, { P1: 0, P2: 0, P3: 0, P4: 0, W: 0 });
    fs.writeFileSync(source.file, quotes.map(quote => JSON.stringify({
      ts: '2026-09-26T00:00:00Z', excerpt: quote, violations: [{ quote }]
    })).join('\n'));
  }
  for (const source of scan({ home }).sources) {
    assert.equal(source.hits, 5);
    assert.deepEqual(source.byPattern, { P1: 1, P2: 1, P3: 1, P4: 1, W: 1 });
    assert.deepEqual(source.rows.map(row => row.pattern), ['P1', 'P2', 'P3', 'P4', 'W']);
  }
});

test('連結で境界を越えた別引用の語では誤検出しない', t => {
  const home = fixture(t);
  const entry = {
    ts: '2026-09-30T18:03:05.859Z',
    excerpt: '一致しない引用',
    violations: [
      { quote: '次に kim がすること: PR #14 を確認（マージ判断のみ）。Vercel Previewでの動作確認も可能です' },
      { quote: 'ご指摘を恒久ルールとして保存しました' },
      { quote: 'この後の自動進行: なし' }
    ]
  };
  for (const source of scan({ home }).sources) fs.writeFileSync(source.file, `${JSON.stringify(entry)}\n`);
  for (const source of scan({ home }).sources) {
    assert.equal(source.hits, 0);
    assert.deepEqual(source.byPattern, { P1: 0, P2: 0, P3: 0, P4: 0, W: 0 });
  }
});

test('handoff行自体に修正語がある場合は引き続き検出する', t => {
  const home = fixture(t);
  const entry = {
    ts: '2026-09-30T18:03:05.859Z',
    excerpt: '次に kim がすること: 自動修復の恒久化を次回に回す',
    violations: [{ quote: '次に kim がすること: 自動修復の恒久化を次回に回す' }]
  };
  for (const source of scan({ home }).sources) fs.writeFileSync(source.file, `${JSON.stringify(entry)}\n`);
  for (const source of scan({ home }).sources) {
    assert.equal(source.hits, 1);
    assert.equal(source.byPattern.P3, 1);
  }
});
