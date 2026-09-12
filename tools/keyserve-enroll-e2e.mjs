#!/usr/bin/env node
// ローカルにある別リポの本物の Vercel handler に依存するため、CI では実行しない手動 E2E。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(toolsDir);
const defaultServerRepo = process.platform === 'win32'
  ? path.join(process.env.USERPROFILE || '', 'Downloads', 'orgiast-keyserve')
  : '/mnt/c/Users/uers/Downloads/orgiast-keyserve';

async function runNode(script, args, env) {
  const child = spawn(process.execPath, [path.join(toolsDir, script), ...args], {
    cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 30000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  if (result.status !== 0) {
    throw new Error(`${script} failed (${result.signal || `exit ${result.status}`})\n${result.stdout}${result.stderr}`);
  }
  return result;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readAllFiles(root) {
  const contents = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) contents.push(...readAllFiles(target));
    else if (entry.isFile()) contents.push(fs.readFileSync(target));
  }
  return contents;
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-enroll-e2e-'));
  const primaryHome = path.join(tempRoot, 'primary-home');
  const isolatedHome = path.join(tempRoot, 'isolated-home');
  const serverRepo = process.env.ORGIAST_KEYSERVE_REPO || defaultServerRepo;
  const primarySecret = crypto.randomBytes(32).toString('hex');
  const dummyFiles = {
    'fleet-sheet.env': 'FLEET_SHEET_ID=e2e-dummy-sheet\n',
    'discord.env': 'DISCORD_TEST_TOKEN=e2e-dummy-discord\n',
    'github.env': 'GITHUB_TEST_TOKEN=e2e-dummy-github\n',
  };
  const serverLogs = [];
  const requests = [];
  const savedServerEnv = new Map(Object.entries(process.env)
    .filter(([name]) => name === 'ORGIAST_SHARED_SECRET'
      || name === 'ORGIAST_SHARED_SECRET_LEGACY'
      || name === 'ORGIAST_ENROLL_SECRETS'
      || name === 'ORGIAST_ENROLL_EPOCH'
      || name === 'ORGIAST_KEYS_JSON'
      || name.startsWith('ORGIAST_KEYS_JSON_EXTRA')));
  let server;
  let token = '';
  const visibleOutput = [];

  try {
    const keysPath = path.join(serverRepo, 'api', 'keys.js');
    const enrollPath = path.join(serverRepo, 'api', 'enroll.js');
    assert.ok(fs.existsSync(keysPath), `server handler not found: ${keysPath}`);
    assert.ok(fs.existsSync(enrollPath), `server handler not found: ${enrollPath}`);

    process.env.ORGIAST_SHARED_SECRET = primarySecret;
    process.env.ORGIAST_KEYS_JSON = JSON.stringify(dummyFiles);
    process.env.ORGIAST_ENROLL_EPOCH = 'e2e';
    delete process.env.ORGIAST_SHARED_SECRET_LEGACY;
    delete process.env.ORGIAST_ENROLL_SECRETS;
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('ORGIAST_KEYS_JSON_EXTRA')) delete process.env[name];
    }
    const keysHandler = require(keysPath);
    const enrollHandler = require(enrollPath);

    server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks).toString('utf8');
        req.body = rawBody ? JSON.parse(rawBody) : {};
        const requestRecord = { url: req.url, headers: { ...req.headers }, status: null };
        requests.push(requestRecord);
        const handler = req.url === '/api/keys' ? keysHandler
          : req.url === '/api/enroll' ? enrollHandler : null;
        if (!handler) { res.statusCode = 404; res.end(); return; }
        const originalLog = console.log;
        console.log = (...parts) => serverLogs.push(parts.join(' '));
        try { await handler(req, res); requestRecord.status = res.statusCode; }
        finally { console.log = originalLog; }
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'local harness error' }));
        serverLogs.push(String(error?.message || error));
      }
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    fs.mkdirSync(path.join(primaryHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(primaryHome, '.claude', 'keyserve.env'), `ORGIAST_KEYSERVE_SECRET=${primarySecret}\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(isolatedHome, '.claude'), { recursive: true });
    assert.deepEqual(fs.readdirSync(path.join(isolatedHome, '.claude')), []);

    const baseEnv = { ...process.env,
      ORGIAST_KEYSERVE_ENROLL_URL: `${baseUrl}/api/enroll`,
      ORGIAST_KEYSERVE_URL: `${baseUrl}/api/keys`,
    };
    delete baseEnv.ORGIAST_KEYSERVE_SECRET;
    const issued = await runNode('keyserve-enroll.mjs', ['--pc', 'e2e-new-pc', '--ttl-hours', '1', '--json'], {
      ...baseEnv, ORGIAST_HOME: primaryHome,
    });
    const issuance = JSON.parse(issued.stdout);
    token = issuance.token;
    assert.match(token, /^ORG1\./);
    fs.writeFileSync(path.join(isolatedHome, '.claude', 'enroll.env'), `ORGIAST_ENROLL_TOKEN=${token}\n`, { mode: 0o600 });

    const isolatedEnv = { ...baseEnv, ORGIAST_HOME: isolatedHome };
    const first = await runNode('onboarding-sync.mjs', ['--keys-only', '--force'], isolatedEnv);
    visibleOutput.push(first.stdout, first.stderr);
    const firstKeysRequest = requests.filter((request) => request.url === '/api/keys')[0];
    assert.equal(firstKeysRequest?.headers['x-orgiast-enroll'], token);

    for (const [name, contents] of Object.entries(dummyFiles)) {
      assert.equal(fs.readFileSync(path.join(isolatedHome, '.claude', name), 'utf8'), contents);
    }
    assert.equal(fs.readFileSync(path.join(isolatedHome, '.claude', 'keyserve.env'), 'utf8'), `ORGIAST_KEYSERVE_SECRET=${primarySecret}\n`);
    assert.equal(fs.existsSync(path.join(isolatedHome, '.claude', 'enroll.env')), false);

    const second = await runNode('onboarding-sync.mjs', ['--keys-only', '--force'], isolatedEnv);
    visibleOutput.push(second.stdout, second.stderr);
    const keyRequests = requests.filter((request) => request.url === '/api/keys');
    assert.equal(keyRequests.length, 2);
    assert.equal(keyRequests[1].headers['x-orgiast-enroll'], undefined);
    assert.equal(keyRequests[1].status, 200);

    const statusRun = await runNode('keyserve-status.mjs', ['--json'], isolatedEnv);
    visibleOutput.push(statusRun.stderr);
    const status = JSON.parse(statusRun.stdout);
    assert.equal(status.auth, 'primary');
    assert.equal(status.status, 200);

    const filesOnDisk = readAllFiles(tempRoot);
    assert.ok(!Buffer.concat(filesOnDisk).includes(Buffer.from(token)));
    assert.ok(![...visibleOutput, ...serverLogs].join('\n').includes(token));

    const lines = [
      'OK: 隔離ホームは空の鍵状態から開始',
      'OK: 本物の /api/enroll が enroll トークンを発行',
      `OK: 鍵一式を取得 (${Object.keys(dummyFiles).join(', ')})`,
      'OK: keyserve.env を保存',
      'OK: enroll.env を削除',
      'OK: 2回目は x-orgiast-enroll なしで HTTP 200',
      'OK: keyserve-status は auth=primary / status=200',
      'OK: 標準出力・標準エラー・ログに生トークンなし',
      '認証経路: primary / HTTP 200',
    ];
    console.log(lines.join('\n'));
  } finally {
    if (server) await close(server);
    for (const name of Object.keys(process.env)) {
      if (name === 'ORGIAST_SHARED_SECRET'
          || name === 'ORGIAST_SHARED_SECRET_LEGACY'
          || name === 'ORGIAST_ENROLL_SECRETS'
          || name === 'ORGIAST_ENROLL_EPOCH'
          || name === 'ORGIAST_KEYS_JSON'
          || name.startsWith('ORGIAST_KEYS_JSON_EXTRA')) delete process.env[name];
    }
    for (const [name, value] of savedServerEnv) process.env[name] = value;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
