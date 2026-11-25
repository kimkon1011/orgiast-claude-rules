#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const gatewayDir = path.join(process.env.ORGIAST_HOME || os.homedir(), 'Downloads', 'claude-mobile');
const require = createRequire(path.join(gatewayDir, 'package.json'));
const { loadEnvConfig } = require('@next/env');
const { combinedEnv } = loadEnvConfig(gatewayDir, false, { info() {}, error() {} });
const token = combinedEnv.ACCESS_TOKEN;
assert.ok(token && token !== 'change-me-to-a-long-random-string', 'Gateway credential is not configured');
const base = 'https://claude-pc.tailc5d751.ts.net';
const request = async (endpoint, authenticated = false) => {
  const started = performance.now();
  const response = await fetch(`${base}${endpoint}`, {
    signal: AbortSignal.timeout(10000), redirect: 'manual',
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
  });
  const body = await response.text();
  return { status: response.status, elapsedMs: Math.round(performance.now() - started), body };
};
const page = await request('/secretary');
assert.equal(page.status, 200, 'External page is not healthy');
const unauthenticated = await request('/secretary/api/watches');
assert.equal(unauthenticated.status, 401, 'Private progress API must require gateway authentication');
const readList = async () => {
  const response = await request('/secretary/api/watches', true);
  assert.equal(response.status, 200, 'Authenticated external progress API failed');
  assert.ok(response.elapsedMs < 5000, `Authenticated list took ${response.elapsedMs}ms (target <5000ms)`);
  return { response, data: JSON.parse(response.body) };
};
let { response, data } = await readList();
const attemptsMs = [response.elapsedMs];
// The API can return a loading state on a cold start while the ledger read continues.
const deadline = performance.now() + 15000;
while (!data.ledgerUpdatedAt && data.ledgerStatus === 'refreshing' && performance.now() < deadline) {
  await delay(1000);
  ({ response, data } = await readList());
  attemptsMs.push(response.elapsedMs);
}
assert.ok(data.ledgerUpdatedAt, 'Ledger has not loaded yet');
assert.deepEqual(data.warnings, [], 'Progress data has read errors');
const label = process.argv[2];
const matches = [...data.watches, ...data.recentCompleted].filter(item => !label || item.label.includes(label));
assert.ok(matches.length > 0, 'Requested watch label is missing');
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), externalStatus: page.status, apiStatus: response.status, apiElapsedMs: response.elapsedMs, attemptsMs, pageElapsedMs: page.elapsedMs, inboxStatus: data.inboxStatus,
  unauthenticatedStatus: unauthenticated.status, totalWatches: data.totalWatches, totalAsks: data.totalAsks,
  matches: matches.map(({ label, status, verdict, deadline, lastCheck }) => ({ label, status, verdict, deadline, lastCheck })) }, null, 2));
