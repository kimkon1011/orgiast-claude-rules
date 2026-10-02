import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, formatReason } from './gh-handoff-gate.mjs';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gh-handoff-gate.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-handoff-test-'));

function run(entries, { stopHookActive = false } = {}) {
  const tp = path.join(tmp, `t${Math.round(Math.random() * 1e6)}.jsonl`);
  writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ stop_hook_active: stopHookActive, transcript_path: tp }),
    encoding: 'utf8', timeout: 20000,
  });
  return { out: (r.stdout || '').trim(), status: r.status };
}

const userLine = (text) => ({ type: 'user', message: { content: text } });
const asstLine = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

// --- Unit tests for judge ---
test('judge unit test - block case', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします';
  const result = judge(text);
  assert.deepEqual(result, { triggered: true, missing: ['credential fill の試行結果'] });
});

test('judge unit test - pass with credential fill', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n確認済み: git credential fill → exit 1（credential helper 未設定）';
  const result = judge(text);
  assert.deepEqual(result, { triggered: true, missing: [] });
});

test('judge unit test - pass with escape valve', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n[GH-HANDOFF-OK]';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});

test('judge unit test - reports (no request)', () => {
  const text = 'PR を作成しました。gh auth login は不要でした';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});

test('judge unit test - request but no auth issue', () => {
  const text = 'マージをお願いします';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});

test('judge unit test - inside code block only', () => {
  const text = 'PR 作成をお願いします\n```\ngh auth status で未認証\n```';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});


// --- Trigger (c): GitHub 認証そのものの操作依頼（2026-09-30 の実文） ---
const L = (...lines) => lines.join('\n');

const P1 = L(
  '認証コードが出ました。**ブラウザが自動で開いています。**',
  '',
  '## kim にお願いする操作（1回だけ）',
  '',
  '開いたページで **`E517-4DB5`** を入力して Authorize を押してください。有効期限は約15分（切れたら自動で新しいコードを出します）。ページが開いていなければ https://github.com/login/device です。',
  '',
  '承認が通れば `gh auth login --with-token` まで自動で流れ、以降 PR 作成・状態確認を Claude 側で完結できます。',
);

const P2 = L(
  '## kim にお願いする操作（1回だけ）',
  '',
  '**[手渡し判定]**',
  '',
  '試したこと:',
  '- ① `gh pr create --base main --head auto/20260926-0dec-verify ...` を実行 → **exit 4**。`To get started with GitHub CLI, please run: gh auth login` が返り、トークンが無いため PR を作れない',
  '- ② `.env*` を Grep tool で `^(GH_TOKEN|GITHUB_TOKEN|GH_PAT|GITHUB_PAT)=` 検索 → **No files found**。ローカルにトークンは保存されていない',
  '',
  'user でないと無理な理由: **OAuth 初回同意**。GitHub アカウント本人がブラウザで承認する必要があり、Claude 側からは代行できません。',
  '',
  '次に kim がすること: https://github.com/login/device を開き、コード `E517-4DB5` を入力して権限を承認してください',
);

const P3 = L(
  '新しいコードが出ました。ブラウザも開いています。',
  '',
  '## いま入力してください',
  '',
  '**コード: `EAE7-10E5`**',
  '',
  'URL: https://github.com/login/device （自動で開いたタブがあればそれでOK）',
  '',
  '1. 入力欄に `EAE7-10E5` をハイフン込みで入れる',
  '2. 続行 → 権限（repo / workflow / read:org）を承認',
  '',
  '次に kim がすること: https://github.com/login/device で `EAE7-10E5` を入力し、権限を承認してください',
);

const P4 = L(
  'コードは有効なままです。**古いタブに入力されたのが原因**でした。コード入力が要らない直リンクをどうぞ。',
  '',
  '## このリンクを開いてください',
  '',
  'https://github.com/login/device?user_code=F30C-917F',
  '',
  '次に kim がすること: https://github.com/login/device?user_code=F30C-917F を開いて権限を承認してください（コード入力は不要）',
);

test('trigger(c) P1 device-auth handoff with code → block', () => {
  assert.deepEqual(judge(P1), { triggered: true, missing: ['credential fill の試行結果'] });
});

test('trigger(c) P2 handoff with gh auth login evidence → block', () => {
  assert.deepEqual(judge(P2), { triggered: true, missing: ['credential fill の試行結果'] });
});

test('trigger(c) P3 code entry request → block', () => {
  assert.deepEqual(judge(P3), { triggered: true, missing: ['credential fill の試行結果'] });
});

test('trigger(c) P4 direct link request → block', () => {
  assert.deepEqual(judge(P4), { triggered: true, missing: ['credential fill の試行結果'] });
});

test('trigger(c) N1 status report only → pass', () => {
  assert.deepEqual(judge('3日経過しているので、デバイス認証を始める前に現状を確認します。'), { triggered: false, missing: [] });
});

test('trigger(c) N2 completion report → pass', () => {
  assert.deepEqual(
    judge('**PR #15 を作成しました**: https://github.com/seisaku-team-cell/nf-minpaku-automation/pull/15 — kim のデバイス認証は最初から不要でした。'),
    { triggered: false, missing: [] },
  );
});

test('trigger(c) N3 mention without request wording → pass', () => {
  assert.deepEqual(
    judge('github.com/login/device は使わず、git credential fill の PAT で PR を作りました。'),
    { triggered: false, missing: [] },
  );
});

test('trigger(c) N4 P3 with credential fill evidence → triggered but pass', () => {
  const text = P3 + L('試したこと: git credential fill → password 行なし（helper に github.com の資格情報なし）、git push --dry-run も 403');
  assert.deepEqual(judge(text), { triggered: true, missing: [] });
});

test('trigger(c) N5 P1 with escape valve → pass', () => {
  assert.deepEqual(judge(P1 + L('[GH-HANDOFF-OK]')), { triggered: false, missing: [] });
});

test('trigger(c) N6 non-GitHub device auth (codex/openai) → pass', () => {
  assert.deepEqual(
    judge('WSL で codex login --device-auth を実行したので、表示された auth.openai.com のページでコードを入力してください'),
    { triggered: false, missing: [] },
  );
});

test('trigger(c) N7 non-GitHub auth (Slack) → pass', () => {
  assert.deepEqual(judge('claude.ai のコネクタ設定で Slack を認証してください'), { triggered: false, missing: [] });
});

test('trigger(c) N8 inside code block only → pass', () => {
  assert.deepEqual(judge(L('設定は次の通り', '```', 'gh auth login してください', '```')), { triggered: false, missing: [] });
});

// --- Integration tests for stdin/stdout ---
test('Integration: unauthenticated gh without credential fill → block', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.ok(out.includes('"decision":"block"'), `stdout should block: ${out}`);
  assert.ok(out.includes('[GH-HANDOFF]'), `stdout should contain reason: ${out}`);
  assert.equal(status, 0);
});

