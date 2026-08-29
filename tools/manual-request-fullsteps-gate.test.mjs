// manual-request-fullsteps-gate.mjs の実挙動テスト（judge() 単体ではなく stdin→stdout の契約を見る）。
// なぜ: Stop hook は「transcript のどこを読むか」で壊れる。実際、委譲実装は末尾から遡って
// 集めていたため "1つ前のターン" を読んでいた。judge() のテストだけでは絶対に見つからない。
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manual-request-fullsteps-gate.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'fullsteps-test-'));

const BAD = '退避コマンドがブロックされました。次を1回実行してください:\n\n```\nnode close-session.mjs --session xxx\n```\n\n実行しなくても作業内容は残っています。';
const GOOD = [
  'PowerShell を開いて1行貼るだけです。やらなくても実害はありません。',
  '1. Windows キーを押します。',
  '2. `powershell` と入力して Enter を押します。',
  '3. 青い画面で右クリックして貼り付け、Enter を押してください。',
  '成功すると `closed: ...` と表示されます。',
  '出ない場合やエラーが出た場合は、画面の文字をそのまま貼ってください。',
].join('\n');

function run(entries, { stopHookActive = false } = {}) {
  const tp = path.join(tmp, `t${Math.round(entries.length * 1e6) % 1e6}-${entries[0].type}.jsonl`);
  writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ stop_hook_active: stopHookActive, transcript_path: tp }),
    encoding: 'utf8', timeout: 20000,
  });
  return { out: (r.stdout || '').trim(), status: r.status };
}

const userLine = (text) => ({ type: 'user', message: { content: text } });
const asstLine = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const cases = [
  ['手順が無い依頼は止める', [userLine('これ'), asstLine(BAD)], true],
  ['フル手順の依頼は通す', [userLine('これ'), asstLine(GOOD)], false],
  ['前のターンの不備で止めない', [userLine('a'), asstLine(BAD), userLine('b'), asstLine('直しました。')], false],
  ['逃がし弁 [MANUAL-OK] は通す', [userLine('x'), asstLine(BAD + '\n[MANUAL-OK]')], false],
  ['stop_hook_active はループ防止で通す', [userLine('x'), asstLine(BAD)], false, { stopHookActive: true }],
];

let failed = 0;
for (const [name, entries, wantBlock, opts] of cases) {
  const { out, status } = run(entries, opts || {});
  const blocked = out.includes('"decision":"block"');
  const ok = blocked === wantBlock && status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}（block=${blocked} 期待=${wantBlock} exit=${status}）`);
}
console.log(failed ? `${failed} 件失敗` : 'すべて通過');
process.exit(failed ? 1 : 0);
