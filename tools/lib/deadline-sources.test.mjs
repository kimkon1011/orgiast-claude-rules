import assert from 'node:assert/strict';
import test from 'node:test';
import { searchGmail } from '../gmail-search.mjs';
import { collectGmail } from './deadline-sources.mjs';

test('Gmail中断後は未取得IDから再開し、次のページを終えてwatermarkを進める', async () => {
  const now = new Date('2026-11-22T00:00:00Z');
  const watermark = '2026-11-12T15:00:00Z';
  const user = 'kim@orgiast.jp';
  const controller = new AbortController();
  const requests = [];
  const search = opts => searchGmail({
    ...opts,
    concurrency: 1,
    getToken: async () => 'mock-token',
    fetchImpl: async rawUrl => {
      const url = new URL(rawUrl);
      const id = url.pathname.split('/').at(-1);
      requests.push([id, url.searchParams.get('format') || url.searchParams.get('pageToken')]);
      if (id === 'messages') return Response.json(url.searchParams.has('pageToken')
        ? { messages: [{ id: 'last' }] }
        : { messages: [{ id: 'ok' }, { id: 'waiting' }], nextPageToken: 'page-2' });
      if (id === 'waiting' && opts.signal) {
        controller.abort(new Error('source timeout'));
        return new Promise(() => {});
      }
      return Response.json({ id, internalDate: String(now.getTime()), payload: {
        headers: [{ name: 'Subject', value: '提出期限' }], mimeType: 'text/plain',
        body: { data: Buffer.from('11/23まで').toString('base64url') },
      } });
    },
  });

  const first = await collectGmail({ user, now, state: { watermark }, search, signal: controller.signal });
  assert.deepEqual(first.documents.map(d => d.sourceRef), [`gmail:${user}:ok`]);
  assert.equal(first.next.watermark, watermark);
  assert.deepEqual(first.next.pendingIds, ['waiting']);
  assert.equal(first.next.resumeNext, 'page-2');
  assert.equal(first.partial.remaining, 1);

  requests.length = 0;
  const second = await collectGmail({ user, now, state: first.next, search });
  assert.deepEqual(requests, [
    ['waiting', 'metadata'], ['waiting', 'full'], ['messages', 'page-2'],
    ['last', 'metadata'], ['last', 'full'],
  ]);
  assert.deepEqual(second.documents.map(d => d.sourceRef), [`gmail:${user}:waiting`, `gmail:${user}:last`]);
  assert.equal(second.next.watermark, now.toISOString());
  assert.equal(second.next.used, 3);
  assert.equal(second.next.pendingIds, undefined);
});
