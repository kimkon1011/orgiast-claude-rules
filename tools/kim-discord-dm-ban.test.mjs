// kim 宛 Discord DM 完全停止 再発防止テスト
// 2026-11-10 kim 再指示：「Discord での報告は全て止めて、セッションで行うようにして」
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discordAllowed } from './lib/kim-discord-allowlist.mjs';
import { deliverKim, KIM_DISCORD_USER_ID } from './notify-kim.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-dm-ban-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 1. discordAllowed は任意の allowlist エントリを渡されても false
test('discordAllowed は常に false を返す（allowlist エントリ任意）', () => {
  const result = discordAllowed('【進捗まとめ】 完了', { allowlist: [{ category: 'x', pattern: '.' }] });
  assert.equal(result.allowed, false);
  assert.equal(result.category, null);
});

test('discordAllowed は空テキストでも false', () => {
  assert.equal(discordAllowed('').allowed, false);
  assert.equal(discordAllowed('✅ 自動進行が完了しました').allowed, false);
});

// 2. deliverKim を kim 受け手で呼ぶと fetchImpl が一度も呼ばれない
test('deliverKim は kim 宛なら fetchImpl を呼ばず inbox へ保存する', async t => {
  const dir = home(t);
  let fetchCalled = 0;
  const result = await deliverKim('【進捗まとめ】 完了', {
    home: dir,
    plainJa: false,
    token: 'test-token',
    fetchImpl: async (url) => {
      fetchCalled++;
      return { ok: true, status: 200, json: async () => ({ id: 'channel' }) };
    },
  });
  // userId 未指定 → resolvedUserId は KIM_DISCORD_USER_ID → isKimRecipient = true
  assert.equal(result.delivered, 'session-inbox');
  assert.equal(fetchCalled, 0, 'fetchImpl が呼ばれてはいけません');
});

test('deliverKim で明示 userId=KIM_DISCORD_USER_ID でも fetchImpl は呼ばれない', async t => {
  const dir = home(t);
  let fetchCalled = 0;
  const result = await deliverKim('✅ 完了', {
    home: dir,
    userId: KIM_DISCORD_USER_ID,
    plainJa: false,
    token: 'test-token',
    webhookFallback: true,
    fetchImpl: async (url) => {
      fetchCalled++;
      return { ok: true, status: 200, json: async () => ({ id: 'channel' }) };
    },
  });
  assert.equal(result.delivered, 'session-inbox');
  assert.equal(fetchCalled, 0, 'webhook 用の fetchImpl も呼ばれてはいけません');
});

// 3. 静的走査: tools/**/*.mjs で KIM_DISCORD_USER_ID と /users/@me/channels または webhook 送信を
//    同じ関数内で使う箇所が kim 以外用であることをテストで確認
test('KIM_DISCORD_USER_ID と /users/@me/channels の併用は kim 以外用に限る', () => {
  const toolsDir = new URL('./', import.meta.url);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    return e.isDirectory() ? walk(file) : /\.mjs$/.test(e.name) && !/\.test\./.test(e.name) ? [file] : [];
  });
  const auditedSafe = new Set([
    // notify-kim.mjs: deliverKim が kim 受信者を isKimRecipient で検出 → inbox に保存し
    // Discord/webhook コードへ進む前に return。kim 以外の受信者には DM 経路が残る。
    'notify-kim.mjs',
    // discord-dm.mjs: kim は inbox へ保存、社員のみ DM 送信。isKim 変数で振り分け。
    'discord-dm.mjs',
    // kim-push-relay.mjs: kim の DM を読み取る（送信ではない）。kim 以外への送信は pushKim 経由。
    'kim-push-relay.mjs',
    // sga-autopilot.mjs: kim の場合は deliverKim へ委譲（inbox 保存）。
    'sga-autopilot.mjs',
    // gate-runtime.mjs: notifyKim を呼ぶ（inbox 保存）。
    'gate-runtime.mjs',
    // autopilot-tick.mjs: notifyKim/deliverKim を経由。
    'autopilot-tick.mjs',
    // autopilot-local-notice.mjs: ID解決のみ。実際の送信は呼出元。
    'autopilot-local-notice.mjs',
    // event-shop-reply-context.mjs: 読取り専用。
    'event-shop-reply-context.mjs',
    // feedback-nag.mjs: routeOwnerDm 経由で deliverKim へ委譲。
    'feedback-nag.mjs',
    // owner-dm-policy.mjs: kim の場合は deliverKim へ委譲。
    'owner-dm-policy.mjs',
    // notify-owner.mjs: notifyKim 経由で inbox 保存。
    'notify-owner.mjs',
  ]);
  for (const file of walk(toolsDir)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('KIM_DISCORD_USER_ID') || !(source.includes('/users/@me/channels') || source.includes('webhook'))) continue;
    // kim-push-relay.mjs は read-only チャンネル取得 — KIM_DISCORD_USER_ID を送信先にしない
    if (source.includes('messages?after=') || source.includes('/messages?')) continue;
    const name = decodeURIComponent(file.href.slice(toolsDir.href.length));
    // 安全リストに無いファイルは違反
    assert.ok(auditedSafe.has(name), `未監査のファイルで KIM_DISCORD_USER_ID と Discord API を併用: ${name}`);
    // 内容が kim 以外用であることを確認（deliverKim/notifyKim 経由のため実際の DM は行われない）
    assert.ok(
      source.includes('discord-dm.mjs') || source.includes('notifyKim') || source.includes('deliverKim')
        || source.includes('routeOwnerDm') || source.includes('readControls') || source.includes('channels.push'),
      `${name}: kim 以外用のガードが見つかりません`
    );
  }
});

// 4. config/kim-discord-allowlist.json の entries が空
test('config/kim-discord-allowlist.json の entries は空', () => {
  const { entries } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/kim-discord-allowlist.json')));
  assert.ok(Array.isArray(entries) && entries.length === 0, `entries が空ではありません: ${JSON.stringify(entries)}`);
});

// 5. loadAllowlist が常に空配列を返す
test('loadAllowlist は常に空配列', async () => {
  const { loadAllowlist } = await import('./lib/kim-discord-allowlist.mjs');
  assert.deepEqual(loadAllowlist(), []);
  assert.deepEqual(loadAllowlist({ repoRoot, home: os.homedir() }), []);
});