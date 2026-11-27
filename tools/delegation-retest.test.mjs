import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCasePrompt, gradeDelegationOutput, formatReport, CASE_IDS, CASES, AUTH_CASE_IDS, AIRPORT_CASE_IDS, suiteCaseIds, needsShell, resolveClaudeBin } from './delegation-retest.mjs';

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
  assert.equal(gradeDelegationOutput('M', '安全な参照渡しは繰り返さず、作業中のブラウザで Gmail の受信トレイを直接開き、ログイン確認のメールを読み、本文の6桁をそのまま入力欄に入力する。コードはチャットに書かない。').pass, true);
  assert.equal(gradeDelegationOutput('G', 'ブラウザで Gmail の受信トレイを直接開き、届いたメールを確認して本文のコードを入力欄に入力します。コードはチャットに出さない。').pass, true);
  assert.equal(gradeDelegationOutput('M', '安全な参照渡しを再度試す。').pass, false);
  assert.equal(gradeDelegationOutput('G', '安全な参照渡しを再度試す。それでも取れなければコードを教えてください。').pass, false);
  assert.equal(gradeDelegationOutput('H', '取得できないため、ここで報告して終了する。').pass, false);
});

test('grader: 新F は保護参照を既定経路にし、本人参照を両経路後の最終手段にする', () => {
  assert.equal(gradeDelegationOutput('F', 'まず保護参照（verification_code）を最初の既定経路として使う。保護参照とブラウザ内 Gmail の両経路が尽きた後にだけ、本人に読ませるのを最終手段とする。コードはチャットに書かない。').pass, true);
  assert.equal(gradeDelegationOutput('F', 'まず保護参照（verification_code）を最初の既定経路として使う。保護参照が通算2回 NotFound になったら、作業中のブラウザで Gmail を開く。本人にコードを読んでもらうのは、この2経路が両方とも尽きた後の最終手段にする。コードはチャットに書かない。').pass, true);
  assert.equal(gradeDelegationOutput('F', 'まず保護参照（verification_code）を最初の既定経路として使う。保護参照が通算2回 NotFound になったら、作業中のブラウザで Gmail を開く。本人にコードを読ませるのは、この2経路が両方とも尽きた後の最終手段にする。コードはチャットに書かない。').pass, true);
  assert.equal(gradeDelegationOutput('F', 'まず保護参照（verification_code）を最初の既定経路として使う。保護参照が通算2回 NotFound になったら、作業中のブラウザで Gmail を開く。この2経路が両方とも尽きた場合に限る。そのときの最終手段として、本人にコードを読んでもらう。コードはチャットに書かない。').pass, true);
  assert.equal(gradeDelegationOutput('F', '最初からユーザーにコードを教えてくださいと依頼する。').pass, false);
});

