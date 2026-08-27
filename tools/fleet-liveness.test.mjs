import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFleet, formatLiveness, loadPcMap, TOOL_INTRODUCED } from './fleet-liveness.mjs';

const now = new Date('2026-08-27T03:00:00.000Z');
const message = (label, hostname, timestamp, email = 'person@example.com') => ({
  timestamp,
  content: `**💻 Claude Code ローカル利用トークン** — ${label}\n🖥 hostname=${hostname} / user=u / git=${email}`,
});

test('4状態を理由付きで分離し never を異常に数えない', () => {
  const sheet = [
    { pcName: 'sheet-only', label: 'SHEET', reportedAt: '2026-08-25 12:00' },
    { pcName: 'both', label: 'BOTH', reportedAt: '2026-08-27 11:00' },
    { pcName: 'never-pc', label: 'NEVER', reportedAt: '' },
  ];
  const discord = [
    message('old', 'old-host', '2026-08-18T03:00:00.000Z'),
    message('BOTH', 'both-host', '2026-08-27T02:00:00.000Z'),
  ];
  const result = classifyFleet({ discord, sheet, now });
  assert.equal(result.items.find((x) => x.name === 'sheet-only').state, 'discord-mute');
  const broken = result.items.find((x) => x.name === 'old');
  assert.equal(broken.state, 'broken');
  assert.match(broken.reason, /2026-08-18/);
  assert.equal(result.items.find((x) => x.name === 'both').state, 'alive');
  assert.equal(result.items.find((x) => x.name === 'never-pc').state, 'never');
  assert.equal(result.counts.never, 1);
  assert.equal(result.counts.broken, 1);
  assert.doesNotMatch(result.items.find((x) => x.state === 'never').reason, /無音|異常/);
});

test('片方失敗を明示して取得できた経路だけで判定する', () => {
  const result = classifyFleet({ discord: [message('pc', 'host', '2026-08-18T03:00:00Z')], sheet: null, now, errors: { sheet: 'timeout' } });
  assert.equal(result.items[0].state, 'broken');
  assert.match(result.warnings[0], /シートの取得に失敗（timeout）/);
  assert.equal(result.unavailable, false);
});

test('両方失敗は unavailable', () => {
  const result = classifyFleet({ discord: null, sheet: null, now, errors: { discord: '401', sheet: 'timeout' } });
  assert.equal(result.unavailable, true);
  assert.equal(result.warnings.length, 2);
});

test('Markdown は状態別見出し、最終報告日、次アクションを含みメールをマスクする', () => {
  const result = classifyFleet({ discord: [message('person@example.com', 'host', '2026-08-18T03:00:00Z')], sheet: [], now });
  const text = formatLiveness(result);
  assert.match(text, /✅ 生存/);
  assert.match(text, /📡 Discordにだけ届かない/);
  assert.match(text, /🚨 壊れて停止/);
  assert.match(text, /◻️ 報告実績なし/);
  assert.match(text, /2026-08-18/);
  assert.match(text, /p\*\*\*@example\.com/);
  assert.match(text, /keyserve/);
});

test('対応表を読み、壊れたファイルは空として扱う', async () => {
  assert.deepEqual(await loadPcMap('/repo', async () => '{"_note":"説明","_pending":{"HP":"確認中"},"HP":{"sheetName":"東邦2階HP"}}'), { HP: { sheetName: '東邦2階HP' } });
  assert.deepEqual(await loadPcMap('/repo', async () => { throw new Error('missing'); }), {});
  assert.deepEqual(await loadPcMap('/repo', async () => '{broken'), {});
});

test('対応表で Discord とシートを1台に統合する', () => {
  const result = classifyFleet({
    discord: [message('HP', 'hp-host', '2026-08-18T03:00:00Z')],
    sheet: [{ pcName: '東邦2階HP', label: '', reportedAt: '' }],
    pcMap: { HP: { sheetName: '東邦2階HP', person: '木下真弓' } }, now,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, '東邦2階HP（HP）');
  assert.equal(result.items[0].state, 'broken');
});

test('legacy-manual は導入日前だけで境界日は broken', () => {
  assert.equal(TOOL_INTRODUCED, '2026-08-20');
  const result = classifyFleet({ discord: [], sheet: [
    { pcName: 'legacy', reportedAt: '2026-08-19' },
    { pcName: 'boundary', reportedAt: '2026-08-20' },
  ], now });
  assert.equal(result.items.find((x) => x.name === 'legacy').state, 'legacy-manual');
  assert.equal(result.items.find((x) => x.name === 'boundary').state, 'broken');
  assert.equal(result.counts.broken, 1);
});

test('未対応の hostname 衝突は勝手に統合しない', () => {
  const result = classifyFleet({
    discord: [message('kim開発機', 'DESKTOP-2D0R4LI', '2026-08-27T02:00:00Z')],
    sheet: [{ pcName: '作業用004民泊用', hostname: 'DESKTOP-2D0R4LI', reportedAt: '2026-08-15' }], now,
  });
  assert.equal(result.items.length, 2);
  const uncertain = result.items.find((x) => x.state === 'uncertain');
  assert.match(uncertain.reason, /作業用004民泊用.*DESKTOP-2D0R4LI.*kim開発機/);
  assert.equal(result.items.find((x) => x.state === 'alive').name, 'kim開発機');
  assert.match(formatLiveness(result), /kim の判断待ち/);
});
