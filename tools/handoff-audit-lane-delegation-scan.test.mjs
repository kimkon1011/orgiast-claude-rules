import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, firstMatch, selftest, scan, stripBanners, CONTROLS } from './handoff-audit-lane-delegation-scan.mjs';

// 走査結果の「0 件」は、検出器が動いていなければ意味を持たない。
// 対照（陽性7・陰性6）が全通過することを先に固定する。
test('検出器の対照が全通過する（陽性7・陰性6）', () => {
  const r = selftest();
  assert.equal(r.passed, r.total, JSON.stringify(r.failures));
  assert.equal(r.total, 13);
  assert.ok(CONTROLS.some((c) => c.want === true), '陽性対照が無いと 0 件が無意味になる');
  assert.ok(CONTROLS.some((c) => c.want === false), '陰性対照が無いと常時 true の検出器を見逃す');
});

test('委譲語と実行中語が近接したときだけ陽性', () => {
  assert.equal(detect('Codex に委譲しました（バックグラウンド実行中 ID: b3kw1ixab）。'), true);
  assert.equal(detect('実装は Codex レーンに渡して実行中です。完了通知を待ちます。'), true);
  assert.equal(detect('委譲実行中です（executor=fallback:cheap-code:deepseek）。'), true);
  assert.equal(detect('サブエージェントに実装を委譲して実行中です。次に kim がすること: なし（待機）。'), true);
});

test('委譲しても完了していれば陽性にしない（実行中語が無い）', () => {
  assert.equal(detect('Codex に委譲して実装完了、テスト全件 PASS しました。'), false);
  assert.equal(detect('委譲判定: 実装=Codex（完了）→ 監督 verify 完了。'), false);
});

// 「委譲語＋完了待ち」は、委譲先の完了を実測せず報告を閉じる型なので陽性にする。
// 「完了」単体（実装完了・verify 完了）は上で陰性のまま＝語を広げすぎていないことを固定する。
test('委譲先の完了待ちは陽性（通知を挟まない variant を含む）', () => {
  assert.equal(detect('実装レーン（codex-do → Gemini フォールバック）の完了待ちです。'), true);
  assert.equal(detect('Codex の T1〜T3 と Drive アップロードの完了を待っています。'), true);
});

// 限界の明示: 実行中語が入っても DELEG 語（裸の「Gemini」は DELEG ではない）が
// 80 文字以内に無ければ陰性のまま。02:17:35Z の「終了通知を待ちます」単独がその実例。
test('DELEG 語が近傍に無い完了待ちは陰性（裸の Gemini は DELEG ではない）', () => {
  assert.equal(detect('Gemini は引き続きシェル拒否のまま進行中です。終了通知を待ちます。'), false);
});

test('実行中語だけ（委譲語が無い）は陽性にしない', () => {
  assert.equal(detect('実行中のプロセスは kill されるため run_in_background は禁止です。'), false);
  assert.equal(detect('実装は完了し、テストは全件 PASS しました。'), false);
});

test('近接していなければ陽性にしない（離れた語の共起は対象外）', () => {
  const far = 'Codex に委譲しました。' + 'あ'.repeat(200) + 'この処理が実行中かは不明です。';
  assert.equal(detect(far), false, '80 文字を超えて離れた語は共起としない');
});

test('監査TODO文そのもの（自セッションのプロンプト）は再発として数えない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-delegation-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const todo = 'サブエージェント/他AIレーンへ実装を委譲して『実行中』で終わる [handoff-audit:e9640ea79ef414e9] 再発を検証する';
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'aaaaaaaa', excerpt: todo }) + '\n' +
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'bbbbbbbb', excerpt: 'Codex に委譲しました（バックグラウンド実行中）。' }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.ledger.scanned, 2);
  assert.equal(r.hits, 1, 'TODO文を除外し、本物の1件だけを数える');
  assert.equal(r.rows[0].id, 'bbbbbbbb');
  assert.equal(r.rows[0].inTurn, false, 'ledger 由来は transcript の実行記録を持たない');
  assert.equal(r.recurrences, 1);
  assert.equal(r.inTurnHits, 0);
});

test('窓の外は数えない（窓の境界を実測値で固定する）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-delegation-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', sessionId: 'old00000', excerpt: 'Codex に委譲して実行中です。' }) + '\n');
  const r = scan({ home, since: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(r.ledger.total, 1);
  assert.equal(r.ledger.scanned, 0);
  assert.equal(r.hits, 0);
});

test('assistant 以外の turn は数えない（報告する側だけを見る）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-delegation-scan-'));
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Codex に委譲して実行中で終わらないでください。' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Codex レーンに渡して実行中です。完了通知を待ちます。' }] }, timestamp: new Date().toISOString() }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.hits, 1, 'user turn は数えず、assistant の1件だけを数える');
  assert.match(r.rows[0].match, /実行中/);
});

test('firstMatch は人手分類の根拠になる一致部分を返す', () => {
  assert.equal(firstMatch('委譲実行中です（executor=fallback）。'), '委譲実行中');
  assert.equal(firstMatch('実装は完了しました。'), '');
});

// 2026-10-15 の実測で FP 6 件中 5 件がこれだった。注入バナーは全 turn に必ず入るので、
// 除去しないと「委譲判定」の委譲 × 「夜間判定」の待機 が機械的に共起して偽陽性になる。
test('注入バナーだけの共起は陽性にしない（FP の主因を潰す）', () => {
  const bannerOnly = [
    '実装は数行なので自分で行います。',
    '**[委譲判定]** 自分で実施（理由: 数行/設定/設計試行錯誤中）',
    '**[夜間判定]** 即時実行（理由: 締切が近く、待機理由なし）',
  ].join('\n');
  assert.equal(detect(bannerOnly), false, 'バナー同士の共起を再発と数えてはいけない');
});

