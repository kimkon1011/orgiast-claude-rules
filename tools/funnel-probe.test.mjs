#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { DNS_QUERY_TIMEOUT_MS, DNS_TOTAL_TIMEOUT_MS, probeDns, trimLines, verdictOf } from './funnel-probe.mjs';

test('verdictOf は外部 HTTPS に到達できれば ok を返す', () => {
  assert.equal(verdictOf({ dns: { ok: true }, https: { ok: true }, local: { ok: true } }), 'ok');
});

test('verdictOf は DNS が引けなければ dns-missing を返す', () => {
  assert.equal(verdictOf({ dns: { ok: false }, https: { ok: false }, local: { ok: true } }), 'dns-missing');
});

test('verdictOf は DNS 成功かつ HTTPS 失敗なら https-unreachable を返す', () => {
  assert.equal(verdictOf({ dns: { ok: true }, https: { ok: false }, local: { ok: true } }), 'https-unreachable');
});

test('verdictOf はローカル停止なら local-down を返す', () => {
  assert.equal(verdictOf({ dns: { ok: true }, https: { ok: true }, local: { ok: false } }), 'local-down');
});

test('local-down は dns-missing より優先される', () => {
  assert.equal(verdictOf({ dns: { ok: false }, https: { ok: false }, local: { ok: false } }), 'local-down');
});

test('trimLines は上限以下の配列をそのまま返す', () => {
  const lines = ['a', 'b'];
  assert.equal(trimLines(lines, 2), lines);
  assert.deepEqual(trimLines(lines, 3), ['a', 'b']);
});

test('trimLines は上限超過時に末尾だけを残す', () => {
  assert.deepEqual(trimLines(['a', 'b', 'c', 'd'], 2), ['c', 'd']);
});

// 回帰: resolve4 と resolve6 を同一の Resolver インスタンスで並行実行すると、
// 応答があるのに片方が c-ares 側で ETIMEOUT になる(2026-09-02 実測: 同一で並行だと
// v4 が 5050ms で ETIMEOUT、別インスタンスなら両方 30ms で成功)。これを踏むと
// 本当は健全なのに毎時 dns-missing を出し続ける常時赤の計測になる。
test('probeDns: resolve4/resolve6 で Resolver を共有しない', async () => {
  const created = [];
  const createResolver = () => {
    const resolver = {
      resolve4: async () => { assert.equal(resolver.used, undefined, 'Resolver を使い回している'); resolver.used = 'resolve4'; return ['203.0.113.1']; },
      resolve6: async () => { assert.equal(resolver.used, undefined, 'Resolver を使い回している'); resolver.used = 'resolve6'; return ['2001:db8::1']; },
    };
    created.push(resolver);
    return resolver;
  };
  const result = await probeDns('example.test', '8.8.8.8', { createResolver });
  assert.equal(created.length, 2, 'resolve4/resolve6 それぞれに Resolver を作ること');
  assert.notEqual(created[0], created[1]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.a, ['203.0.113.1']);
  assert.deepEqual(result.aaaa, ['2001:db8::1']);
});

test('probeDns: 片方だけ失敗してももう片方が取れていれば ok', async () => {
  const createResolver = () => ({
    resolve4: async () => { throw Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' }); },
    resolve6: async () => ['2001:db8::1'],
  });
  const result = await probeDns('example.test', '8.8.8.8', { createResolver });
  assert.equal(result.ok, true);
  assert.deepEqual(result.a, []);
  assert.deepEqual(result.aaaa, ['2001:db8::1']);
});

test('probeDns: 両方失敗したら ok=false と理由が残る', async () => {
  const createResolver = () => ({
    resolve4: async () => { throw new Error('v4 boom'); },
    resolve6: async () => { throw new Error('v6 boom'); },
  });
  const result = await probeDns('example.test', '8.8.8.8', { createResolver });
  assert.equal(result.ok, false);
  assert.match(result.error, /v4 boom/);
  assert.match(result.error, /v6 boom/);
});

test('DNS の全体タイムアウトは個別より長い（成功した側を巻き添えにしない）', () => {
  assert.ok(DNS_TOTAL_TIMEOUT_MS > DNS_QUERY_TIMEOUT_MS, '全体 > 個別 でなければ成功した側まで落ちる');
});
