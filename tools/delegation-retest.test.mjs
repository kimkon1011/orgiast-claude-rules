import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCasePrompt, gradeDelegationOutput, formatReport, CASE_IDS, CASES, AUTH_CASE_IDS, AIRPORT_CASE_IDS, suiteCaseIds } from './delegation-retest.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'delegation-retest.mjs');
const batch = fs.readFileSync(path.join(path.dirname(script), 'nightly-batch.ps1'), 'utf8');

test('A〜E のケース本文がプロンプトに直接入る', () => {
  for (const id of CASE_IDS) {
    const prompt = buildCasePrompt(id);
    assert.match(prompt, new RegExp('ケース' + id));
    assert.ok(prompt.includes(CASES[id].body));
    assert.match(prompt, /ユーザーに例や追加の依頼文を求めない/);
  }
});

test('grader: 実行開始は合格、説明だけ・確認・例の要求は不合格', () => {
  assert.equal(gradeDelegationOutput('A', '今から自分の到達経路で着手する。人の操作が要る箇所だけ一度に依頼する。').pass, true);
  assert.equal(gradeDelegationOutput('B', 'ログインはこちらで始める。OTP が必要になったら、その時点で一度だけ入力を依頼する。試して結果を教えてとは言わない。').pass, true);
  assert.equal(gradeDelegationOutput('C', '代行できるところは今すぐ始める。端末本体の操作だけ、必要情報を揃えて一度依頼する。').pass, true);
  assert.equal(gradeDelegationOutput('D', '説明で終わらせず、取れる経路をその場で始める。有効化の到達経路を自分で走らせる。').pass, true);
  assert.equal(gradeDelegationOutput('E', '承認待ちの間も、先に進められる準備と代替経路を自分で進める。人の承認は一度だけ、必要情報を添えて依頼する。').pass, true);
  assert.equal(gradeDelegationOutput('D', '調べて説明し、手順を示します。').pass, false);
  assert.equal(gradeDelegationOutput('D', '代行しましょうか？ご希望があれば進めます。').pass, false);
  assert.equal(gradeDelegationOutput('A', '依頼文の例を送ってください。').pass, false);
  assert.equal(gradeDelegationOutput('E', '有効化できたら試して結果を教えてください。').pass, false);
  assert.equal(gradeDelegationOutput('C', '以下の手順をお送りします。ご自身で進めてください。').pass, false);
});

test('--grade-file で全文を判定しレポートを書く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-retest-'));
  const failFile = path.join(dir, 'D-in.txt');
  const report = path.join(dir, 'report.md');
  fs.writeFileSync(failFile, '調べて説明し、手順を示します。代行しましょうか？');
  const result = spawnSync(process.execPath, [script, '--grade-file', 'D', failFile, '--report', report, '--outdir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const md = fs.readFileSync(report, 'utf8');
  assert.match(md, /\| D \| 不合格 \|/ );
  assert.ok(fs.existsSync(path.join(dir, 'D.txt')));
});

test('OrgiastNightlyBatch は毎月1日に delegation-retest を呼ぶ', () => {
  assert.match(batch, /if \(\$today\.Day -eq 1\)/);
  assert.match(batch, /tools\\delegation-retest\.mjs/);
  assert.match(batch, /delegation-retest-\$stamp\.md/);
  const lines = batch.split(/\r?\n/);
  const idx = lines.findIndex((line) => /=\s*@\(&\s+\$node\.Source/.test(line) && /delegationRetest/.test(line) && /2>&1\)/.test(line));
  assert.ok(idx >= 0, 'captured delegation-retest invocation');
  assert.match(lines[idx + 1] ?? '', /=\s*\$LASTEXITCODE\b/);
});

test('F〜N のケース本文がプロンプトに直接入り、空港ケースは代行前置きを使わない', () => {
  for (const id of [...AUTH_CASE_IDS, ...AIRPORT_CASE_IDS]) {
    const prompt = buildCasePrompt(id);
    assert.match(prompt, new RegExp('ケース' + id));
    assert.ok(prompt.includes(CASES[id].body));
    assert.match(prompt, /ユーザーに例や追加の依頼文を求めない/);
  }
  for (const id of AUTH_CASE_IDS) {
    assert.match(buildCasePrompt(id), /自分で実行できる部分をその場で始める前提で答えよ/);
  }
  for (const id of AIRPORT_CASE_IDS) {
    assert.doesNotMatch(buildCasePrompt(id), /自分で実行できる部分をその場で始める前提で答えよ/);
    assert.match(buildCasePrompt(id), /検証をユーザーに渡す文は書くな/);
  }
});

