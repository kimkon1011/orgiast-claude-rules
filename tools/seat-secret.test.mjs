import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sealText, parseSealed, openWithDataKey } from './lib/knowledge-envelope.mjs';
import { redactSecrets } from './fleet-agent.mjs';
import { validateSeatConfig, workspaceBundle } from './seat-secret.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'seat-secret.mjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seat-secret-test-'));
}

function writeKeyserveEnv(dir, pcId, secret) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'keyserve.env'),
    `ORGIAST_KEYSERVE_PC=${pcId}\n${secret ? `ORGIAST_KEYSERVE_SECRET=${secret}\n` : ''}`,
    'utf8'
  );
}

function generateKeyPair(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubPath = path.join(dir, 'pubkey.pem');
  const privPath = path.join(dir, '.claude', 'seat-secret-private.pem');
  fs.writeFileSync(pubPath, publicKey, 'utf8');
  fs.mkdirSync(path.dirname(privPath), { recursive: true });
  fs.writeFileSync(privPath, privateKey, 'utf8');
  return { pubPath, privPath, publicKey, privateKey };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

// ── validateSeatConfig ──────────────────────────────────

test('validateSeatConfig: rejects duplicate secrets', () => {
  const result = validateSeatConfig(
    { pc1: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pc2: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    { pc1: 'workspace', pc2: 'workspace' }
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('重複')));
});

test('validateSeatConfig: rejects short secret', () => {
  const result = validateSeatConfig({ pc1: 'too-short' }, { pc1: 'workspace' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('形式が不正')));
});

test('validateSeatConfig: rejects invalid pcId', () => {
  const secret = 'a'.repeat(48);
  const result = validateSeatConfig({ 'invalid pc id!': secret }, { 'invalid pc id!': 'workspace' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('PC_ID')));
});

test('validateSeatConfig: rejects invalid tier', () => {
  const secret = 'a'.repeat(48);
  const result = validateSeatConfig({ pc1: secret }, { pc1: 'invalid-tier' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('tier')));
});

test('validateSeatConfig: rejects shared key equivalence', () => {
  const shared = 'b'.repeat(48);
  const result = validateSeatConfig({ pc1: shared }, { pc1: 'workspace' }, { ORGIAST_SHARED_SECRET: shared });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('ORGIAST_SHARED_SECRET')));
});

test('validateSeatConfig: accepts valid config', () => {
  const result = validateSeatConfig(
    { 'valid-pc': 'c'.repeat(48), 'another.pc': 'd'.repeat(48) },
    { 'valid-pc': 'workspace', 'another.pc': 'project' }
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateSeatConfig: rejects tier pcId not in secrets', () => {
  const secret = 'a'.repeat(48);
  const result = validateSeatConfig(
    { 'valid-pc': secret },
    { 'valid-pc': 'workspace', 'missing-pc': 'workspace' }
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('台帳にありません')));
});

// ── workspace-bundle ────────────────────────────────────

