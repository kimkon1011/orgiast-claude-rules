import assert from 'node:assert/strict';
import test from 'node:test';
import { main, runDiscordTaskExec } from './discord-task-exec.mjs';

const NOW = new Date('2026-09-03T01:02:00.000Z');
const row = (id, status = '未着手', memo = '', overrides = {}) => [
  id, '2026-09-01 09:00', 'P1', 85, '締切', `タイトル${id}`, '具体アクション', 'kim', '2026-09-05',
  '経理', '根拠', `https://discord.com/channels/1/2/${id}`, status, memo, '2026-09-01 09:00',
].map((value, index) => Object.hasOwn(overrides, index) ? overrides[index] : value);

function response(value, ok = true, status = 200) {
  return { ok, status, json: async () => value, text: async () => JSON.stringify(value) };
}

function harness(rows, { readBack } = {}) {
  const calls = [], logs = [];
  let getCount = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init, bodyJson: init.body ? JSON.parse(init.body) : undefined });
    if ((init.method || 'GET') === 'GET') {
      getCount++;
      return response(getCount === 1 ? { values: rows } : { values: [readBack || rows[0]] });
    }
    return response({});
  };
  const run = (args) => runDiscordTaskExec({ args, fetchImpl, getToken: async () => 'token', now: NOW, log: (line) => logs.push(line) });
  return { calls, logs, run };
}

test('--list は未完了だけを台帳順で返し、--top で絞る', async () => {
  const h = harness([row('T-0003', '保留'), row('T-0001', '完了'), row('T-0002', '進行中')]);
  const result = await h.run(['--list', '--top', '1']);
  assert.deepEqual(result.map((task) => task.id), ['T-0003']);
  assert.match(h.logs[0], /^T-0003  P1  85  締切/);
});

test('存在しないIDは終了コード2と日本語エラーになる', async () => {
  const errors = [];
  const code = await main(['--show', 'T-9999'], {
    fetchImpl: async () => response({ values: [row('T-0001')] }),
    getToken: async () => 'token',
    error: (line) => errors.push(line),
  });
  assert.equal(code, 2);
  assert.match(errors[0], /ID「T-9999」のタスクが見つかりません/);
});

test('--done はM/N/Oだけを変え、既存memoへ追記する', async () => {
  const original = row('T-0007', '未着手', '既存メモ');
  original[3] = '085';
  const expected = [...original]; expected[12] = '完了'; expected[13] = '既存メモ / 対応済み'; expected[14] = '2026-09-03 10:02';
  const h = harness([original], { readBack: expected });
  await h.run(['--done', 'T-0007', '--memo', '対応済み']);
  const put = h.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(put.bodyJson.values[0], expected);
  assert.deepEqual(put.bodyJson.values[0].slice(0, 12), original.slice(0, 12));
});

test('同じ状態なら書き込みを行わず正常終了する', async () => {
  const h = harness([row('T-0007', '完了')]);
  const result = await h.run(['--done', 'T-0007', '--memo', '再度']);
  assert.equal(result.logged, false);
  assert.equal(h.calls.filter((call) => ['PUT', 'POST'].includes(call.method)).length, 0);
  assert.match(h.logs[0], /変更なし/);
});

test('read-back のIDまたは状態が違えば非0相当の例外になる', async () => {
  const h = harness([row('T-0007')], { readBack: row('T-9999', '未着手') });
  await assert.rejects(h.run(['--done', 'T-0007', '--memo', '完了した']), /書き込み検証に失敗しました/);
});

test('実行ログappendは正しいrangeと行内容を使う', async () => {
  const expected = row('T-0007', '完了', '完了した'); expected[14] = '2026-09-03 10:02';
  const h = harness([row('T-0007')], { readBack: expected });
  await h.run(['--done', 'T-0007', '--memo', '完了した', '--actor', '田中']);
  const post = h.calls.find((call) => call.method === 'POST');
  assert.match(post.url, /%E5%AE%9F%E8%A1%8C%E3%83%AD%E3%82%B0!A%3AF:append\?/);
  assert.deepEqual(post.bodyJson, { range: '実行ログ!A:F', majorDimension: 'ROWS', values: [['2026-09-03 10:02', 'T-0007', 'タイトルT-0007', '田中', '完了', '完了した']] });
});

test('--dry-run ではPUT/POSTを呼ばない', async () => {
  const h = harness([row('T-0007')]);
  const result = await h.run(['--defer', 'T-0007', '--memo', '返事待ち', '--dry-run']);
  assert.equal(result.dryRun, true);
  assert.equal(h.calls.filter((call) => ['PUT', 'POST'].includes(call.method)).length, 0);
});

test('--done / --reject / --defer はmemo必須である', async () => {
  for (const command of ['done', 'reject', 'defer']) {
    await assert.rejects(runDiscordTaskExec({ args: [`--${command}`, 'T-0007'] }), /--memo が必須です/);
  }
});
