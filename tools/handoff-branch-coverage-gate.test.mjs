import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './handoff-branch-coverage-gate.mjs';
import { hasManualRequest } from './manual-request-fullsteps-gate.mjs';
import { isEntry } from './is-entry.mjs';

const GATE = fileURLToPath(new URL('./handoff-branch-coverage-gate.mjs', import.meta.url));
const BAD = '設定してください。\n1. 初回は新規に作成します。';
const GOOD = `${BAD}\n2. 既存の設定が表示されていたら、その設定を開きます。`;
const BAD_REAL = `## お願い: Search Console にサイトを登録してください
### 手順
**手順4.** 初回は「Google Search Console へようこそ」という画面が出ます。プロパティタイプが2つ並んでいるので、右側の「URL プレフィックス」を選んでください。
**手順5.** 入力欄に貼り付けます。
**手順6.** 続行をクリックします。
### 成功したときの画面表示
「所有権を確認しました」と出れば成功です。
### 失敗時の対応表
| 症状 | 対策 |
|---|---|
| 手順4で「ようこそ」画面が出ず、いきなりレポート画面になる | 既にプロパティが登録されています。プロパティを追加から同じ画面に行けます |`;
const GOOD_REAL = `## お願い: Search Console にサイトマップを登録してください
### 手順4（見分け）
| 画面に見えているもの | 進む先 |
|---|---|
| 「ようこそ」という大きな文字 | 経路A へ |
| プルダウンに tetsuko.co.jp が無い | 経路B へ |
| プルダウンに tetsuko.co.jp が既にある | 経路C へ |
### 経路A — プロパティが1つも無い場合
**A-1.** 右側の「URL プレフィックス」をクリックします。
**A-2.** 入力欄に貼り付けます。
### 経路C — tetsuko.co.jp が既に登録済みの場合
**C-1.** プルダウンから tetsuko.co.jp を選びます。
**C-2.** 所有権の確認は既に済んでいます。共通手順8へ進んでください。
### 成功したときの画面表示
「サイトマップを送信しました」と出れば成功です。
### 失敗時の対応表
| 症状 | 対策 |
|---|---|
| どれにも当てはまらない | 画面の内容を貼ってください |`;
const blocked = { triggered: true, missing: ['分岐:既存の場合'] };
const passed = { triggered: true, missing: [] };
const skipped = { triggered: false, missing: [] };