test('workspace-bundle: produces valid addTierFiles-compatible output', () => {
  const dir = tempDir();
  try {
    const saJson = { type: 'service_account', project_id: 'test', private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----', client_email: 'test@test.iam.gserviceaccount.com', client_id: '123' };
    const saPath = path.join(dir, 'sa.json');
    const outPath = path.join(dir, 'bundle.json');
    fs.writeFileSync(saPath, JSON.stringify(saJson), 'utf8');

    const stdout = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
    try {
      workspaceBundle(saPath, outPath);
    } finally {
      process.stdout.write = origWrite;
    }

    // Verify output file exists and is valid JSON
    const bundle = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.ok(bundle['workspace-sa.env']);

    // Verify addTierFiles rules: file name matches ^[A-Za-z0-9._-]+$
    assert.match('workspace-sa.env', /^[A-Za-z0-9._-]+$/);

    // Verify content is one line KEY=VALUE
    const content = bundle['workspace-sa.env'];
    assert.match(content, /^GOOGLE_SERVICE_ACCOUNT_JSON=/);
    assert.ok(!content.includes('\n'), 'content must be single line');

    // Verify JSON.parse roundtrip
    const value = content.slice('GOOGLE_SERVICE_ACCOUNT_JSON='.length);
    const parsed = JSON.parse(value);
    assert.equal(parsed.client_email, 'test@test.iam.gserviceaccount.com');

    // Verify client_email is displayed, private_key is not
    const stdoutText = stdout.join('');
    assert.ok(stdoutText.includes('client_email=test@test.iam.gserviceaccount.com'));
    assert.ok(!stdoutText.includes('PRIVATE KEY'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── issue → collect roundtrip ───────────────────────────

test('issue → collect roundtrip: secret matches', () => {
  const home = tempDir();
  const { pubPath, privPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    // Run issue with --pubkey
    const issueResult = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(issueResult.status, 0, `issue failed: ${issueResult.stderr}`);

    const output = issueResult.stdout;
    assert.match(output, /^SEAT-PC: test-pc$/m);
    assert.match(output, /^SEAT-HOST:/m);
    assert.match(output, /SEAT-SEALED-BEGIN\nORGLOCK1\n.+\nSEAT-SEALED-END/ms);

    // Create mail file
    const mailDir = tempDir();
    const mailFile = path.join(mailDir, 'mail.txt');
    fs.writeFileSync(mailFile, output, 'utf8');

    // Run collect with --privkey and --pubkey
    const collectResult = runCli(
      ['collect', '--mail-file', mailFile, '--privkey', privPath, '--pubkey', pubPath],
      { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' }
    );
    assert.equal(collectResult.status, 0, `collect failed: ${collectResult.stderr}`);

    // Verify ledger
    const ledgerPath = path.join(home, '.claude', 'seat-secret-ledger.json');
    assert.ok(fs.existsSync(ledgerPath));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.ok(ledger['test-pc']);
    assert.equal(ledger['test-pc'].hostname, os.hostname());
    assert.ok(ledger['test-pc'].sealed);
    assert.ok(ledger['test-pc'].receivedAt);
    assert.equal(ledger['test-pc'].seatNo, 1);

    // Decrypt ledger entry and verify secret matches pending
    const envObj = parseSealed(ledger['test-pc'].sealed);
    const wrappedKey = Buffer.from(envObj.wrappedKey, 'base64url');
    const privKeyPem = fs.readFileSync(privPath, 'utf8');
    const dataKey = crypto.privateDecrypt(
      { key: privKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrappedKey
    );
    const decrypted = openWithDataKey(envObj, dataKey);

    const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');
    const pending = fs.readFileSync(pendingPath, 'utf8').trim();
    assert.equal(decrypted, pending);

    // Cleanup mail dir
    fs.rmSync(mailDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── redactSecrets invariance ────────────────────────────

test('redactSecrets through issue output is unchanged', () => {
  const home = tempDir();
  const { pubPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    const result = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(result.status, 0);
    assert.equal(redactSecrets(result.stdout), result.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── issue twice = same secret ───────────────────────────

test('issue twice returns same secret (pending reuse), keyserve.env unchanged', () => {
  const home = tempDir();
  const { pubPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    const result1 = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    const result2 = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(result1.status, 0);
    assert.equal(result2.status, 0);

    // Both runs should produce the same secret (pending reuse)
    const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');
    const secret = fs.readFileSync(pendingPath, 'utf8').trim();
    assert.match(secret, /^[A-Za-z0-9_-]{43,128}$/);

    // The sealed output differs (different sealedAt timestamp) but the secret is the same
    // Extract the sealed JSON from both outputs and verify same sha256 (same plaintext)
    const extractSha = (out) => {
      const m = out.match(/"sha256":"([a-f0-9]+)"/);
      return m ? m[1] : null;
    };
    assert.equal(extractSha(result1.stdout), extractSha(result2.stdout));

    // Verify keyserve.env is unchanged
    const envContent = fs.readFileSync(path.join(home, '.claude', 'keyserve.env'), 'utf8');
    assert.ok(envContent.includes('ORGIAST_KEYSERVE_PC=test-pc'));
    assert.ok(envContent.includes('ORGIAST_KEYSERVE_SECRET=old-secret'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── activate ────────────────────────────────────────────

test('activate without --confirm does nothing', () => {
  const home = tempDir();
  writeKeyserveEnv(home, 'test-pc', 'old-secret');
  const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');
  fs.writeFileSync(pendingPath, 'new-secret-value', 'utf8');

  try {
    const result = runCli(['activate'], { ORGIAST_HOME: home });
    assert.notEqual(result.status, 0);

    // Verify keyserve.env unchanged
    const envContent = fs.readFileSync(path.join(home, '.claude', 'keyserve.env'), 'utf8');
    assert.ok(envContent.includes('ORGIAST_KEYSERVE_SECRET=old-secret'));

    // Verify pending still exists
    assert.ok(fs.existsSync(pendingPath));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('activate with --confirm replaces secret and runs key sync', () => {
  const home = tempDir();
  writeKeyserveEnv(home, 'test-pc', 'old-secret');
  const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');
  fs.writeFileSync(pendingPath, 'new-secret-value', 'utf8');

  // Create a mock repo with a tools/onboarding-sync.mjs that succeeds
  const mockRepo = tempDir();
  fs.mkdirSync(path.join(mockRepo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(mockRepo, 'tools', 'onboarding-sync.mjs'), 'process.exit(0);\n', 'utf8');

  try {
    const result = runCli(
      ['activate', '--confirm'],
      { ORGIAST_HOME: home, ORGIAST_REPO: mockRepo }
    );
    assert.equal(result.status, 0, `activate failed: ${result.stderr}`);

    // Verify keyserve.env was updated
    const envContent = fs.readFileSync(path.join(home, '.claude', 'keyserve.env'), 'utf8');
    assert.ok(envContent.includes('ORGIAST_KEYSERVE_SECRET=new-secret-value'));

    // Verify pending was renamed to .activated
    assert.ok(!fs.existsSync(pendingPath));
    assert.ok(fs.existsSync(pendingPath + '.activated'));

    // Verify backup was created
    const claudeDir = path.join(home, '.claude');
    const baks = fs.readdirSync(claudeDir).filter(f => f.startsWith('keyserve.env.bak-seat-'));
    assert.equal(baks.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mockRepo, { recursive: true, force: true });
  }
});

test('activate with --confirm restores backup on key sync failure', () => {
  const home = tempDir();
  writeKeyserveEnv(home, 'test-pc', 'old-secret');
  const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');
  fs.writeFileSync(pendingPath, 'new-secret-value', 'utf8');

  // Create a mock repo with a tools/onboarding-sync.mjs that FAILS
  const mockRepo = tempDir();
  fs.mkdirSync(path.join(mockRepo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(mockRepo, 'tools', 'onboarding-sync.mjs'), 'process.exit(1);\n', 'utf8');

  try {
    const result = runCli(
      ['activate', '--confirm'],
      { ORGIAST_HOME: home, ORGIAST_REPO: mockRepo }
    );
    assert.notEqual(result.status, 0);

    // Verify keyserve.env was restored
    const envContent = fs.readFileSync(path.join(home, '.claude', 'keyserve.env'), 'utf8');
    assert.ok(envContent.includes('ORGIAST_KEYSERVE_SECRET=old-secret'));

    // Verify pending still exists (not renamed)
    assert.ok(fs.existsSync(pendingPath));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mockRepo, { recursive: true, force: true });
  }
});

// ── collect hostname mismatch ───────────────────────────

test('collect: hostname mismatch exits 3 and does not add to ledger', () => {
  const home = tempDir();
  const { pubPath, privPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    // Run issue to get a sealed secret
    const issueResult = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(issueResult.status, 0);

    // Create mail file with a DIFFERENT hostname
    const mailDir = tempDir();
    const mailFile = path.join(mailDir, 'mail.txt');
    const fakeOutput = issueResult.stdout.replace(
      new RegExp(`^SEAT-HOST: ${os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      'SEAT-HOST: WRONG-HOST'
    );
    fs.writeFileSync(mailFile, fakeOutput, 'utf8');

    // Run collect with --expect that only allows the real hostname
    // The hostname in the mail is WRONG-HOST, but --expect allows only the real hostname
    const collectResult = runCli(
      ['collect', '--mail-file', mailFile, '--privkey', privPath, '--pubkey', pubPath,
       '--expect', `test-pc=${os.hostname()}`],
      { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' }
    );
    // Should exit with code 3
    assert.equal(collectResult.status, 3);

    // Verify ledger does NOT have the entry
    const ledgerPath = path.join(home, '.claude', 'seat-secret-ledger.json');
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      assert.ok(!ledger['test-pc'], 'should not have test-pc in ledger');
    }

    fs.rmSync(mailDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collect: handles CRLF line endings', () => {
  const home = tempDir();
  const { pubPath, privPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    // Run issue to get a sealed secret
    const issueResult = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(issueResult.status, 0);

    // Create mail file with CRLF line endings (simulating PowerShell Set-Content)
    const mailDir = tempDir();
    const mailFile = path.join(mailDir, 'mail.txt');
    const crlfContent = issueResult.stdout.replace(/\n/g, '\r\n');
    fs.writeFileSync(mailFile, crlfContent, 'utf8');

    // Run collect
    const collectResult = runCli(
      ['collect', '--mail-file', mailFile, '--privkey', privPath, '--pubkey', pubPath],
      { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' }
    );
    assert.equal(collectResult.status, 0, `collect failed: ${collectResult.stderr}`);

    // Verify ledger has the entry
    const ledgerPath = path.join(home, '.claude', 'seat-secret-ledger.json');
    assert.ok(fs.existsSync(ledgerPath));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.ok(ledger['test-pc']);

    fs.rmSync(mailDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collect: handles extra lines and quoting prefix around sealed block', () => {
  const home = tempDir();
  const { pubPath, privPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    // Run issue to get a sealed secret
    const issueResult = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(issueResult.status, 0);

    // Create mail file with extra lines and > prefix (simulating email reply quoting)
    const mailDir = tempDir();
    const mailFile = path.join(mailDir, 'mail.txt');
    const original = issueResult.stdout;
    const withPrefix = original.split('\n').map(line => {
      if (line.startsWith('SEAT-') || line.startsWith('ORGLOCK')) {
        return '> ' + line;
      }
      return line;
    }).join('\n');
    const wrapped = `Some preamble text\n\n${withPrefix}\n\nSome trailing text\n`;
    fs.writeFileSync(mailFile, wrapped, 'utf8');

    // Run collect
    const collectResult = runCli(
      ['collect', '--mail-file', mailFile, '--privkey', privPath, '--pubkey', pubPath],
      { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' }
    );
    assert.equal(collectResult.status, 0, `collect failed: ${collectResult.stderr}`);

    // Verify ledger has the entry
    const ledgerPath = path.join(home, '.claude', 'seat-secret-ledger.json');
    assert.ok(fs.existsSync(ledgerPath));
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.ok(ledger['test-pc']);

    fs.rmSync(mailDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── build ───────────────────────────────────────────────

test('build: generates pc-secrets.json and pc-tiers.json from ledger', () => {
  const home = tempDir();
  const { pubPath, privPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    // Run issue to create a secret
    const issueResult = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(issueResult.status, 0);

    // Create mail file and run collect
    const mailDir = tempDir();
    const mailFile = path.join(mailDir, 'mail.txt');
    fs.writeFileSync(mailFile, issueResult.stdout, 'utf8');

    const collectResult = runCli(
      ['collect', '--mail-file', mailFile, '--privkey', privPath, '--pubkey', pubPath],
      { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' }
    );
    assert.equal(collectResult.status, 0);

    // Run build with --privkey and --pubkey
    const outDir = path.join(home, 'out');
    const buildResult = runCli(
      ['build', '--out-dir', outDir, '--tier-for', 'test-pc', '--privkey', privPath, '--pubkey', pubPath],
      { ORGIAST_HOME: home }
    );
    assert.equal(buildResult.status, 0, `build failed: ${buildResult.stderr}`);

    // Verify output files
    const secretsPath = path.join(outDir, 'pc-secrets.json');
    const tiersPath = path.join(outDir, 'pc-tiers.json');
    assert.ok(fs.existsSync(secretsPath));
    assert.ok(fs.existsSync(tiersPath));

    const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    const tiers = JSON.parse(fs.readFileSync(tiersPath, 'utf8'));

    assert.ok(secrets['test-pc']);
    assert.equal(tiers['test-pc'], 'workspace');

    // Verify the secret in the output is valid format
    assert.match(secrets['test-pc'], /^[A-Za-z0-9_-]{43,128}$/);

    // Verify build output does NOT contain the plaintext secret
    assert.ok(!buildResult.stdout.includes(secrets['test-pc']));
    assert.ok(!buildResult.stderr.includes(secrets['test-pc']));

    fs.rmSync(mailDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('build: rejects --tier-for pcId not in ledger', () => {
  const home = tempDir();
  const { pubPath, privPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    // Run issue to create a secret
    const issueResult = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(issueResult.status, 0);

    // Create mail file and run collect
    const mailDir = tempDir();
    const mailFile = path.join(mailDir, 'mail.txt');
    fs.writeFileSync(mailFile, issueResult.stdout, 'utf8');

    const collectResult = runCli(
      ['collect', '--mail-file', mailFile, '--privkey', privPath, '--pubkey', pubPath],
      { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' }
    );
    assert.equal(collectResult.status, 0);

    // Run build with --tier-for pointing to a pcId NOT in the ledger
    const outDir = path.join(home, 'out');
    const buildResult = runCli(
      ['build', '--out-dir', outDir, '--tier-for', 'nonexistent-pc', '--privkey', privPath, '--pubkey', pubPath],
      { ORGIAST_HOME: home }
    );
    // Should fail with exit code 1
    assert.notEqual(buildResult.status, 0);
    assert.ok(buildResult.stderr.includes('台帳にありません') || buildResult.stderr.includes('tier'));

    fs.rmSync(mailDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── No plaintext secrets in output ──────────────────────

test('no plaintext secret appears in stdout/stderr/logs', () => {
  const home = tempDir();
  const { pubPath } = generateKeyPair(home);
  writeKeyserveEnv(home, 'test-pc', 'old-secret');

  try {
    const result = runCli(['issue', '--pubkey', pubPath], { ORGIAST_HOME: home, ORGIAST_KEYSERVE_PC: 'test-pc' });
    assert.equal(result.status, 0);

    // Read the pending file to know the actual secret
    const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');
    const secret = fs.readFileSync(pendingPath, 'utf8').trim();

    // The secret should NOT appear in stdout
    assert.ok(!result.stdout.includes(secret), 'secret leaked to stdout');
    assert.ok(!result.stderr.includes(secret), 'secret leaked to stderr');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});