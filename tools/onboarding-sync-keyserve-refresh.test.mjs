import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'onboarding-sync.mjs');
const secret = 'test-keyserve-secret';
const onboarding = '# Test onboarding\n\nLocal test content.\n';

function runSync(home, keyserveUrl, onboardingUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--force'], {
      env: {
        ...process.env,
        ORGIAST_HOME: home,
        ORGIAST_KEYSERVE_URL: keyserveUrl,
        ORGIAST_ONBOARDING_URL: onboardingUrl,
        ORGIAST_KEYSERVE_SECRET: secret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('provisionKeys refreshes only changed keyserve.env through the real process path', async (t) => {
  const payloads = new Map([
    ['/keys/create', { 'keyserve.env': '\uFEFFORGIAST_KEYSERVE_SECRET=new-secret\n' }],
    ['/keys/refresh', { 'keyserve.env': '\uFEFFORGIAST_KEYSERVE_SECRET=new-secret\n' }],
    ['/keys/same', { 'keyserve.env': 'ORGIAST_KEYSERVE_SECRET=same-secret\n' }],
    ['/keys/other', { 'provider.env': 'PROVIDER_KEY=new-value\n' }],
    ['/keys/central', { 'cost-reporter.env': '\uFEFFDISCORD_COST_WEBHOOK=https://example.invalid/new-hook\nREPORTER_LABEL=central-label\n' }],
  ]);
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/onboarding') {
      response.writeHead(200, { 'content-type': 'text/markdown' });
      response.end(onboarding);
      return;
    }
    if (request.method === 'POST' && payloads.has(request.url)) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ files: payloads.get(request.url) }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  await t.test('(a) creates keyserve.env when absent', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-create-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const result = await runSync(home, `${baseUrl}/keys/create`, `${baseUrl}/onboarding`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'keyserve.env'), 'utf8'), 'ORGIAST_KEYSERVE_SECRET=new-secret\n');
    assert.match(result.stdout, /provisioned: keyserve\.env/);
  });

  await t.test('(b) replaces changed keyserve.env', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-refresh-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const destination = path.join(home, '.claude', 'keyserve.env');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'ORGIAST_KEYSERVE_SECRET=old-secret\n', { mode: 0o644 });
    const result = await runSync(home, `${baseUrl}/keys/refresh`, `${baseUrl}/onboarding`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'ORGIAST_KEYSERVE_SECRET=new-secret\n');
    // Windows は POSIX パーミッションを持たない(読み取り専用フラグだけ)ので mode は検証しない。
    if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.match(result.stdout, /refreshed: keyserve\.env/);
  });

  await t.test('(c) does not rewrite identical keyserve.env', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-same-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const destination = path.join(home, '.claude', 'keyserve.env');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'ORGIAST_KEYSERVE_SECRET=same-secret\n', { mode: 0o600 });
    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(destination, fixedTime, fixedTime);
    const before = fs.statSync(destination).mtimeMs;
    const result = await runSync(home, `${baseUrl}/keys/same`, `${baseUrl}/onboarding`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(destination).mtimeMs, before);
    assert.doesNotMatch(result.stdout, /refreshed: keyserve\.env/);
  });

  await t.test('(d) refreshes distributed keys in an existing non-keyserve env file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-other-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const claudeDir = path.join(home, '.claude');
    const destination = path.join(claudeDir, 'provider.env');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'keyserve.env'), `ORGIAST_KEYSERVE_SECRET=${secret}\n`, { mode: 0o600 });
    fs.writeFileSync(destination, 'PROVIDER_KEY=existing-value\n', { mode: 0o600 });
    const result = await runSync(home, `${baseUrl}/keys/other`, `${baseUrl}/onboarding`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'PROVIDER_KEY=new-value\n');
    assert.match(result.stdout, /refreshed: provider\.env/);
  });

  await t.test('(e) refreshes only centrally managed cost reporter values', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-central-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const claudeDir = path.join(home, '.claude');
    const destination = path.join(claudeDir, 'cost-reporter.env');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'keyserve.env'), `ORGIAST_KEYSERVE_SECRET=${secret}\n`, { mode: 0o600 });
    fs.writeFileSync(destination, 'DISCORD_COST_WEBHOOK=https://example.invalid/old-hook\r\nREPORTER_LABEL=personal-pc\r\n', { mode: 0o644 });
    const result = await runSync(home, `${baseUrl}/keys/central`, `${baseUrl}/onboarding`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'DISCORD_COST_WEBHOOK=https://example.invalid/new-hook\r\nREPORTER_LABEL=personal-pc\r\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.match(result.stdout, /refreshed: cost-reporter\.env/);
  });

  await t.test('(f) does not rewrite an effectively unchanged merged env file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-central-same-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const destination = path.join(home, '.claude', 'cost-reporter.env');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'DISCORD_COST_WEBHOOK="https://example.invalid/new-hook"\nREPORTER_LABEL=personal-pc\n', { mode: 0o600 });
    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(destination, fixedTime, fixedTime);
    const before = fs.statSync(destination).mtimeMs;
    const result = await runSync(home, `${baseUrl}/keys/central`, `${baseUrl}/onboarding`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(destination).mtimeMs, before);
    assert.doesNotMatch(result.stdout, /refreshed: cost-reporter\.env/);
  });
});
