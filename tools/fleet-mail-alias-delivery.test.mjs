import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, resolveDeliverableTarget, sameMachineLabels } from './fleet-mail.mjs';
import { classifyFleet } from './fleet-liveness.mjs';
import { buildFleetStatus } from './fleet-status.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realMap = JSON.parse(fs.readFileSync(path.join(repo, 'fleet-pc-map.json'), 'utf8'));
const NOW = Date.parse('2026-10-13T00:00:00Z');
const polled = (label, at = '2026-10-12T23:50:00Z') => ({ label, reportedAt: at, pollAt: at });
const ok = (beacons = [], serverPolls = {}) => ({ ok: true, beacons, serverPolls });

// 旧データ形（同一実機が2キー）でも解決できること。
const splitMap = {
  '作業用011': { remoteName: '作業用011', hostname: '作業用011' },
  'cr-PC': { hostname: '作業用011', aliases: ['作業用011'] },
  'kim-PC': { hostname: 'DESKTOP-2D0R4LI' },
};

test('sameMachineLabels は hostname 一致・aliases 相互包含を同一実機とみなす', () => {
  assert.deepEqual(sameMachineLabels('cr-PC', splitMap), ['作業用011']);
  assert.deepEqual(sameMachineLabels('kim-PC', splitMap), []);
  assert.deepEqual(sameMachineLabels('cr-PC', { 'a': { hostname: 'h1', aliases: ['cr-PC'] } }), ['a']);
  assert.deepEqual(sameMachineLabels('nobody', undefined), []);
});

test('統合後の実データ: cr-PC は 作業用011 の alias として解決される', () => {
  assert.deepEqual(sameMachineLabels('cr-PC', realMap), ['作業用011']);
  assert.equal(realMap['cr-PC'], undefined);
  assert.equal(realMap['作業用011'].account, 'cr@orgiast.jp');
});

test('poll 実績の無い宛先は同一実機の poll 実績ラベルへ付け替える', async () => {
  const r = await resolveDeliverableTarget({ to: 'cr-PC', now: () => NOW, pcMap: splitMap, fetchBeacons: async () => ok([polled('作業用011')]) });
  assert.equal(r.status, 'redirect');
  assert.equal(r.to, '作業用011');
  assert.equal(r.text, '宛先 cr-PC → 作業用011 に解決（同一実機）');
});

test('宛先自身に poll 実績があれば付け替えない', async () => {
  const r = await resolveDeliverableTarget({ to: 'cr-PC', now: () => NOW, pcMap: splitMap, fetchBeacons: async () => ok([polled('作業用011'), polled('cr-PC')]) });
  assert.equal(r.status, 'ok');
  assert.equal(r.to, 'cr-PC');
});

test('どのラベルにも poll 実績が無ければ none（poll 実績のあるラベルを返す）', async () => {
  const r = await resolveDeliverableTarget({ to: 'ghost-PC', now: () => NOW, pcMap: splitMap, fetchBeacons: async () => ok([polled('kim-PC')]) });
  assert.equal(r.status, 'none');
  assert.deepEqual(r.labels, ['kim-PC']);
});

test('ビーコン取得失敗・例外・all は fail-open', async () => {
  assert.equal((await resolveDeliverableTarget({ to: 'x', fetchBeacons: async () => ({ ok: false, reason: 'HTTP 500' }) })).status, 'unknown');
  assert.equal((await resolveDeliverableTarget({ to: 'x', fetchBeacons: async () => { throw new Error('offline'); } })).status, 'unknown');
  assert.equal((await resolveDeliverableTarget({ to: 'all', fetchBeacons: async () => assert.fail('no fetch') })).status, 'ok');
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-alias-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL="https://example.invalid/mail"\nFLEET_SHEET_TOKEN=test-token\n');
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const body = path.join(home, 'body.txt'); fs.writeFileSync(body, '質問');
  const calls = [], errors = [];
  const deps = { home, identity: { hostname: 'host-kim' }, stdout: () => {}, stderr: x => errors.push(x), now: () => NOW, randomInt: () => 1234, pcMap: splitMap,
    request: async (kind, payload) => { calls.push({ kind, payload }); return { mail: payload }; } };
  return { body, deps, calls, errors };
}
const sendArgs = (f, to, extra = []) => ['--send', '--to', to, '--kind', 'note', '--body-file', f.body, '--why', 't', ...extra];

test('main --send: cr-PC 宛を 作業用011 に付け替えて送り stderr に表示する', async t => {
  const f = fixture(t);
  f.deps.fetchBeacons = async () => ok([polled('作業用011')]);
  assert.equal(await main(sendArgs(f, 'cr-PC'), f.deps), 0);
  assert.equal(f.calls[0].payload.to, '作業用011');
  assert.ok(f.errors.includes('宛先 cr-PC → 作業用011 に解決（同一実機）'));
});

test('main --send: poll 実績の無い宛先は拒否(6)し、--force なら送る', async t => {
  const f = fixture(t);
  f.deps.fetchBeacons = async () => ok([polled('kim-PC')]);
  assert.equal(await main(sendArgs(f, 'ghost-PC'), f.deps), 6);
  assert.equal(f.calls.length, 0);
  assert.ok(f.errors.some(e => e.includes('poll 実績のあるラベル: kim-PC')));
  assert.equal(await main(sendArgs(f, 'ghost-PC', ['--force']), f.deps), 0);
  assert.equal(f.calls[0].payload.to, 'ghost-PC');
});

test('main --send: ビーコン取得失敗は従来どおり送信する', async t => {
  const f = fixture(t);
  f.deps.fetchBeacons = async () => ({ ok: false, beacons: [], serverPolls: {}, reason: 'HTTP 500' });
  assert.equal(await main(sendArgs(f, 'cr-PC'), f.deps), 0);
  assert.equal(f.calls[0].payload.to, 'cr-PC');
});

test('fleet-pc-map: 同じ hostname を持つキーが複数あってはならない（_sharedHostnameOk 付きは除く）', () => {
  const byHost = new Map();
  for (const [key, entry] of Object.entries(realMap)) {
    if (key.startsWith('_') || !entry || typeof entry !== 'object' || !entry.hostname) continue;
    if (entry._sharedHostnameOk) continue;
    const host = String(entry.hostname).normalize('NFKC').trim().toLowerCase();
    byHost.set(host, [...(byHost.get(host) || []), key]);
  }
  const dup = [...byHost].filter(([, keys]) => keys.length > 1);
  assert.deepEqual(dup, []);
});

test('fleet-pc-map: 統合後は 作業用011 / cr-PC が liveness で1台、fleet-status で1行になる', () => {
  const result = classifyFleet({
    discord: [{ timestamp: '2026-10-12T03:00:00Z', content: '**💻 Claude Code ローカル利用トークン** — 作業用011\n🖥 hostname=作業用011 / user=u / git=cr@orgiast.jp' }],
    sheet: [{ pcName: 'cr-PC', label: '', reportedAt: '2026-10-12' }, { pcName: '作業用011', label: '', reportedAt: '2026-10-12' }],
    pcMap: realMap, now: new Date('2026-10-13T00:00:00Z'),
  });
  assert.equal(result.items.filter(item => /作業用011|cr-PC/.test(item.name)).length, 1);
  const rows = buildFleetStatus({ pcMap: realMap, beacons: [], serverPolls: {}, now: NOW });
  assert.equal(rows.filter(row => ['作業用011', 'cr-PC'].includes(row.label)).length, 1);
});
