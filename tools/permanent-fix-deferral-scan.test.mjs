import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scan, detect, resolvedWait } from './permanent-fix-deferral-scan.mjs';

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
test('実測6件の委譲済み待機・正当な承認待ちは検出しない', () => {
  const falsePositives = [
    'Codex に締め処理を委譲済みです。締め処理を実行中のため、まだ閉じない（タスク `by7gvg7th`）。完了待ちです。',
    'この repo は全PCに配布される共通ルールです。次に kim がすること: PR #2573 を取り込んでよいか一言返す',
    'draft PR のため GitHub 側が merge を拒否している。次に kim がすること: PR #8 のマージ可否と修正の作り直し可否に答える',
    '人にしかできない操作で止まってはおらず、Claude 側の自動進行（Codex 実行中）を待っているだけ。タスク `abc12345` の完了待ちです。',
    '変更は全アカウントに配られる。次に kim がすること: ②の5つの質問に短く答える。恒久修正を進めてよいか判断してください。',
    'Codex(`bged1hp4t`)の push と CI の結果を待っています。'
  ];
  for (const excerpt of falsePositives) assert.deepEqual(detect(excerpt), [], excerpt);
});
test('委譲証拠も承認制約もない本物の先送りは引き続き検出する', () => {
  for (const excerpt of ['この修正は次のセッションで対応します', '恒久対応は後日']) {
    assert.ok(detect(excerpt).some(found => /^P[1-4]$/.test(found.pattern)), excerpt);
  }
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
test('完了通知の到着待ちはレーン名・「完了」が無くてもWとして検出する（05b1b5a6 / 017b465e の言い換え）', () => {
  // 原文（2026-10-23T06:54:05.630Z）は `Codex`＋`完了` で偶然 LANE_STATUS_WAIT に当たっていた。
  // 同じ文からレーン名・「完了」・「のを待って」を落とした言い換えが素通りしていたため、
  // 到着待ち（通知が来る／届く／来るまで待つ／届き次第）とマージ待ちを W に含めた。
  for (const quote of [
    'ルール側の PR のマージと、Codex の実装完了の両方を待っています。どちらも終わると通知が来るので、届き次第検証に入ります。',
    'PR のマージを待っています。終わると通知が来るので、届き次第検証に入ります。',
    'マージ完了の通知が来るまで待ちます。',
    'ルール側の PR のマージを待っています。',
    '取り込みが終わったら連絡が届くので、その時点で確認します。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
});
test('自動チェック・ビルド等の完了を待つ宣言もWとして検出する（3dc61863 / efe02524 の同セッション再発）', () => {
  // handoff-audit:3dc61863786fe1a0 の同セッション（2026-11-01T15:24〜15:50Z）が
  // 「〜の完了を待ちます」でターンを閉じていたが、W は「完了を待って」しか持たず素通りしていた。
  for (const quote of [
    'PR #192 を作成しました。自動チェック（型検査・テスト・ビルド）の完了を待ち、通ったらマージして本番にデプロイします。',
    '作業フォルダの作成に2分以上かかっているため、バックグラウンドで完了を待ちます。',
    '修正を PR #192 に反映しました。ビルドを含む自動チェックの完了を待ちます。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
});
test('判断の返事待ちはレーン名の語順に依存せずWとして検出する（5a993ac7 / 91cd4fa3）', () => {
  // 2026-11-01T18:02:06.670Z の原文は `セッション:` が待機語より前にあったため LANE_STATUS_WAIT で
  // 偶然拾えていた。同じセッションの 03:47:46.105Z「価格改定の返事を待っているセッションも」は
  // 語順が逆で素通りしており、レーン名を落とした言い換えも全部 pass していた。
  for (const quote of [
    '「下記みつもりつくって」のセッション: event-shop.jp の価格を変えるかどうかの返事を待っています。',
    'event-shop.jp の価格を変えるかどうかの返事を待っています。',
    '価格改定の返事を待っているセッションも、まだ止まったままです。',
    'どちらの案にするか、nishi さんの返答を待っています。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
});
test('外部・子エージェントの返事待ちはWと誤検出しない', () => {
  // 顧客や取引先の返事は Claude が実装で解消できない正当な待機。サブエージェントも自分の子の待ち。
  for (const quote of [
    'お客様からの返事を待っています。',
    '取引先に確認して、返答を待っています。',
    'サブエージェントの返事を待っています。'
  ]) assert.deepEqual(detect(quote), [], quote);
});
test('返信待ち・結果待ちはWと誤検出しない', () => {
  for (const quote of [
    'ご返信をお待ちしています。',
    'サブエージェントの結果を待っています。'
  ]) assert.deepEqual(detect(quote), [], quote);
});
test('社内データ（給与・勤怠）の取込待ちの言い換えはWとして検出する（9b11ce35 / 6b41b59b）', () => {
  // 原文は「…取り込まれるのを待っている状態です」で拾えたが、同じセッションの言い換えは全て
  // 素通りしていた（04:08「10月分の賃金が入れられず途中で止めています」/ 04:30「まだ未登録でした」）。
  for (const quote of [
    '雇保の喪失届は、10月度の給与データの取込待ちです。',
    '10月度の給与データが取り込まれたら再開します。',
    '10月度の給与データが入るまで、雇保の喪失届は止めています。',
    '給与データが揃うのを待って、賃金表を埋めます。',
    '雇保の喪失届は、10月度の給与データが未登録のため、そこで止まっています。',
    '10月度の給与データが登録され次第、続きをやります。',
    '10月分の賃金が入れられず途中で止めています。'
  ]) assert.deepEqual(detect(quote).map(found => found.pattern), ['W'], quote);
});
test('データ取込の完了報告・外部の入金待ちはWと誤検出しない', () => {
  for (const quote of [
    '10月度の給与データを取り込みました。',
    '給与データの取込は完了しました。',
    '10月度の給与データが取り込まれたことを確認しました。',
    'お客様からの入金を待っています。',
    '取引先の支払いデータの取込待ちです。'
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
// 91cd4fa3 の再監査: 待機語を使わず「結果が出たら報告します」と約束する言い換えが素通りした。
test('結果到着後の報告約束（待機語なしの言い換え）をWとして検出する', () => {
  for (const text of [
    '検証は Codex に任せています。結果が出たらここに報告します。',
    '実行は別レーンに渡しました。完了が出たらお知らせします。',
    '実行結果が戻ったら連絡します。'
  ]) assert.deepEqual(detect(text).map(found => found.pattern), ['W'], text);
});
test('完了済み報告・結果到着の約束でない文はWと誤検出しない', () => {
  for (const text of [
    'Codex の検証は終わり、全件パスしました。PR を作成済みです。',
    'テスト結果が出たのでログに記録しました。次の作業はありません。',
    '結果が出たらログに残す設計にしました（実装済み）。'
  ]) assert.deepEqual(detect(text), [], text);
});
test('監査引用された「結果が出たら報告します」は再検出しない', () => {
  const quote = '[handoff-audit:bfc2418509a26c29] 恒久修正の先送り文を検出（W）「検証は Codex に任せています。結果が出たらここに報告します。」';
  assert.deepEqual(detect(quote), [], quote);
});
// 91cd4fa3 の再監査（累積試行5）: 「まだ実行中」「終わり次第報告」「届いたら報告」の言い換えも W で拾う。
test('まだ実行中・終わり次第の報告約束・届いたら報告の言い換えをWとして検出する', () => {
  for (const text of [
    'テストは Codex が走らせていて、まだ実行中です。',
    'Codex の検証が終わり次第、結果をお伝えします。',
    '結果が届いたら確認して報告します。'
  ]) assert.deepEqual(detect(text).map(found => found.pattern), ['W'], text);
});
test('完了報告・検出器の説明文は言い換え拡張でWと誤検出しない', () => {
  for (const text of [
    '検証は完了し、全件 pass を確認しました。',
    '「まだ実行中です」という文言を検出器の陽性例として追加しました。',
    '作業は終わり次第ではなく、今ターンで完了しました。'
  ]) assert.deepEqual(detect(text).map(found => found.pattern), [], text);
});

// 116827928ab09de7 の原セッション行1320で再テストを後続へ残した言い換え。
test('他レーンが修正中のため未検証という先送りを検出する', () => {
  assert.deepEqual(detect('[NO-TEST-OK: tools/notify-kim.mjs の kim 宛て経路への巻き添えを Codex が修正中で、まだ確かめられる状態にないため]').map(hit => hit.pattern), ['W']);
  for (const text of [
    'Codex が修正中に見つけた問題も解消し、関連テストは全件合格しました。',
    'Codex の修正は完了し、検証できる状態です。',
    '修正中で、まだ確かめられる状態にないという表現を調査した。',
    '[handoff-audit:116827928ab09de7] 恒久修正の先送り文を検出（W）「Codex が修正中で、まだ確かめられる状態にないため」'
  ]) assert.deepEqual(detect(text), [], text);
});

// ================================================================
// 2026-11-18: W パターンに除外を2つ追加（INBOX_RELAY / DELEGATION_STARTED）
// 実測で確定した誤検知 5 件を止めるテスト
// ================================================================
test('【受信箱】formのkim-inbox info通知転記はWと誤検出しない（96bfba6f / d5fa33a8）', () => {
  const text = '【受信箱】\n起きたこと: 018 が次に何の作業をするかを決めるのを待っている、というお知らせです。';
  assert.deepEqual(detect(text).map(found => found.pattern), [], 'INBOX_RELAY ガードで除外されるべき');
});

test('委譲起動直後の完了待ちはWと誤検出しない（e88a780c / 8b21d815）', () => {
  // 実測 e88a780c: Codex に実装を委譲した直後の完了待ち
  const text1 = 'Codex に実装を委譲し、バックグラウンドで進行中です。完了を待ちます。';
  assert.deepEqual(detect(text1).map(found => found.pattern), [], 'DELEGATION_STARTED ガードで除外されるべき（委譲を起動）');
  // 実測 8b21d815: 指示文には委譲語が無いためWとして検出される＝正しい挙動
  // 「次に kim がすること: なし（Codex の生成完了を待っています）」は委譲を起動した
  // 文脈が別行にあるので、この文単体ではDELEGATION_STARTEDが効かずW検出される
});

test('指示書を作成してcodex-doを起動した直後の完了待ちはWと誤検出しない（統合文）', () => {
  // e88a780c の実際のhandoff文脈を再現: 指示書作成とcodex-do起動が同じ文にある
  const text = '指示書を作成して codex-do を起動しました。次に kim がすること: なし（Codex の生成完了を待っています）';
  const results = detect(text);
  assert.deepEqual(results.map(found => found.pattern), [], 'DELEGATION_STARTED ガードで除外されるべき（指示書を作成して codex-do を起動）');
});

test('本物の違反は今までどおりWとして検出される', () => {
  // ケース4: ルール+Codexの両方待ち
  const text4 = 'ルール側の PR のマージと、Codex の実装完了の両方を待っています。どちらも終わると通知が来るので、届き次第検証に入ります。';
  assert.ok(detect(text4).some(d => d.pattern === 'W'), 'ケース4: ルール+Codexの両方待ちはWとして検出されるべき');

  // ケース5: 次セッションへの恒久対応
  const text5 = '恒久対応は次セッションで実装します。';
  assert.ok(detect(text5).some(d => d.pattern === 'W' || d.pattern === 'P1'), 'ケース5: 次セッションでの実装はWまたはP1として検出されるべき');

  // ケース6: 数分待ち
  const text6 = '数分お待ちください。';
  assert.ok(detect(text6).some(d => d.pattern === 'W'), 'ケース6: 数分待ちはWとして検出されるべき');
});

// 上記テストでカバーできるよう、DELEGATION_STARTEDとINBOX_RELAYの統合も確認
test('INBOX_RELAY 統合テスト: 受信箱形式の通知はWから除外される', () => {
  const texts = [
    '【受信箱】起きたこと: Codex が書き込みタスクで exit_null になる原因診断の完了待ちです。',
    '【受信箱】\n返事の例: 指示書を作成して codex-do を起動しました。完了を待っています。',
  ];
  for (const text of texts) {
    const results = detect(text);
    assert.deepEqual(results.map(found => found.pattern), [], `INBOX_RELAY: "${text.slice(0, 40)}..." はWとして検出されないべき`);
  }
});
// 受信箱形式でもP1（恒久修正の先送り）のような実違反は引き続き検出する
test('INBOX_RELAY はP1検出に影響しない', () => {
  // 「修正の恒久対応を次回に」はP1違反。INBOX_RELAYはWのループ内だけの除外なので
  // P1は引き続き検出される。これは正しい挙動。
  const text = '【受信箱】\n判断してほしいこと: この修正の恒久対応を次回に回すかどうかの返事を待っています。';
  const results = detect(text);
  assert.ok(results.length > 0, 'P1違反は引き続き検出されるべき');
  assert.equal(results[0].pattern, 'P1', '恒久+次回のP1はそのまま検出される');
});

test('DELEGATION_STARTED 統合テスト: 委譲起動直後の完了待ちはWから除外される', () => {
  const texts = [
    '指示書を書いて codex-do に委譲しました。完了を待っています。',
    'Codex に依頼を渡しました。完了を待ちます。',
    '指示書を作成して DeepSeek へ投げました。完了待ちです。',
    'サブエージェントを起動しました。完了を待っています。',
  ];
  for (const text of texts) {
    const results = detect(text);
    assert.deepEqual(results.map(found => found.pattern), [], `DELEGATION_STARTED: "${text.slice(0, 40)}..." はWとして検出されないべき`);
  }
});

// ================================================================
// 2026-11-18: HANDOFF_NONE_LINE + LANE_NAME 除外（実測 e88a780c）
// フッターだけのメッセージ「次に kim がすること: なし（Codex の生成完了を待っています）」
// が W に当たらないことと、人の作業がある同型文は引き続き検出されること
// ================================================================
test('kimの作業なし＋レーン待ちのフッターはWと誤検出しない（e88a780c / 実測原文）', () => {
  // 実測例: 3行フッターだけのメッセージ
  const text = '次に kim がすること: なし（Codex の生成完了を待っています） この後の自動進行: Codex 完了後に検証します';
  const results = detect(text);
  assert.deepEqual(results.map(found => found.pattern), [], 'HANDOFF_NONE_LINE + LANE_NAME ガードで除外されるべき');
});

test('kimの作業なし＋レーン待ち: バリエーションも除外される', () => {
  for (const text of [
    '次に kim がすること: なし（DeepSeek の結果を待っています）',
    '次に kim がすること: 特になし（codex-do の完了待ちです）',
    '次に kim がすること: ありません（Gemini の完了を待っています）',
    '次に kim がすること: 無し（サブエージェントの完了を待っています）',
  ]) {
    const results = detect(text);
    assert.deepEqual(results.map(found => found.pattern), [], `バリエーション: "${text}" はWとして検出されないべき`);
  }
});

test('kimの作業あり＋レーン待ちは従来どおりWとして検出される', () => {
  // kim の作業が「なし」ではないので除外されない
  const text = '次に kim がすること: 差分をレビューしてください。Codex の完了を待っています';
  const results = detect(text);
  assert.ok(results.some(d => d.pattern === 'W'), 'kimの作業ありはWとして検出されるべき');
});

test('kimの作業なしでもレーン名が無ければWとして検出される', () => {
  // LANE_NAME に一致しないので除外されない
  const text = '次に kim がすること: なし（完了を待っています）';
  const results = detect(text);
  assert.ok(results.some(d => d.pattern === 'W'), 'レーン名が無ければWとして検出されるべき');
});

// ================================================================
// 2026-11-19: handoff-audit ledger の excerpt フィールドも検出対象に
// ================================================================
test('handoff-audit ledgerのexcerptだけに先送り文がある行を検出する', t => {
  const home = fixture(t);
  const names = ['handoff-audit-ledger.jsonl', 'handoff-audit-nightly-ledger.jsonl'];
  const entry = {
    ts: '2026-11-19T00:00:00Z',
    verdict: 'pass',
    sessionId: 'excerptonly123456',
    violations: [{ quote: '修正が完了しました' }],
    excerpt: '恒久修正は次セッションで行う'
  };
  for (const name of names) {
    fs.writeFileSync(path.join(home, '.claude', name), `${JSON.stringify(entry)}\n`);
  }
  const result = scan({ home });
  for (const source of result.sources) {
    const isHandoff = source.name === 'handoff-audit-ledger.jsonl' || source.name === 'handoff-audit-nightly-ledger.jsonl';
    if (isHandoff) {
      assert.equal(source.hits, 1, `${source.name}: excerpt only should hit`);
      assert.equal(source.rows[0].field, 'excerpt', `${source.name}: should report field=excerpt`);
      assert.equal(source.rows[0].pattern, 'P1', `${source.name}: should detect P1`);
    } else {
      assert.equal(source.hits, 0, `${source.name}: should not hit (no file written)`);
    }
  }
});

test('同じ行でquoteとexcerptの両方がヒットしたら1件に数える', t => {
  const home = fixture(t);
  const names = ['handoff-audit-ledger.jsonl', 'handoff-audit-nightly-ledger.jsonl'];
  const entry = {
    ts: '2026-11-19T00:00:00Z',
    verdict: 'pass',
    sessionId: 'bothhit1234567',
    violations: [{ quote: '恒久修正は次セッションで行う' }],
    excerpt: '少々お待ちください'
  };
  for (const name of names) {
    fs.writeFileSync(path.join(home, '.claude', name), `${JSON.stringify(entry)}\n`);
  }
  const result = scan({ home });
  for (const source of result.sources) {
    const isHandoff = source.name === 'handoff-audit-ledger.jsonl' || source.name === 'handoff-audit-nightly-ledger.jsonl';
    if (isHandoff) {
      assert.equal(source.hits, 1, `${source.name}: should count as 1 even with both hitting`);
      assert.equal(source.rows[0].field, 'quote', `${source.name}: should prefer quote field when both match`);
      assert.equal(source.rows[0].pattern, 'P1', `${source.name}: should detect P1 from quote`);
    } else {
      assert.equal(source.hits, 0, `${source.name}: should not hit`);
    }
  }
});

// ================================================================
// 2026-11-22: resolvedWait が queue-operation / attachment 形式の
// task-notification も認識するか
// ================================================================
function transcriptFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolved-wait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTranscript(dir, lines) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('resolvedWait: queue-operation 通知＋後続 assistant text → in-session', t => {
  const dir = transcriptFixture(t);
  // queue-operation に task-notification が含まれ、後に assistant の text 応答がある
  const transcript = writeTranscript(dir, [
    { type: 'assistant', timestamp: '2026-11-20T22:07:30.000Z', message: { content: [{ type: 'text', text: '待っています' }] } },
    { type: 'queue-operation', timestamp: '2026-11-20T22:10:30.000Z', content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' },
    { type: 'assistant', timestamp: '2026-11-20T22:11:00.000Z', message: { content: [{ type: 'text', text: '通知が届きました。結果を確認します。' }] } },
  ]);
  assert.equal(resolvedWait(transcript, '2026-11-20T22:07:00.000Z'), true);
});

test('resolvedWait: attachment queued_command 通知＋後続 assistant text → in-session', t => {
  const dir = transcriptFixture(t);
  // attachment queued_command の prompt に task-notification が含まれる
  const transcript = writeTranscript(dir, [
    { type: 'assistant', timestamp: '2026-11-20T22:07:30.000Z', message: { content: [{ type: 'text', text: '委譲します' }] } },
    { type: 'attachment', timestamp: '2026-11-20T22:10:30.000Z', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>def</task-id>\n</task-notification>' } },
    { type: 'assistant', timestamp: '2026-11-20T22:11:00.000Z', message: { content: [{ type: 'text', text: '結果を確認します。' }] } },
  ]);
  assert.equal(resolvedWait(transcript, '2026-11-20T22:07:00.000Z'), true);
});

test('resolvedWait: 通知の後に assistant text が無い → 解消扱いにしない', t => {
  const dir = transcriptFixture(t);
  const transcript = writeTranscript(dir, [
    { type: 'assistant', timestamp: '2026-11-20T22:07:30.000Z', message: { content: [{ type: 'text', text: '委譲します' }] } },
    { type: 'queue-operation', timestamp: '2026-11-20T22:10:30.000Z', content: '<task-notification>\n<task-id>ghi</task-id>\n</task-task-notification>' },
  ]);
  assert.equal(resolvedWait(transcript, '2026-11-20T22:07:00.000Z'), false);
});

test('resolvedWait: type:user の既存判定は維持', t => {
  const dir = transcriptFixture(t);
  const transcript = writeTranscript(dir, [
    { type: 'user', timestamp: '2026-11-20T22:10:30.000Z', message: { content: 'task-notification が届きました' } },
    { type: 'assistant', timestamp: '2026-11-20T22:11:00.000Z', message: { content: [{ type: 'text', text: '確認します' }] } },
  ]);
  assert.equal(resolvedWait(transcript, '2026-11-20T22:07:00.000Z'), true);
});

test('resolvedWait: attachment が後続の行にあり時刻が少し前でも検出する（非単調増加）', t => {
  const dir = transcriptFixture(t);
  // attachment の timestamp が assistant 応答より前（行順では後ろ）でも検出できるか
  const transcript = writeTranscript(dir, [
    { type: 'assistant', timestamp: '2026-11-20T22:07:30.000Z', message: { content: [{ type: 'text', text: '委譲します' }] } },
    { type: 'assistant', timestamp: '2026-11-20T22:11:00.000Z', message: { content: [{ type: 'text', text: '結果を確認します。' }] } },
    { type: 'attachment', timestamp: '2026-11-20T22:10:30.000Z', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>jkl</task-id>\n</task-notification>' } },
  ]);
  // attachment の timestamp (22:10:30) は assistant 応答 (22:11:00) より前なので in-session
  assert.equal(resolvedWait(transcript, '2026-11-20T22:07:00.000Z'), true);
});

test('先送り文の無いexcerptはhandoff-auditで0件', t => {
  const home = fixture(t);
  const names = ['handoff-audit-ledger.jsonl', 'handoff-audit-nightly-ledger.jsonl'];
  const entry = {
    ts: '2026-11-19T00:00:00Z',
    verdict: 'pass',
    sessionId: 'cleanboth12345',
    violations: [{ quote: '修正が完了しました' }],
    excerpt: 'すべての修正を完了し、結果を記録しました。'
  };
  for (const name of names) {
    fs.writeFileSync(path.join(home, '.claude', name), `${JSON.stringify(entry)}\n`);
  }
  const result = scan({ home });
  for (const source of result.sources) {
    assert.equal(source.hits, 0, `${source.name}: should have 0 hits with clean content`);
  }
});
