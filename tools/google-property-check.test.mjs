import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

/** JWT 自己署名を通すための使い捨て RSA 鍵（ネットワークには出ない）。 */
const FAKE_KEY = {
  client_email: 'sa@example.com',
  private_key: generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
};

import {
  parseArgs,
  runCheck,
  renderHuman,
  sortItems,
  CHECKS,
  DEFAULT_SUBJECT,
} from './google-property-check.mjs';

test('sortItems: API の返却順に依存せず決定的に並ぶ（実測で SC は毎回シャッフルされる）', () => {
  const a = [
    { title: 'https://b.example/', detail: 'permission=siteOwner', children: [] },
    { title: 'https://a.example/', detail: 'permission=siteOwner', children: [] },
    { title: 'https://a.example/', detail: 'permission=siteFullUser', children: [] },
  ];
  const b = [a[2], a[0], a[1]]; // 同じ集合を別順で
  assert.deepEqual(sortItems(a), sortItems(b));
  assert.deepEqual(
    sortItems(a).map((x) => `${x.title} ${x.detail}`),
    [
      'https://a.example/ permission=siteFullUser',
      'https://a.example/ permission=siteOwner',
      'https://b.example/ permission=siteOwner',
    ],
  );
});

test('sortItems: children も並べ替え、元配列を破壊しない', () => {
  const src = [
    {
      title: 'acct',
      detail: '',
      children: [
        { title: 'z', detail: '' },
        { title: 'a', detail: '' },
      ],
    },
  ];
  const out = sortItems(src);
  assert.deepEqual(
    out[0].children.map((c) => c.title),
    ['a', 'z'],
  );
  assert.deepEqual(
    src[0].children.map((c) => c.title),
    ['z', 'a'],
  );
});

test('parseArgs: flags と値オプションを分離する', () => {
  const a = parseArgs(['--json', '--subject', 'x@y.z', '--key', '/k.json']);
  assert.equal(a.flags.has('json'), true);
  assert.equal(a.subject, 'x@y.z');
  assert.equal(a.key, '/k.json');
});

test('parseArgs: --help / -h を拾う', () => {
  assert.equal(parseArgs(['--help']).flags.has('help'), true);
  assert.equal(parseArgs(['-h']).flags.has('h'), true);
});

test('CHECKS: 3 API を対象にし、すべて読み取り専用スコープを使う', () => {
  assert.deepEqual(
    CHECKS.map((c) => c.id),
    ['ga4', 'searchconsole', 'gtm'],
  );
  for (const c of CHECKS) {
    assert.match(c.scope, /^https:\/\/www\.googleapis\.com\/auth\//);
    assert.match(c.url, /^https:\/\//);
    assert.ok(typeof c.pageKey === 'string' && c.pageKey.length > 0);
  }
});

test('既定の代理ユーザーは kim@orgiast.jp', () => {
  assert.equal(DEFAULT_SUBJECT, 'kim@orgiast.jp');
});

test('runCheck: DWD 未委任(token 交換失敗)を scope_not_delegated に分類する', async () => {
  // Google が DWD スコープ未登録時に返す実応答（tagmanager で実測したものと同じ形）
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: 'unauthorized_client',
        error_description:
          'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.',
      }),
      { status: 401 },
    );
  try {
    const r = await runCheck(CHECKS[0], { key: FAKE_KEY, subject: 'kim@orgiast.jp' });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'scope_not_delegated');
    assert.equal(r.auth, 'failed');
    assert.equal(r.id, 'ga4');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runCheck: 成功時は items と count を返す', async () => {
  // ネットワークに出ないよう fetch を差し替える
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push(String(url));
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ siteEntry: [{ siteUrl: 'https://a.example/', permissionLevel: 'siteOwner' }] }),
      { status: 200 },
    );
  };
  try {
    const sc = CHECKS.find((c) => c.id === 'searchconsole');
    const r = await runCheck(sc, { key: FAKE_KEY, subject: 'kim@orgiast.jp' });
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
    assert.equal(r.items[0].title, 'https://a.example/');
    assert.equal(r.items[0].detail, 'permission=siteOwner');
    assert.equal(calls.length, 2); // token + api
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runCheck: API 403 を forbidden_no_access に分類する', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 403 });
  };
  try {
    const r = await runCheck(CHECKS[0], { key: FAKE_KEY, subject: 'kim@orgiast.jp' });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'forbidden_no_access');
    assert.equal(r.auth, 'ok'); // token は取れた = DWD 自体は正常
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('renderHuman: 件数と未確認の理由を人が読める形で出す', () => {
  const out = renderHuman({
    subject: 'kim@orgiast.jp',
    sa: 'sa@example.com',
    checkedAt: '2026-09-17T00:00:00.000Z',
    results: [
      { id: 'ga4', label: 'GA4', scope: 's', ok: true, count: 1, items: [{ title: 'A', detail: 'd', children: [] }] },
      {
        id: 'gtm',
        label: 'GTM',
        scope: 's2',
        ok: false,
        errorKind: 'scope_not_delegated',
        error: 'Client is unauthorized',
      },
    ],
  });
  assert.match(out, /\[OK \] GA4/);
  assert.match(out, /件数: 1/);
  assert.match(out, /- A {2}\(d\)/);
  assert.match(out, /\[NG \] GTM/);
  assert.match(out, /scope_not_delegated/);
  assert.match(out, /DWD にこのスコープが未登録/);
});