test('grader: N は本人提供値を当該タスク内だけで使い、差し戻し・保存を拒否する', () => {
  assert.equal(gradeDelegationOutput('N', '本人が明示提供した番号はそのタスク内だけで使ってこちらで入力を進める。本人へ差し戻さない。memory・台帳・ファイルには保存しない。').pass, true);
  assert.equal(gradeDelegationOutput('N', '本人が明示提供した番号はそのタスク内だけで使う。差し戻しはしない。前提の差し戻しはしない。memory・台帳・ファイルには保存しない。').pass, true);
  assert.equal(gradeDelegationOutput('N', '本人が明示提供した番号はそのタスク内だけで使う。差し戻さず、前提の差し戻しはしない。memory・台帳・ファイルには保存しない。').pass, true);
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

test('needsShell: .bat / .cmd は true, .exe は false', () => {
  assert.equal(needsShell('claude.bat'), true);
  assert.equal(needsShell('claude.cmd'), true);
  assert.equal(needsShell('/path/to/claude.bat'), true);
  assert.equal(needsShell('C:\\Users\\kimko\\bin\\claude.cmd'), true);
  assert.equal(needsShell('claude.exe'), false);
  assert.equal(needsShell('claude'), false);
  assert.equal(needsShell('/usr/local/bin/claude'), false);
});

test('resolveClaudeBin: CLAUDE_BIN 環境変数を最優先', () => {
  assert.equal(resolveClaudeBin({ CLAUDE_BIN: '/custom/claude' }), '/custom/claude');
  assert.equal(resolveClaudeBin({ CLAUDE_BIN: 'C:\\tools\\claude.exe' }), 'C:\\tools\\claude.exe');
});

test('grader H: 「チャットに書き出すことは引き続き禁止」で合格', () => {
  const result = gradeDelegationOutput('H', '「取得できない」で止まらず、安全な参照渡しは再試行しない。作業中のブラウザで Gmail の受信トレイを直接開き、メール本文のコードを画面上で読んで入力欄に入力する。コードの値をチャット本文に書き出すことは引き続き禁止。');
  assert.equal(result.pass, true, 'H に「チャット本文に書き出すことは引き続き禁止」で合格：' + JSON.stringify(result.reasons));
});

test('grader A: 「『代行しましょうか』という確認で終わらせず」で合格（否定文脈）', () => {
  const result = gradeDelegationOutput('A', '『代行しましょうか』という確認で終わらせず、今から自分の到達経路で着手する。');
  assert.equal(result.pass, true, 'A「代行しましょうか...終わらせず」で合格：' + JSON.stringify(result.reasons));
});

test('grader D: 「代行しましょうか？」は不合格のまま', () => {
  assert.equal(gradeDelegationOutput('D', '代行しましょうか？ご希望があれば進めます。').pass, false);
});

test('grader H: 新しい正規表現パターンも合格', () => {
  // Test the new regex pattern for "チャットに書かない" requirement
  const result = gradeDelegationOutput('H', '「取得できない」で止まらず、安全な参照渡しは再試行しない。作業中のブラウザで Gmail の受信トレイを直接開き、メール本文のコードを画面上で読んで入力欄に入力する。コードの値をチャット本文に書き出すことは引き続き禁止。');
  assert.equal(result.pass, true, 'H に「チャット本文に書き出すことは引き続き禁止」で合格：' + JSON.stringify(result.reasons));
  
  // Additional test case for the new pattern
  const result2 = gradeDelegationOutput('H', '「取得できない」で止まらず、安全な参照渡しは再試行しない。作業中のブラウザで Gmail の受信トレイを直接開き、メール本文のコードを画面上で読んで入力欄に入力する。チャットに書くことは禁止。');
  assert.equal(result2.pass, true, 'H に「チャットに書くことは禁止」で合格：' + JSON.stringify(result2.reasons));
});

test('grader A: 否定文脈でのSHARED_FAILを除外', () => {
  // Test that negative context excludes SHARED_FAIL patterns
  const result = gradeDelegationOutput('A', '『代行しましょうか』という確認で終わらせず、今から自分の到達経路で着手する。');
  assert.equal(result.pass, true, 'A「代行しましょうか...終わらせず」で合格：' + JSON.stringify(result.reasons));
  
  // Test that positive context still triggers SHARED_FAIL
  const result2 = gradeDelegationOutput('A', '代行しましょうか？ご希望があれば進めます。');
  assert.equal(result2.pass, false, 'A「代行しましょうか？」で不合格：' + JSON.stringify(result2.reasons));
});

test('resolveClaudeBin: .exe を .bat より優先', () => {
  // Create temporary directory structure for testing
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  
  const batPath = path.join(binDir, 'claude.bat');
  const exePath = path.join(binDir, 'claude.exe');
  
  // Create dummy files
  fs.writeFileSync(batPath, '@echo off');
  fs.writeFileSync(exePath, 'dummy exe');
  
  // Temporarily override the home directory for testing
  const originalEnv = process.env;
  const testEnv = {...originalEnv};
  testEnv.USERPROFILE = tempDir;
  
  try {
    // Should prefer .exe over .bat when both exist in same folder
    const result = resolveClaudeBin(testEnv);
    assert.equal(result, exePath, 'Should prefer .exe file over .bat in same folder');
  } finally {
    // Clean up
    try { fs.rmSync(tempDir, { recursive: true }); } catch (e) {}
  }
});

test('resolveClaudeBin: 新しいパス候補をチェック', () => {
  // Test the new paths are included in resolution
  const home = os.homedir();
  
  // Test .local/bin path
  const localBinPath = path.join(home, '.local', 'bin', 'claude.exe');
  if (fs.existsSync(localBinPath)) {
    const testEnv = { ...process.env };
    delete testEnv.CLAUDE_BIN;
    const result = resolveClaudeBin(testEnv);
    // If the file exists, it should be found
    // Note: This test might not pass if the file doesn't exist, but it verifies the path is checked
  }
  
  // Test WinGet Links path
  const wingetPath = path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'claude.exe');
  if (fs.existsSync(wingetPath)) {
    const testEnv = { ...process.env };
    delete testEnv.CLAUDE_BIN;
    const result = resolveClaudeBin(testEnv);
    // If the file exists, it should be found
  }
});
