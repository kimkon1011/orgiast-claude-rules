import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluatePure, main, maskSecret, matrixReport, parseAttributes, parseHtml, scanSecrets } from './site-prelaunch-check.mjs';

const base = 'https://example.com/';
const goodHtml = `<!doctype html><html><head>
<title>公開前チェックに合格する十分な長さのサイトタイトル</title>
<meta name="description" content="これは公開前チェック用の説明文です。検索結果で内容が十分伝わるように、五十文字以上かつ百六十文字以内になる文章を記載しています。">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="OGタイトル"><meta property="og:description" content="OG説明">
<meta property="og:image" content="https://example.com/og.webp"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icon.ico"><script>gtag('config','G-ABC123'); Sentry.init({});</script></head>
<body><div class="cookie-consent">Cookieを許可</div><a href="/privacy">プライバシーポリシー</a>
<a href="/terms">利用規約</a><a class="cta" href="/contact">連絡する</a><img src="/a.webp" alt="説明">
<form><input type="email" required><input type="hidden" name="website"></form><button>送信</button></body></html>`;

function resources() {
  return Object.fromEntries(['/privacy', '/terms', '/og.webp', '/icon.ico', '/favicon.ico', '/robots.txt', '/sitemap.xml'].map((p) => [`https://example.com${p}`, { status: 200, body: p === '/robots.txt' ? 'Sitemap: https://example.com/sitemap.xml' : '' }]));
}

const goodInput = {
  url: base, html: goodHtml, headers: {
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin', 'strict-transport-security': 'max-age=31536000',
  }, resources: resources(), httpCheck: { ok: true, finalUrl: base }, imageChecks: [{ url: 'https://example.com/a.webp', bytes: 1000, type: 'image/webp' }],
  notFound: { status: 404, body: '<h1>ページがありません</h1>' }, linkChecks: [{ url: 'https://example.com/privacy', status: 200 }],
  psi: { performance: 0.9, colorContrast: true }, ttfbMs: 100,
  repo: { secretFindings: [], errorMonitoring: true, dbTypes: [], rateLimit: true, authPresent: false },
};

test('軽量HTMLパーサーが属性・主要要素を取得する', () => {
  assert.deepEqual(parseAttributes(' class="cta" disabled data-x=1'), { class: 'cta', disabled: '', 'data-x': '1' });
  const parsed = parseHtml(goodHtml, base); assert.equal(parsed.images.length, 1); assert.equal(parsed.forms.length, 1); assert.equal(parsed.getMeta('og:title'), 'OGタイトル');
});

test('秘密値を先頭4文字と長さだけにマスクする', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnopqrstuvwxyz'), 'sk-a…（29文字）');
  const findings = scanSecrets('token=ghp_abcdefghijklmnopqrstuvwxyzABCDE');
  assert.equal(findings[0].severity, 'NG'); assert.doesNotMatch(findings[0].masked, /efghijkl/);
});

test('25項目すべてにOK・対象外・要手動の正常系判定がある', () => {
  const checks = evaluatePure(goodInput); assert.equal(checks.length, 25);
  assert.deepEqual(checks.map((c) => c.id), Array.from({ length: 25 }, (_, i) => i + 1));
  for (const check of checks) assert.ok(['OK', '対象外', '要手動'].includes(check.verdict), `${check.id}: ${check.verdict} ${check.evidence}`);
  assert.equal(checks[0].verdict, 'OK'); assert.equal(checks[4].verdict, 'OK'); assert.equal(checks[11].verdict, 'OK');
  assert.equal(checks[19].verdict, '要手動'); assert.equal(checks[20].verdict, '要手動'); assert.equal(checks[22].verdict, '対象外'); assert.equal(checks[24].verdict, '対象外');
});

test('25項目それぞれのNGまたは対象外・要手動ケースを判定する', () => {
  const bad = evaluatePure({ url: base, html: '<html><head><title>x</title></head><body><img src="x"><form><input></form></body></html>', headers: {}, resources: {}, imageChecks: [{ url: `${base}x`, bytes: 400000 }], notFound: { status: 200, body: 'spa' }, linkChecks: [{ url: `${base}bad`, status: 500 }], repo: { secretFindings: [{ type: 'OpenAI形式キー', masked: 'sk-a…（30文字）', severity: 'NG' }], dbTypes: ['prisma'], authPresent: true } });
  assert.equal(bad.length, 25);
  const expected = ['NG','NG','NG','NG','対象外','NG','NG','NG','NG','NG','NG','要手動','要手動','NG','NG','NG','NG','NG','NG','要手動','要手動','NG','要手動','NG','要手動'];
  assert.deepEqual(bad.map((c) => c.verdict), expected);
  for (const check of bad) assert.ok(check.evidence.length > 0, `項目${check.id}の根拠が空`);
});

test('Googleブラウザキーだけなら要手動、service_role JWTはNG', () => {
  const google = evaluatePure({ ...goodInput, secretFindings: scanSecrets(`AIza${'A'.repeat(35)}`) });
  assert.equal(google[2].verdict, '要手動');
  const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  const jwt = evaluatePure({ ...goodInput, secretFindings: scanSecrets(`aaaa.${payload}.bbbb`) });
  assert.equal(jwt[2].verdict, 'NG'); assert.doesNotMatch(jwt[2].evidence, new RegExp(payload));
});

test('全面Disallowと既定404を根拠・NGに反映する', () => {
  const input = structuredClone(goodInput); input.resources['https://example.com/robots.txt'].body = 'User-agent: *\nDisallow: /\nSitemap: https://example.com/sitemap.xml'; input.notFound.body = '404: NOT_FOUND';
  const checks = evaluatePure(input); assert.match(checks[8].evidence, /全面ブロック/); assert.equal(checks[14].verdict, 'NG');
});

test('matrix は25項目の記号とNG件数・番号を整形する', () => {
  const checks = evaluatePure(goodInput);
  checks[0] = { ...checks[0], verdict: 'NG' };
  checks[1] = { ...checks[1], verdict: '対象外' };
  const output = matrixReport([{ url: base, checks }]);
  const lines = output.split('\n');
  assert.match(lines[0], /^\| サイト \| 1 \| 2 .+ \| 25 \| NG \|$/);
  assert.match(lines[2], /^\| https:\/\/example\.com\/ \| × \| － \|/);
  assert.match(lines[2], /\| 1（1） \|$/);
});

test('--from-json はネットワークなしで保存済み配列からMarkdownを出力する', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'site-prelaunch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'reports.json');
  const output = path.join(dir, 'matrix.md');
  await writeFile(input, JSON.stringify([{ url: base, checks: evaluatePure(goodInput) }]), 'utf8');
  const code = await main(['--from-json', input, '--matrix', '--out', output]);
  assert.equal(code, 0);
  assert.match(await readFile(output, 'utf8'), /^\| サイト \| 1 \|/);
});
