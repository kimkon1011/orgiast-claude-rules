import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const syncScript = path.join(repoPath, 'tools', 'onboarding-sync.mjs');

test('keyserve 401 を実経路で Discord webhook へ通報し24時間抑止する', { timeout: 10_000 }, async () => {
  const requests = { keys: [], hooks: [] };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const received = {
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      if (request.url === '/keys') {
        requests.keys.push(received);
        response.writeHead(401).end('unauthorized');
      } else if (request.url === '/hook') {
        requests.hooks.push(received);
        response.writeHead(204).end();
      } else if (request.url === '/onboarding') {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('dummy');
      } else {
        response.writeHead(404).end();
      }
    });
  });
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-alert-e2e-'));

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const webhookUrl = `${baseUrl}/hook`;
    const secret = 'E2E-KEYSERVE-SECRET';
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'cost-reporter.env'),
      `DISCORD_COST_WEBHOOK=${webhookUrl}\nREPORTER_LABEL=E2E-TEST-PC\n`,
      'utf8',
    );

    const args = [syncScript, '--force', `--target=${path.join(tempHome, 'CLAUDE.md')}`];
    const env = {
      ...process.env,
      ORGIAST_HOME: tempHome,
      ORGIAST_REPO: repoPath,
      ORGIAST_KEYSERVE_URL: `${baseUrl}/keys`,
      ORGIAST_ONBOARDING_URL: `${baseUrl}/onboarding`,
      ORGIAST_KEYSERVE_SECRET: secret,
    };
    const runSync = () => execFileAsync(process.execPath, args, { env, timeout: 4_000 });

    await runSync();
    assert.equal(requests.keys.length, 1);
    assert.equal(requests.keys[0].method, 'POST');
    assert.equal(requests.hooks.length, 1);
    assert.equal(requests.hooks[0].method, 'POST');
    assert.ok(requests.hooks[0].headers['user-agent']);

    const payload = JSON.parse(requests.hooks[0].body);
    assert.equal(typeof payload.content, 'string');
    assert.match(payload.content, /E2E-TEST-PC/);
    assert.match(payload.content, /401/);
    assert.match(payload.content, /onboarding-sync\.mjs --force/);
    assert.ok(!payload.content.includes(webhookUrl));
    assert.ok(!payload.content.includes(secret));
    assert.ok(!payload.content.includes('ORGIAST_KEYSERVE_SECRET'));

    await runSync();
    assert.equal(requests.keys.length, 2);
    assert.equal(requests.hooks.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
