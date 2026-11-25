import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPagesHtml, countPages, extractCard } from './brandcard-print-pdf.mjs';

const FIXTURE = `<!doctype html><html><head>
<style>:root{--card:#fff}.card{color:#111}@media print{.card{page-break-after:always}}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
</head><body>
<!-- 1. STORY --><div class="label">one</div><div class="card c1"><div><div>nested</div></div><p>one</p></div>
<!-- 2. CARE --><div class="label">two</div><div class="card c2"><p>two</p></div>
<!-- 3. REORDER --><div class="label">three</div><div class="card c3"><div class="qrwrap"><div id="qr"><div>placeholder</div></div><p class="qcap">scan</p><p class="qurl" id="qurl"></p></div></div>
<!-- 4. THANK YOU --><div class="label">four</div><div class="card c4"><p>four</p></div>
<script>var ORDER_URL="https://example.test";document.getElementById('qurl').textContent=ORDER_URL;</script>
</body></html>`;

test('A版は154×106mmの2ページにc1、c2だけを配置する', () => {
  const html = buildPagesHtml(FIXTURE, { cards: [1, 2] });
  // Chrome は @page の寸法を 1/75in グリッドに丸めるため、106mm を渡すと
  // PDF の高さが 105.833mm になり塗り足しが 3mm を下回る。106.2mm で 106.172mm になる。
  assert.match(html, /size:154mm 106\.2mm/u);
  assert.match(html, /class="card c1"/u);
  assert.match(html, /class="card c2"/u);
  assert.doesNotMatch(html, /class="card c3"/u);
  assert.doesNotMatch(html, /class="card c4"/u);
  assert.equal(html.match(/class="sheet"/gu)?.length, 2);
});

test('B版は指定順のc4、c3だけを配置しQRを残す', () => {
  const html = buildPagesHtml(FIXTURE, { cards: [4, 3] });
  assert.ok(html.indexOf('class="card c4"') < html.indexOf('class="card c3"'));
  assert.doesNotMatch(html, /class="card c1"/u);
  assert.doesNotMatch(html, /class="card c2"/u);
  assert.match(html, /id="qr"/u);
  assert.equal(html.match(/class="sheet"/gu)?.length, 2);
});

test('メール版はQR一式を注文メール文言に置換する', () => {
  const html = buildPagesHtml(FIXTURE, { cards: [4, 3], dropQr: true });
  assert.doesNotMatch(html, /id="qr"/u);
  assert.doesNotMatch(html, /\bORDER_URL\b/u);
  assert.match(html, /seisaku-team@orgiast\.jp/u);
});

test('extractCardは入れ子divを含むカードの外側まで正しく切り出す', () => {
  assert.equal(extractCard(FIXTURE, 1), '<div class="card c1"><div><div>nested</div></div><p>one</p></div>');
});

test('QR JavaScriptを指定すると外部参照でなくinline化する', () => {
  const html = buildPagesHtml(FIXTURE, { cards: [4, 3], qrInlineJs: 'window.QRCode=function(){};' });
  assert.match(html, /window\.QRCode=function/u);
  assert.doesNotMatch(html, /<script[^>]+src=[^>]+qrcode/iu);
});

test('countPagesはPages辞書を除いてPage辞書だけを数える', () => {
  assert.equal(countPages(Buffer.from('%PDF /Type /Pages /Type /Page /Type\n/Page', 'latin1')), 2);
});
