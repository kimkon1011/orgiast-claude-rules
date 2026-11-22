import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkArrivals, CHAT_PREFIX, DEFAULT_SINCE } from './checks/minpaku-ingest-arrived.mjs';
import { targetMatches } from './fleet-agent.mjs';
import { resolveMailTarget, resolveDeliverableTarget } from './fleet-mail.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minpaku-arrival-'));
  const dir = path.join(home, '.claude', 'line-openchat');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, rows) => fs.writeFileSync(path.join(dir, name), rows.map(row => JSON.stringify(row)).join('\n'));
  return { home, dir, write };
}
const row = (overrides = {}) => ({ chat: CHAT_PREFIX, receivedAt: DEFAULT_SINCE, text: '清掃の情報', ...overrides });

test('対象チャットの完全名・人数付き前方一致を全jsonlから数える', () => {
  const f = fixture();
  f.write('2026-11.jsonl', [row()]);
  f.write('archive.jsonl', [row({ chat: `${CHAT_PREFIX}(283)`, receivedAt: '2026-11-21T00:00:00Z' })]);
  f.write('ignored.json', [row()]);
  const result = checkArrivals(f);
  assert.equal(result.code, 0);
  assert.match(result.text, /着信 2件・最終 2026-11-21T00:00:00.000Z（走査 2行）/);
});
test('返信・他チャット・空本文・古い行・不正日時は到着証拠にならない', () => {
  const f = fixture();
  f.write('2026-11.jsonl', [row({ chat: 'kim-PC の返信' }), row({ chat: `別${CHAT_PREFIX}` }),
    row({ text: '  ' }), row({ text: null }), row({ receivedAt: '2026-11-01' }), row({ receivedAt: 'invalid' }), null]);
  fs.appendFileSync(path.join(f.dir, '2026-11.jsonl'), '\ninvalid json\n');
  assert.equal(checkArrivals(f).code, 1);
  assert.match(checkArrivals(f).text, /走査 7行/);
});
test('--since は境界を含み、それより古い到着を除外する', () => {
  const f = fixture();
  f.write('2026-11.jsonl', [row()]);
  assert.equal(checkArrivals({ ...f, since: DEFAULT_SINCE }).code, 0);
  assert.equal(checkArrivals({ ...f, since: '2026-11-10T23:54:09Z' }).code, 1);
  assert.throws(() => checkArrivals({ ...f, since: 'bad' }), /--since/);
});
test('データ無しは未到着として走査0行とパス確認を表示する', () => {
  const f = fixture();
  const result = checkArrivals({ home: path.join(f.home, 'missing') });
  assert.equal(result.code, 1);
  assert.match(result.text, /走査 0行・データパスを確認/);
});
test('ディレクトリの読み取り異常を未到着として握り潰さない', () => {
  // Windows では親が通常ファイルだと ENOENT になる。読み取り先そのものをファイルにして OS 差を避ける。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minpaku-arrival-file-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'line-openchat'), 'x');
  assert.throws(() => checkArrivals({ home }), { code: 'ENOTDIR' });
});
test('CLI は ORGIAST_HOME を使い成功0・未到着1・引数エラー2を返す', () => {
  const f = fixture();
  const cli = fileURLToPath(new URL('./checks/minpaku-ingest-arrived.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home } });
  assert.equal(run().status, 1);
  f.write('2026-11.jsonl', [row()]);
  assert.equal(run().status, 0);
  assert.equal(run('--since', 'bad').status, 2);
});
test('000KimPC は受信名札と一致し旧 kim-PC は一致しない', () => {
  assert.equal(targetMatches('000KimPC', '000KimPC', '000KimPC'), true);
  assert.equal(targetMatches('kim-PC', '000KimPC', '000KimPC'), false);
});
test('004minpaku はビーコン・poll 記録から fleet-mail 宛先に解決される', async () => {
  const beacons = [{ label: '004minpaku', hostname: '004minpaku' }];
  const serverPolls = { '004minpaku': '2026-11-21T00:00:00Z' };
  assert.deepEqual(resolveMailTarget('004minpaku', {}, beacons, serverPolls), { to: '004minpaku', resolved: true });
  assert.deepEqual(await resolveDeliverableTarget({ to: '004minpaku', pcMap: {},
    fetchBeacons: async () => ({ ok: true, beacons, serverPolls }) }), { status: 'ok', to: '004minpaku' });
});
