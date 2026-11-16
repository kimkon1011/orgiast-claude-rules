#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const gatewayDir = path.join(process.env.ORGIAST_HOME || os.homedir(), 'Downloads', 'claude-mobile');
const require = createRequire(path.join(gatewayDir, 'package.json'));
const { loadEnvConfig } = require('@next/env');
const { combinedEnv } = loadEnvConfig(gatewayDir, false, { info() {}, error() {} });
const token = combinedEnv.ACCESS_TOKEN;
assert.ok(token && token !== 'change-me-to-a-long-random-string', 'Gateway credential is not configured');
const base = 'https://claude-pc.tailc5d751.ts.net';
const request = (endpoint, authenticated = false) => fetch(`${base}${endpoint}`, {
  signal: AbortSignal.timeout(60000), redirect: 'manual',
  headers: authenticated ? { authorization: `Bearer ${token}` } : {},
});
const page = await request('/secretary');
await page.arrayBuffer();
assert.equal(page.status, 200, 'External page is not healthy');
const unauthenticated = await request('/secretary/api/watches');
await unauthenticated.arrayBuffer();
assert.equal(unauthenticated.status, 401, 'Private progress API must require gateway authentication');
const response = await request('/secretary/api/watches', true);
assert.equal(response.status, 200, 'Authenticated external progress API failed');
const data = await response.json();
assert.deepEqual(data.warnings, [], 'Progress data has read errors');
const label = process.argv[2];
const matches = [...data.watches, ...data.recentCompleted].filter(item => !label || item.label.includes(label));
assert.ok(matches.length > 0, 'Requested watch label is missing');
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), externalStatus: page.status, apiStatus: response.status,
  unauthenticatedStatus: unauthenticated.status, totalWatches: data.totalWatches, totalAsks: data.totalAsks,
  matches: matches.map(({ label, status, verdict, deadline, lastCheck }) => ({ label, status, verdict, deadline, lastCheck })) }, null, 2));
