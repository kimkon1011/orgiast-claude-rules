import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchExhibitors } from './map-your-show.mjs';

function response(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' },
  });
}

function hit(id, overrides = {}) {
  return { fields: { exhid_l: id, exhname_t: `Company ${id}`, exhdesc_t: '<p>Industrial <b>machines</b></p>', boothsdisplay_la: ['LL-9003randomstring'], ...overrides } };
}

function mockFetch(pages, details = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: String(url), options });
    if (parsed.pathname.endsWith('remote-proxy.cfm')) {
      const offset = Number(parsed.searchParams.get('start'));
      const value = pages[offset];
      if (value instanceof Error) throw value;
      return response(value, value?.status ?? 200);
    }
    const id = parsed.searchParams.get('exhid');
    const value = details[id] ?? 'var data = { websiteValue: "https:\\/\\/example.com" };';
    if (value instanceof Error) throw value;
    return response(value.body ?? value, value.status ?? 200);
  };
  return { fetch, calls };
}

test('validates showSlug', async () => {
  await assert.rejects(fetchExhibitors(''), TypeError);
  await assert.rejects(fetchExhibitors(42), TypeError);
});

test('paginates at searchSize and stops after the final short page', async () => {
  const first = Array.from({ length: 100 }, (_, index) => hit(String(index)));
  const second = Array.from({ length: 50 }, (_, index) => hit(String(index + 100)));
  const mock = mockFetch({
    0: { SUCCESS: true, DATA: { totalhits: 150, results: { exhibitor: { hit: first } } } },
    100: { SUCCESS: true, DATA: { totalhits: 150, results: { exhibitor: { hit: second } } } },
  });
  const result = await fetchExhibitors('packexpo26', { delayMs: 0, fetch: mock.fetch });
  const searches = mock.calls.filter(call => call.url.includes('remote-proxy.cfm'));
  assert.equal(result.total, 150);
  assert.equal(result.rows.length, 150);
  assert.deepEqual(searches.map(call => new URL(call.url).searchParams.get('start')), ['0', '100']);
  assert.equal(searches[0].options.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('stops when a page has fewer hits than searchSize even if reported total is larger', async () => {
  const mock = mockFetch({ 0: { SUCCESS: true, DATA: { totalhits: 999, results: { exhibitor: { hit: [hit('1')] } } } } });
  const result = await fetchExhibitors('packexpo26', { searchSize: 100, delayMs: 0, fetch: mock.fetch });
  assert.equal(result.pages.length, 1);
});

test('normalizes booth and description and extracts escaped website', async () => {
  const mock = mockFetch(
    { 0: { SUCCESS: true, DATA: { totalhits: 1, results: { exhibitor: { hit: [hit('7')] } } } } },
    { 7: '<script>const exhibitor = { websiteValue: "https:\\/\\/acme.example\\/products" };</script>' },
  );
  const result = await fetchExhibitors('packexpo26', { delayMs: 0, fetch: mock.fetch });
  assert.equal(result.rows[0].booth, 'LL-9003');
  assert.equal(result.rows[0].description, 'Industrial machines');
  assert.equal(result.rows[0].website, 'https://acme.example/products');
});

test('records a failed page and continues to a later page', async () => {
  const mock = mockFetch({
    0: { SUCCESS: true, DATA: { totalhits: 3, results: { exhibitor: { hit: [hit('1')] } } } },
    1: new Error('page unavailable'),
    2: { SUCCESS: true, DATA: { totalhits: 3, results: { exhibitor: { hit: [hit('3')] } } } },
  });
  const result = await fetchExhibitors('packexpo26', { searchSize: 1, delayMs: 0, fetch: mock.fetch });
  assert.equal(result.pages[1].error, 'page unavailable');
  assert.deepEqual(result.rows.map(row => row.id), ['1', '3']);
});

test('uses an empty website when detail fetch fails', async () => {
  const mock = mockFetch(
    { 0: { SUCCESS: true, DATA: { totalhits: 1, results: { exhibitor: { hit: [hit('1')] } } } } },
    { 1: { body: 'unavailable', status: 503 } },
  );
  const result = await fetchExhibitors('packexpo26', { delayMs: 0, fetch: mock.fetch });
  assert.equal(result.rows[0].website, '');
});
