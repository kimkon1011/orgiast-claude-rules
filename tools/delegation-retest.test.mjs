import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCasePrompt, gradeDelegationOutput, formatReport, CASE_IDS, CASES } from './delegation-retest.mjs';

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
