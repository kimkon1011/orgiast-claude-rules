import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { addItem, listItems, markSeen, main, isKimSeat } from '../tools/kim-inbox.mjs';
import { readRelayState } from '../tools/lib/kim-inbox-relay-state.mjs';

/** kim 席の一時ホームを作る。テスト用に env をクリア（ヘッドレス判定を無効化） */
function seat(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-auto-seen-'));
  fs.mkdirSync(path.join(home, '.claude/kim-inbox'), { recursive: true });
  // isKimSeat が true を返すよう fleet label を kim-PC に固定
  fs.writeFileSync(path.join(home, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** --context を 1 回実行するヘルパー。ヘッドレス env を退避してテスト */
async function runContext(home, sessionId, { event = 'UserPromptSubmit' } = {}) {
  const output = [];
  const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const savedHeadlessJob = process.env.ORGIAST_HEADLESS_JOB;
  // ヘッドレス判定を無効化（この環境は headless:cheap-code で起動している）
  process.env.CLAUDE_CODE_ENTRYPOINT = '';
  process.env.ORGIAST_HEADLESS_JOB = '';
  try {
    await main(['--context'], {
      home,
      stdout: s => output.push(s),
      readStdin: async () => JSON.stringify({ hook_event_name: event, session_id: sessionId }),
    });
  } finally {
    process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint;
    process.env.ORGIAST_HEADLESS_JOB = savedHeadlessJob;
  }
  return output;
}

describe('kim-inbox auto-seen', () => {
  it('info を提示後、次ターンで自動 seen になる', async t => {
    const home = seat(t);
    const info = await addItem(home, { kind: 'info', text: 'バッチ完了', source: 'test' });
    assert.equal(info.status, 'open');

    // 1回目の UserPromptSubmit: info が表示される
    await runContext(home, 's1');
    const afterFirst = listItems(home).find(i => i.id === info.id);
    assert.equal(afterFirst.shownCount, 1, '1回目で表示カウントが増える');
    assert.equal(afterFirst.status, 'open', '1回目の直後はまだ open');

    // 2回目の UserPromptSubmit: 自動 seen が走る → open で読み込まれない
    await runContext(home, 's1');
    const afterSecond = listItems(home).find(i => i.id === info.id);
    assert.equal(afterSecond.status, 'seen', '2回目で seen になる');
  });

  it('ask は絶対に自動 seen にならない', async t => {
    const home = seat(t);
    const ask = await addItem(home, { kind: 'ask', text: '判断してください\n承認しますか？', source: 'test' });

    // 複数ターン実行しても ask は seen にならない
    await runContext(home, 's2');
    await runContext(home, 's2');
    await runContext(home, 's2');
    const after = listItems(home).find(i => i.id === ask.id);
    assert.equal(after.status, 'open', 'ask は複数ターン後も open');
    assert.ok(after.shownCount >= 3, 'ask は表示されている');
  });

  it('既に seen の info を二重に seen にしても壊れない（冪等）', async t => {
    const home = seat(t);
    const info = await addItem(home, { kind: 'info', text: '既に確認済み', source: 'test' });
    markSeen(home, info.id);
    assert.equal(listItems(home).find(i => i.id === info.id).status, 'seen');

    // 既に seen の状態で --context を実行してもエラーにならない
    await runContext(home, 's3');
    assert.equal(listItems(home).find(i => i.id === info.id).status, 'seen');
  });

  it('seenAfterPending が relay state に記録される', async t => {
    const home = seat(t);
    const info = await addItem(home, { kind: 'info', text: '今夜のバッチ結果', source: 'test' });

    // 1回目の UserPromptSubmit で info が表示される
    await runContext(home, 'relay-check');
    const relayState = readRelayState(home, 'relay-check');
    assert.ok(relayState.seenAfterPending, 'seenAfterPending が存在する');
    assert.ok(relayState.seenAfterPending.includes(info.id), 'info の ID が記録されている');

    // 2回目の UserPromptSubmit で seenAfterPending がクリアされる
    await runContext(home, 'relay-check');
    const relayState2 = readRelayState(home, 'relay-check');
    assert.ok(!relayState2.seenAfterPending?.length, 'seenAfterPending がクリアされている');
  });

  it('SessionStart では auto-seen が実行されない（seenAfterPending が未記録のため）', async t => {
    const home = seat(t);
    const info = await addItem(home, { kind: 'info', text: 'セッション開始', source: 'test' });

    // SessionStart で context 発行 → info は表示されない（ask のみ優先）
    const output1 = await runContext(home, 'ss1', { event: 'SessionStart' });
    assert.equal(listItems(home).find(i => i.id === info.id).status, 'open', 'SessionStart 後も open');
  });
});