test('バナーの後ろに本物の委譲実行中があれば陽性のまま（過剰マスクしない）', () => {
  const withReal = [
    '**[委譲判定]** 実装=Codex（理由: 定型の量産）',
    '**[夜間判定]** 即時実行（理由: 待機理由なし）',
    'Codex に委譲しました（バックグラウンド実行中 ID: b3kw1ixab）。',
  ].join('\n');
  assert.equal(detect(withReal), true, '本物の再発をバナー除去で消してはいけない');
});

test('stripBanners はバナー行だけを落とし、他の行は残す', () => {
  const src = '前の行\n**[委譲判定]** 自分で実施（理由: x）\n後の行 Codex に渡した';
  const out = stripBanners(src);
  assert.ok(!out.includes('委譲判定'), 'バナー本体は残らない');
  assert.ok(out.includes('前の行') && out.includes('後の行'), '前後の本文は残る');
});

test('待機プロセスの完了報告は陽性にしない', () => {
  assert.equal(detect('ブラウザログイン用の待機プロセスが後から閉じただけで、cheap-code の修正は完了しています。'), false);
});

// scan 側は改行を潰す前に判定する。潰した後だとバナーの行末が拾えず FP が戻る。
test('scan はバナー付き turn を FP 計上しない（改行を潰す前に判定する）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-delegation-scan-'));
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const bannerText = '実装は数行なので自分で行います。\n**[委譲判定]** 自分で実施（理由: 数行）\n**[夜間判定]** 即時実行（理由: 待機理由なし）';
  fs.writeFileSync(path.join(proj, 's.jsonl'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: bannerText }] }, timestamp: new Date().toISOString() }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.transcript.turnsScanned, 1);
  assert.equal(r.hits, 0, 'バナーだけの turn は 0 件');
});

function scanInTurnCase(records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-delegation-scan-'));
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return scan({ home, since: Date.now() - 86400_000 });
}

const hitAssistant = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'CI の完了を待って作業を Codex に任せます。' }] },
  timestamp: new Date().toISOString(),
};
const realUserPrompt = { type: 'user', message: { role: 'user', content: '次の依頼です。' } };

test('同一 user-turn 内で codex-do の tool_use と tool_result があれば完了扱いにする', () => {
  const r = scanInTurnCase([
    hitAssistant,
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/codex-do.mjs task.md' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '完了' }] } },
    realUserPrompt,
  ]);
  assert.equal(r.rows[0].inTurn, true);
  assert.equal(r.recurrences, 0);
  assert.equal(r.inTurnHits, 1);
  assert.equal(r.hits, 1);
});

test('次の本物の user プロンプトまでに実行が無ければ再発扱いにする', () => {
  const r = scanInTurnCase([hitAssistant, realUserPrompt]);
  assert.equal(r.rows[0].inTurn, false);
  assert.equal(r.recurrences, 1);
});

test('別 tool の tool_use と tool_result だけなら完了扱いにしない', () => {
  const r = scanInTurnCase([
    hitAssistant,
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'files' }] } },
    realUserPrompt,
  ]);
  assert.equal(r.rows[0].inTurn, false);
  assert.equal(r.recurrences, 1);
});

test('codex-do の tool_use 後に tool_result が無ければ完了扱いにしない', () => {
  const r = scanInTurnCase([
    hitAssistant,
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/codex-do.mjs task.md' } }] } },
    realUserPrompt,
  ]);
  assert.equal(r.rows[0].inTurn, false);
  assert.equal(r.recurrences, 1);
});

test('hit より前に起動した codex exec の tool_result が hit 後に返れば完了扱いにする', () => {
  const r = scanInTurnCase([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '実装して' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'timeout 1800 codex exec --approve-for-me -C "X" - < task.md' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Codex に実装を投げました（背景実行）。完了通知を待つ間に仕様を置きます。' }] }, timestamp: new Date().toISOString() },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'done' }] } },
  ]);
  assert.equal(r.rows[0].inTurn, true);
  assert.equal(r.recurrences, 0);
});

test('hit より前に codex exec を起動しても hit 後に tool_result が無ければ再発扱いにする', () => {
  const r = scanInTurnCase([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '実装して' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'timeout 1800 codex exec --approve-for-me -C "X" - < task.md' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Codex に実装を投げました（背景実行）。完了通知を待つ間に仕様を置きます。' }] }, timestamp: new Date().toISOString() },
  ]);
  assert.equal(r.rows[0].inTurn, false);
  assert.equal(r.recurrences, 1);
});

test('Stop hook feedback 文字列は turn を切らない', () => {
  const r = scanInTurnCase([
    hitAssistant,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/codex-do.mjs task.md' } }] } },
    { type: 'user', message: { role: 'user', content: 'Stop hook feedback:\n### next-action-gate ...' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '完了' }] } },
  ]);
  assert.equal(r.rows[0].inTurn, true);
});

test('背景起動の完了は task-notification completed で拾う', () => {
  const r = scanInTurnCase([
    hitAssistant,
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: { command: 'timeout 1800 codex exec --approve-for-me -C "X" - < task.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: b1' }] } },
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<tool-use-id>toolu_abc</tool-use-id>\n<status>completed</status>\n</task-notification>' } },
  ]);
  assert.equal(r.rows[0].inTurn, true);
});

test('task-notification が completed でなければ再発扱いにする', () => {
  const r = scanInTurnCase([
    hitAssistant,
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: { command: 'timeout 1800 codex exec --approve-for-me -C "X" - < task.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: b1' }] } },
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<tool-use-id>toolu_abc</tool-use-id>\n<status>failed</status>\n</task-notification>' } },
  ]);
  assert.equal(r.rows[0].inTurn, false);
});