export async function runTests() {
    let failed = 0;
    let total = 0;
    async function test(name, fn) {
        total++;
        try { await fn(); console.log(`PASS（緑） ${name}`); }
        catch (error) { failed++; console.error(`FAIL（赤） ${name}\n${error.stack}`); }
    }
    const cases = [
        ['BAD_REAL: 既存分岐が失敗時対応表だけなら止める', BAD_REAL, blocked],
        ['GOOD_REAL: 本流に新規と既存の経路があれば通す', GOOD_REAL, passed],
        ['GOOD_REAL: 対応表の依頼がなくても起動する', GOOD_REAL.replace('画面の内容を貼ってください', '画面の内容を確認'), passed],
        ['初回だけの依頼を止める', BAD, blocked],
        ['対になる分岐が対応表の中だけなら止める', `${BAD}\n### 失敗時の対応表\n| 症状 | 対策 |\n| 登録済み | 開く |`, blocked],
        ['本流の番号付き手順に両方あれば通す', GOOD, passed],
        ['決め打ち語がなければ通す', '設定してください。', passed],
        ['報告だけなら起動しない', '初回は設定しました。完了しました。', skipped],
        ['理由付きの逃げ道は通す', `${BAD}\n[BRANCH-OK: 対象が新規構築のみのため]`, skipped],
        ['理由なしの逃げ道は通さない', `${BAD}\n[BRANCH-OK]`, blocked],
        ['空白だけの理由は通さない', `${BAD}\n[BRANCH-OK: 　]`, blocked],
        ['見出しなしの症状テーブルも除外する', `${BAD}\n| 症状 | 対策 |\n| 設定済みの場合 | 開く |`, blocked],
        ['次の見出しで本流に復帰する', `${BAD}\n### うまくいかない場合\nエラーを確認\n## 登録済みの場合\n1. 設定を開く。`, passed],
        ['表以降も次の見出しまでは除外する', `${BAD}\n| 症状 | 対策 |\n\n2. 既存の設定を開く。`, blocked],
        ['対応表という見出しだけでも除外する', `${BAD}\n### 対応表\n登録済みなら開く。`, blocked],
        ['コード例の既存分岐は通さない', `${BAD}\n\`\`\`\n既存の設定\n\`\`\``, blocked],
        ['コード例の依頼では起動しない', `\`\`\`\n${BAD}\n\`\`\``, skipped],
        ['コード例の逃げ道は通さない', `${BAD}\n\`\`\`\n[BRANCH-OK: 例]\n\`\`\``, blocked],
        ['お願いの依頼も検査する', '登録をお願いします。初回のみ作成します。', blocked],
        ['挨拶では起動しない', '初回は完了。よろしくお願いします。', skipped],
    ];
    for (const request of ['登録してください', '選んでください', '進んでください']) {
        await test(`依頼検出: ${request}`, () => assert.equal(hasManualRequest(request), true));
        for (const step of ['**手順4.**', '**A-1.**', '1.', '']) {
            cases.push([`番号形式に依存しない: ${request} / ${step || '番号なし'}`, `${request}。\n${step} 初回は作成します。`, blocked]);
        }
        cases.push([`コード内の依頼は起動しない: ${request}`, `\`\`\`\n${request}\n\`\`\`\n初回は作成します。`, skipped]);
    }
    for (const report of ['登録しました', '選んでいます', '進んでいます']) {
        cases.push([`報告と依頼を区別する: ${report}`, `${report}。初回は完了。`, skipped]);
    }
    for (const word of ['初回は', '初めて', 'はじめて', '新規に作成', 'まだ登録されていない', '未登録の場合', '初回のみ']) {
        cases.push([`決め打ち語: ${word}`, `設定してください。\n1. ${word}`, blocked]);
    }
    for (const word of ['既に', 'すでに', '登録済み', '作成済み', '2回目以降', '設定済みの場合', '既存の']) {
        cases.push([`既存分岐: ${word}`, `${BAD}\n2. ${word}なら設定を開く。`, passed]);
    }
    for (const [name, text, expected] of cases) await test(name, () => assert.deepEqual(check(text), expected));

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'branch-coverage-'));
    try {
        const transcript = path.join(tmp, '日本語の履歴.jsonl');
        const entry = text => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
        const run = payload => spawnSync(process.execPath, [GATE], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000 });
        writeFileSync(transcript, entry(BAD), 'utf8');
        await test('hook は stderr reason・stdout block・exit 0', () => {
            const result = run({ transcript_path: transcript });
            assert.equal(result.status, 0);
            const output = JSON.parse(result.stdout);
            assert.equal(output.decision, 'block');
            assert.equal(result.stderr.trim(), output.reason);
            for (const text of ['[BRANCH-COVERAGE] 状態を片方に決め打ちした手順です', '分岐:既存の場合', '本流の手順として両方の分岐を書くこと。失敗時対応表に逃がすのは不可', '既存かどうかを user に確認させるのではなく', 'user が画面で見分けられる目印', '[BRANCH-OK: 理由]']) assert.ok(output.reason.includes(text));
        });
        await test('UTF-8 を1バイトずつ送っても日本語パスを読める', async () => {
            const child = spawn(process.execPath, [GATE], { stdio: ['pipe', 'pipe', 'pipe'] });
            let out = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => { out += chunk; });
            child.stderr.resume();
            const done = new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('close', resolve);
            });
            const timer = setTimeout(() => child.kill(), 20000);
            try {
                for (const byte of Buffer.from('\uFEFF' + JSON.stringify({ transcript_path: transcript }), 'utf8')) {
                    child.stdin.write(Buffer.from([byte]));
                }
                child.stdin.end();
                assert.equal(await done, 0);
                assert.equal(JSON.parse(out).decision, 'block');
            } finally { clearTimeout(timer); }
        });
        for (const [name, payload] of [
            ['再入を防止する', { transcript_path: transcript, stop_hook_active: true }],
            ['履歴がない場合は fail-open', {}],
        ]) await test(name, () => {
            const result = run(payload);
            assert.equal(result.status, 0);
            assert.equal(result.stdout + result.stderr, '');
        });
        await test('最新の応答を判定し古い不備を拾わない', () => {
            writeFileSync(transcript, [entry(BAD), entry(GOOD)].join('\n'), 'utf8');
            const result = run({ transcript_path: transcript });
            assert.equal(result.status, 0);
            assert.equal(result.stdout + result.stderr, '');
        });
        await test('壊れた payload は fail-open', () => {
            const result = spawnSync(process.execPath, [GATE], { input: '{', encoding: 'utf8', timeout: 20000 });
            assert.equal(result.status, 0);
            assert.equal(result.stdout + result.stderr, '');
        });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    console.log(`${total - failed}/${total} 件通過${failed ? `（${failed} 件失敗）` : '（全緑）'}`);
    return failed ? 1 : 0;
}

if (isEntry(import.meta.url)) process.exitCode = await runTests();
