import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import test from 'node:test';

import { run } from './pipeline.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function stubs(calls) {
  return {
    fetchSite: async (url) => { calls.fetch.push(url); return `text:${url}`; },
    extract: async (text) => { calls.extract.push(text); return { sells: '架空製品', buyer: '架空顧客', reason: '架空課題' }; },
  };
}

test('C6: end-to-end各段の件数、除外理由、古い投稿の除外を満たす', async () => {
  const calls = { fetch: [], extract: [] };
  const result = await run(await fixture('pipeline-input.json'), stubs(calls));
  assert.deepEqual(result.summary, { normalized: 4, kept: 3, excluded: 1, contactsKept: 3, fresh: 2, analyzed: 2, drafts: 2 });
  assert.equal(result.excluded[0].company.name, 'Paper Harbor Media');
  assert.equal(result.excluded[0].reason, 'media');
  assert.deepEqual(result.drafts.map(({ contact }) => contact), ['Ada Fiction', 'Chika Fiction']);
  assert.ok(!result.drafts.some(({ contact }) => contact === 'Ben Fiction'));
  assert.equal(calls.fetch.length, 2);
  assert.equal(calls.extract.length, 2);
});

test('C6: ホールドアウトを仕様から導いた期待値で処理する', async () => {
  const calls = { fetch: [], extract: [] };
  const result = await run(await fixture('pipeline-holdout.json'), stubs(calls));
  assert.deepEqual(result.summary, { normalized: 3, kept: 2, excluded: 1, contactsKept: 2, fresh: 2, analyzed: 2, drafts: 2 });
  assert.deepEqual(result.drafts.map(({ company, contact, title }) => ({ company, contact, title })), [
    { company: 'Velvet Orbit', contact: 'Eva Example', title: '営業ディレクター' },
    { company: 'Ivory Current', contact: 'Finn Example', title: '創業者' },
  ]);
  assert.deepEqual(calls.fetch, ['https://velvet-orbit.invalid']);
  assert.equal(calls.extract.length, 1);
});

test('C6: 外部呼び出しは注入depsのみを使う', async () => {
  const input = await fixture('pipeline-input.json');
  const calls = { fetch: [], extract: [] };
  const originalFetch = globalThis.fetch;
  const guarded = [
    [http, 'request'], [http, 'get'],
    [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'],
  ];
  const originals = guarded.map(([module, method]) => [module, method, module[method]]);
  const rejectNetwork = () => { throw new Error('node network modules must not be called'); };
  globalThis.fetch = async () => { throw new Error('global fetch must not be called'); };
  for (const [module, method] of guarded) module[method] = rejectNetwork;
  try {
    await run(input, stubs(calls));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [module, method, original] of originals) module[method] = original;
  }
  assert.deepEqual(calls.fetch, ['https://amber-kite.invalid', 'https://moss-lantern.invalid']);
  assert.equal(calls.extract.length, 2);
});

test('C6: referenceDate省略はthrowする', async () => {
  const input = await fixture('pipeline-input.json');
  delete input.referenceDate;
  await assert.rejects(run(input, stubs({ fetch: [], extract: [] })), /referenceDate/);
});