test('Integration: unauthenticated gh with credential fill → pass', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n確認済み: git credential fill → exit 1';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'should pass and output nothing');
  assert.equal(status, 0);
});

test('Integration: unauthenticated gh with escape valve → pass', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n[GH-HANDOFF-OK]';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'should pass with escape valve and output nothing');
  assert.equal(status, 0);
});

test('Integration: report/completed action → pass', () => {
  const text = 'PR を作成しました。gh auth login は不要でした';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'completed action report should pass and output nothing');
  assert.equal(status, 0);
});

test('Integration: request but no gh mention → pass', () => {
  const text = 'マージをお願いします';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'no gh unauthenticated mention should pass and output nothing');
  assert.equal(status, 0);
});

test('Integration: stop_hook_active: true → pass', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします';
  const { out, status } = run([userLine('start'), asstLine(text)], { stopHookActive: true });
  assert.equal(out, '', 'stop_hook_active: true should pass and output nothing');
  assert.equal(status, 0);
});

test('Integration: device-auth handoff (P1) → block', () => {
  const { out, status } = run([userLine('start'), asstLine(P1)]);
  assert.ok(out.includes('"decision":"block"'), `stdout should block: ${out}`);
  assert.ok(out.includes('[GH-HANDOFF]'), `stdout should contain reason: ${out}`);
  assert.equal(status, 0);
});

test('Integration: device-auth handoff with escape valve (N5) → pass', () => {
  const { out, status } = run([userLine('start'), asstLine(P1 + L('[GH-HANDOFF-OK]'))]);
  assert.equal(out, '', 'should pass with escape valve and output nothing');
  assert.equal(status, 0);
});

// 2026-09-17 の実文。「変わらないもの」の列挙に GitHub の認証が出るだけで、認証操作の依頼ではない
test('judge unit test - N9 GitHub の認証 を列挙しただけの報告は通す', () => {
  const text = '**変わらないもの**: clasp（GAS デプロイは seisaku-team の Google 認証のまま動く）、GitHub の認証、Beds24 などの常駐ブラウザ窓、GitHub Actions。\n\n開いたブラウザで nishi@orgiast.jp でログインして『許可』を押してください。';
  assert.deepEqual(judge(text), { triggered: false, missing: [] });
});
