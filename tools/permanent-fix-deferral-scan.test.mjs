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
test('太字ラベル直後の「特になし」はP3と誤検出しない', () => {
  const excerpt = '**次に kim がすること:** 特になし（実装・テスト・check.py 実行まで完了）。';
  assert.deepEqual(detect(excerpt), []);
});
test('太字ラベル直後の恒久修正の先送りは引き続きP3で検出する', () => {
  const excerpt = '**次に kim がすること:** 自動修復の恒久化を次回に回す';
  assert.equal(detect(excerpt)[0].pattern, 'P3');
});
test('具体的なcommitまたはbranchのmain着地承認をkimに渡す文はP3で検出する', () => {
  for (const excerpt of [
    '次に kim がすること: `f94ee7a` を main にマージするか判断して承認する（承認が出るまでこのループは進まない）。',
    '次に kim がすること: `f94ee7a`（ブランチ `quota-sweep/20261023-0202-claude-mvkbrycs`）を main に着地させるか承認してください。それまでは据え置きです。',
    '次に kim がすること: f94ee7a を main にマージするかどうかを判断してください。'
  ]) assert.equal(detect(excerpt)[0].pattern, 'P3', excerpt);
});
test('着地承認ではない手渡しとなし表記はP3で検出しない', () => {
  for (const excerpt of [
    '次に kim がすること: PR #14 を確認（マージ判断のみ）。Vercel Previewでの動作確認も可能です',
    '次に kim がすること: なし（f94ee7a の main マージ承認は、次のループ周回で別途確認します）',
    '次に kim がすること: デスクトップの『GitHub認証（1回だけ）（ダブルクリック）.cmd』を1回実行してください',
    '次に kim がすること: f94ee7a の内容を確認して記録する'
  ]) assert.ok(!detect(excerpt).some(found => found.pattern === 'P3'), excerpt);
});
test('先送りを名詞句で説明した自己言及はP1と誤検出しない', () => {
  for (const quote of [
    '**[本セッションの目的]** handoff-audit が検出した「恒久修正の先送り文」が再発していないかを実物で検証し、結果を記録する。',
    '2026-10-01 検出の先送り2件（`299ef38c`/P1・`2811a555`/P2＝原価フロア実装の先送り）を実物検証し、記録を追記。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), [], quote);
});
test('名詞句でなく行為の先送りは引き続きP1で検出する', () => {
  for (const quote of ['恒久修正の対応は先送りする', 'この実装は先送りした']) {
    assert.equal(detect(quote)[0].pattern, 'P1', quote);
  }
});
test('監査項目名の引用（括弧で閉じた先送り＋直後が検証・記録）はP1と誤検出しない', () => {
  // 実測原文（stop-gate-runner-ledger.jsonl / 2026-10-06T18:23:57Z・2026-10-07T18:26:59Z）。
  // どちらも「監査項目ID（<項目名>の恒久修正先送り）」を引用した検証側の文で、先送りは実行されていない。
  for (const quote of [
    'dit:3d27cec1990452c9（event-shop.jp「AUJUST」誤記の恒久修正先送り）の再発を実物検証し記録 — 完了。 **やったこと** — 先送り検出器を実測',
    't `59f6caca0d69166e`（event-shop.jp「AUJUST」誤記の恒久修正先送り）の実物検証と記録 **やったこと** — 検出元 handoff の元ネタを実物で追跡。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), [], quote);
});
test('括弧で閉じていても直後が検証・記録でなければP1で検出する', () => {
  for (const quote of ['恒久修正を先送り）したまま次へ進む', '恒久修正は先送り）と決めた']) {
    assert.equal(detect(quote)[0].pattern, 'P1', quote);
  }
});
test('委譲の完了待ちはW(待機)であって先送り(P1-P4)ではない', () => {
  const quote = 'Codex の2本の完了を待っています。';
  assert.deepEqual(detect(quote).map(found => found.pattern), ['W']);
});
test('裸の待機文は夜間監査のWとして残す（Stopゲートは後続作業が無ければpass＝二段構え）', () => {
  // handoff-audit:6ac1c04694d4dc1c（2026-10-21T06:00:01.905Z / b822034d）の原文。
  // nightly は候補として surface し、deferral-wait-gate は後続作業の近接を条件に block する。
  const quote = 'Codex の修正完了を待っています。';
  assert.deepEqual(detect(quote).map(found => found.pattern), ['W']);
});
test('実測の名詞化した待機・完了通知待ちをWとして検出する', () => {
  for (const quote of [
    '事故の記録を memory に残しました。修復の書き込みが終わるのを待っています（終わると知らせが届きます）。',
    '今動いているのは2つで、どちらも終わると知らせが届きます。',
    'memory への記録は済みました。Codex の実装（ゲート3本・ルール本文・テスト・PR 作成）が終わるのを待っています。終わったら差分…',
    '書き込みを投入しました（42マス、終わったら5か所を読み戻します）。完了すると知らせが届くので、その時点で読み戻し結果を確認して報告します。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
});
test('他レーンの言い換えた完了待ちもWとして検出する（38fe8917 / 4d7e4383）', () => {
  // handoff-audit:38fe891783fc6ce2（05:14:03.146Z）の原文と、同じセッションが以後に閉じた 7 ターン。
  // 「完了待ちです」は旧 W で拾えていたが、「完了はまだです」「〜しているところです」
  // 「結果を待っています」は拾えず、8 ターン連続で待機したままターンを閉じていた。
  for (const quote of [
    'アプリ作りのセッションでは、Codex がアプリの実装を始めました。完了はまだです。',
    'アプリ作りのセッションは、実データを使って画面操作を確かめている最中です。承認 → 試し送り → PDF の取得、の順に見ています。完了はまだです。',
    'アプリ作りのセッションは、画面操作の確認を Edge ブラウザでやり直しているところです。まだ完了していません。',
    'アプリ作りのセッションは、アプリが作る金さん送付用画像の見た目を直し、もう一度実行しているところです。完了はまだです。',
    'アプリ作りのセッションは、PDF の修正を終えたあとの通し確認を、もう一度実行しているところです。完了はまだです。',
    'アプリ作りのセッションは、本番環境での動作確認の結果を待っています。確認が通ったら切り替える予定です。完了はまだです。',
    'アプリ作りのセッションは、本番で確認していて見つかった点を、Codex に直させているところです。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
});
test('返信待ち・結果待ちはWと誤検出しない', () => {
  for (const quote of [
    'ご返信をお待ちしています。',
    'サブエージェントの結果を待っています。'
  ]) assert.deepEqual(detect(quote), [], quote);
});
test('handoff-audit TODO の引用内にある待機・修正語を再検出しない', () => {
  const todos = [
    '16. [handoff-audit:655fbad73a29c865] 恒久修正の先送り文を検出（2026-10-12T11:08:57.526Z / a4c12da7 / W）「ィブ Codex が書き込みタスクで exit_null になる原因診断（Sonnet）の完了待ちです。 次に kim がすること: なし（Discord DM」 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: 違反セッションの先送りを当ターン内に実装まで終える（例: 2026-10-12T11:08:57.526Z / a4c12da7-a178-44cb-af93-3cbb39caaee7））。kimへのDMなし。',
    '17. [handoff-audit:ed21f8915eaaf823] 恒久修正の先送り文を検出（2026-10-12T10:44:41.681Z / 98dbc140 / P3）「次に kim がすること: ISSUES 1（`MailApproval_proposeFromLatest` に `attachmentIds` を接続）を修」 — この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: 違反セッションの先送りを当ターン内に実装まで終える（例: 2026-10-12T10:44:41.681Z / 98dbc140-9999-4123-b486-7725c1b90363））。kimへのDMなし。'
  ];
  for (const todo of todos) assert.deepEqual(detect(todo), [], todo);
});
test('監査引用ガードは素の待機文と引用外の待機文を抑制しない', () => {
  for (const quote of [
    'Codex の2本の完了を待っています。',
    '[handoff-audit:655fbad73a29c865] 恒久修正の先送り文を検出（W）「引用」検証の結果、Codex の2本の完了を待っています。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
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

test('実現可能性の名詞「〜可否」はP4と誤検出しない', () => {
  for (const quote of [
    'Codex のネイティブ実行可否（スモーク・書き込みテスト）と写真収集エージェントの結果待ちです。結果が揃い次第、実装を Codex か Sonnet エージェントのどちらかに投入します。',
    'cr@orgiast.jp の Fable 利用可否をローカル記録で確認し、実装の投入先を決めます。',
    'WSL 復旧の可否と codex レーンの生存を実測してから修正します。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), [], quote);
});

test('検出結果そのものを引用した検証 handoff は再検出しない', () => {
  // 実測原文（stop-gate-runner-ledger.jsonl / 2026-10-13T18:04:42.788Z / セッション 599d5772）。
  // 先送りを実行した文ではなく、検出器の出力（パターン名 `W` と一致語 "完了待ちで"）を引いた検証報告。
  const quote = '**やったこと:** 該当 handoff の原文再現と全台帳走査で再発の有無を実測し、検出器が自分の監査 TODO を引用文ごと再検出する経路を Codex レーンで塞いだ（記録 + PR #767）。\n**検証したこと:** 原文は `W`/`"完了待ちで"` で再現、以降のヒットは 3 件。';
  assert.deepEqual(detect(quote), []);
});

test('パターン名を伴わない引用文の待機語は引き続き検出する', () => {
  for (const quote of [
    '「納品の完了を待って」とだけ返事が来ました。',
    'pattern=W の一致語は "完了待ちで" です。' // pattern= 形式も引用として扱う
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), quote.startsWith('pattern=') ? [] : ['W'], quote);
});

test('疑問節つきの「可否」は引き続きP4で検出する', () => {
  for (const quote of [
    '次に kim がすること: 自動修復を付けてよいかの可否。',
    'この修正を進めてよいか可否を判断してください。'
  ]) assert.ok(detect(quote).some(found => found.pattern === 'P4'), quote);
});

test('検証報告が監査IDを参照して引用した待機文は再検出しない', () => {
  const excerpt = "**やったこと**: handoff-audit:3677714a0b69aad0（W / TJP-09「Codex の完了を待っています」）を実物検証し、runs/2026-10-14-2.summary.md に記録。**再発なし、かつ W ヒット自体が偽陽性**と確定 — 当該行は `verdict=skipped/reasonCodes=['stop_hook_active']`（Stop";
  assert.deepEqual(detect(excerpt), [], excerpt);
});
test('角括弧なしの off-audit 参照でも引用を監査引用とみなす', () => {
  const quote = 'off-audit:0123456789abcdef（W / TJP-09「Codex の完了を待っています」）を実物検証した。';
  assert.deepEqual(detect(quote), [], quote);
});
test('監査参照を知らない素の待機文・引用外の待機文は引き続きWとして検出する', () => {
  for (const quote of [
    'TJP-09 はまだ実装中です。Codex（DeepSeek 経由）の完了を待っています。 次に kim がすること: なし（待つだけで大丈夫です）',
    '今日の報告で「Codex の完了を待っています」と書いてしまった。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
});
// handoff-audit:c1e05b232e9e04c9（2026-10-21T05:13:52.790Z / b822034d）の原文。
// Stop ゲートは後続作業が無ければ pass するが、nightly は候補として W で拾う（二段構え）。
test('裸の待機文（c1e05b23 の原文）をWとして検出する', () => {
  assert.deepEqual(detect('Codex の完了を待っています。').map(found => found.pattern), ['W']);
});