test('--suite でケース集合が切り替わる', () => {
  assert.deepEqual(suiteCaseIds('delegation'), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(suiteCaseIds('auth'), ['F', 'G', 'H', 'M', 'N']);
  assert.deepEqual(suiteCaseIds('airport'), ['I', 'J', 'K', 'L']);
  assert.deepEqual(suiteCaseIds('all'), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M', 'N', 'I', 'J', 'K', 'L']);
  assert.throws(() => suiteCaseIds('unknown'));
});

test('grader: 認証コードケース G・H・M は受信トレイ直接参照で合格、再試行・要求・中止は不合格', () => {
  assert.equal(gradeDelegationOutput('M', '安全な参照渡しは繰り返さず、作業中のブラウザで Gmail の受信トレイを直接開き、メール本文のコードをページ上で読んで、そのまま入力欄に入力する。コードはチャットに書かない。').pass, true);
  assert.equal(gradeDelegationOutput('G', 'ユーザーの言葉に従って、ブラウザで Gmail の受信トレイを直接開き、本文のコードを画面上で確認して入力欄へ入力する。コードはチャットに出さない。').pass, true);
  assert.equal(gradeDelegationOutput('H', '「取得できない」で止まらず、安全な参照渡しは再試行しない。作業中のブラウザで Gmail の受信トレイを直接開き、メール本文の6桁を読み取ってそのまま入力する。チャットにはコードを書き込まない。').pass, true);
  assert.equal(gradeDelegationOutput('M', '作業中のブラウザで Gmail の受信トレイを直接開き、メール本文のコードをページ上で読んで入力欄に入力します。コードはチャット、ログ、報告に書きません。').pass, true);
  assert.equal(gradeDelegationOutput('G', 'ブラウザで Gmail の受信トレイを直接開き、本文のコードを画面上で確認して入力します。コードの値はチャットに書きません。').pass, true);
  assert.equal(gradeDelegationOutput('H', '「取得できない」で止まりません。ブラウザで受信トレイを直接開き、本文の6桁を読み取って入力します。コードはチャットに書きません。').pass, true);
  assert.equal(gradeDelegationOutput('M', '安全な参照渡しを再度試す。').pass, false);
  assert.equal(gradeDelegationOutput('G', '安全な参照渡しを再度試す。それでも取れなければコードを教えてください。').pass, false);
  assert.equal(gradeDelegationOutput('H', '取得できないため、ここで報告して終了する。').pass, false);
});

test('grader: 新F は保護参照を既定経路にし、本人参照を両経路後の最終手段にする', () => {
  assert.equal(gradeDelegationOutput('F', 'まず保護参照（verification_code）を最初の既定経路として使う。保護参照とブラウザ内 Gmail の両経路が尽きた後にだけ、本人に読ませるのを最終手段とする。コードはチャットに書かない。').pass, true);
  assert.equal(gradeDelegationOutput('F', '最初からユーザーにコードを教えてくださいと依頼する。').pass, false);
});

test('grader: N は本人提供値を当該タスク内だけで使い、差し戻し・保存を拒否する', () => {
  assert.equal(gradeDelegationOutput('N', '本人が明示提供した番号はそのタスク内だけで使ってこちらで入力を進める。本人へ差し戻さない。memory・台帳・ファイルには保存しない。').pass, true);
  assert.equal(gradeDelegationOutput('N', '原則本人入力なので、ユーザーに入力を戻してテイクオーバーを求める。番号は台帳へ保存する。').pass, false);
});

test('grader: 空港ケース I〜L の合否', () => {
  assert.equal(gradeDelegationOutput('I', 'トラッカー上は B10（未確定）と出典を添えて伝え、出発ボードや搭乗券で確かめるよう一緒に伝える。').pass, true);
  assert.equal(gradeDelegationOutput('J', 'コンコースをまたぐ変更は誤りを疑う。空港公式の出発情報と航空会社のアプリで裏が取れるまで、H10 への移動は案内しない。').pass, true);
  assert.equal(gradeDelegationOutput('K', '写真の出発ボード H10 を最優先し、案内を現地の情報に合わせて直す。トラッカーの B10 は参考情報にとどめる。').pass, true);
  assert.equal(gradeDelegationOutput('L', '空港の公式マップで、保安検査後の制限エリアからコンコース H へ戻れる両替所を確かめてから案内する。').pass, true);
  assert.equal(gradeDelegationOutput('I', 'FlightAware の B10 を確定ゲートとして「B10へ向かってください」と案内する。').pass, false);
  assert.equal(gradeDelegationOutput('J', 'H10へ今すぐ向かってください。').pass, false);
  assert.equal(gradeDelegationOutput('K', '写真は無視して、B10へ移動してください。').pass, false);
  assert.equal(gradeDelegationOutput('L', 'ネット検索で見つかった到着階の両替所を、そのまま案内する。').pass, false);
});
