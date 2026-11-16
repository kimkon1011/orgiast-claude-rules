#!/usr/bin/env node
// 席別秘密の封印受け渡しツール。
// 各席が自分で秘密を作り、専用公開鍵で封印した文だけを fleet-mail で kim-PC に送り、
// kim-PC が復号して ORGIAST_PC_SECRETS_JSON / ORGIAST_PC_TIERS_JSON を組み立てる。
// fleet-agent の exec 経路が事前に tools/ を更新するため、git pull 無しで使える。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sealText, parseSealed, openWithDataKey } from './lib/knowledge-envelope.mjs';
import { requireKeyservePcId } from './keyserve-auth.mjs';
import { upsertEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const HOME = process.env.ORGIAST_HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBKEY_FILE = path.join(REPO_ROOT, 'tools', 'seat-secret-pubkey.pem');
const PRIVKEY_FILE = path.join(CLAUDE_DIR, 'seat-secret-private.pem');
const PENDING_FILE = path.join(CLAUDE_DIR, 'keyserve-seat-secret.pending');
const LEDGER_FILE = path.join(CLAUDE_DIR, 'seat-secret-ledger.json');
const DEFAULT_OUT_DIR = path.join(CLAUDE_DIR, 'seat-secret-out');

// ── 検証 ────────────────────────────────────────────────

export function validateSeatConfig(secrets, tiers, env) {
  const errors = [];
  const seen = new Set();
  const sharedSecret = env && env.ORGIAST_SHARED_SECRET;

  for (const [pcId, secret] of Object.entries(secrets)) {
    if (typeof pcId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(pcId)) {
      errors.push(`PC_ID 形式が不正: ${pcId}`);
    }
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) {
      errors.push(`秘密の形式が不正: ${pcId}`);
    }
    if (tiers && pcId in tiers) {
      const tier = tiers[pcId];
      if (!['ai', 'project', 'workspace'].includes(tier)) {
        errors.push(`tier が不正: ${pcId}=${tier}`);
      }
    }
    if (sharedSecret && secret === sharedSecret) {
      errors.push(`秘密が ORGIAST_SHARED_SECRET と同値: ${pcId}`);
    }
    if (seen.has(secret)) {
      errors.push(`秘密の重複: ${pcId}`);
    }
    seen.add(secret);
  }
  return { valid: errors.length === 0, errors };
}

// ── init-keypair ────────────────────────────────────────

export function initKeypair({ home = HOME } = {}) {
  const privPath = path.join(home, '.claude', 'seat-secret-private.pem');
  if (fs.existsSync(privPath)) {
    console.error('秘密鍵が既に存在します。上書きを防ぐため終了します。');
    process.exit(2);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubPath = path.join(REPO_ROOT, 'tools', 'seat-secret-pubkey.pem');
  fs.writeFileSync(pubPath, publicKey, 'utf8');
  console.log(`公開鍵: ${pubPath}`);
  fs.mkdirSync(path.dirname(privPath), { recursive: true });
  fs.writeFileSync(privPath, privateKey, { encoding: 'utf8', mode: 0o600 });
  console.log(`秘密鍵: ${privPath} (mode 0600)`);
}

// ── issue ───────────────────────────────────────────────

export function issue({ home = HOME, pubkeyPath = PUBKEY_FILE } = {}) {
  if (!fs.existsSync(pubkeyPath)) {
    console.error('公開鍵未設定。init-keypair を先に実行してください。');
    process.exit(2);
  }
  const pubkeyPem = fs.readFileSync(pubkeyPath, 'utf8');
  const pcId = requireKeyservePcId(home);
  const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');

  let secret;
  if (fs.existsSync(pendingPath)) {
    secret = fs.readFileSync(pendingPath, 'utf8').trim();
  } else {
    secret = crypto.randomBytes(48).toString('base64url');
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, secret, { encoding: 'utf8', mode: 0o600 });
  }

  // "seat:" prefix (not "seat-secret:") avoids redactSecrets false positive on "secret:" pattern
  const sealed = sealText(secret, { name: `seat:${pcId}`, publicKeyPem: pubkeyPem });
  const hostname = os.hostname();
  console.log(`SEAT-PC: ${pcId}`);
  console.log(`SEAT-HOST: ${hostname}`);
  console.log('SEAT-SEALED-BEGIN');
  process.stdout.write(sealed);
  console.log('SEAT-SEALED-END');
}

// ── activate ────────────────────────────────────────────

export function activate({ home = HOME, confirm = false, repoRoot = process.env.ORGIAST_REPO || REPO_ROOT, spawnFn = spawnSync } = {}) {
  const pendingPath = path.join(home, '.claude', 'keyserve-seat-secret.pending');
  if (!fs.existsSync(pendingPath)) {
    console.error('pending がありません。先に issue を実行してください。');
    process.exit(1);
  }
  if (!confirm) {
    console.error('--confirm が必要です。');
    process.exit(1);
  }

  const secret = fs.readFileSync(pendingPath, 'utf8').trim();
  const envPath = path.join(home, '.claude', 'keyserve.env');
  if (!fs.existsSync(envPath)) {
    console.error('keyserve.env が見つかりません。');
    process.exit(1);
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const bakPath = envPath + `.bak-seat-${now}`;
  fs.writeFileSync(bakPath, envContent, { encoding: 'utf8', mode: 0o600 });

  // Replace ORGIAST_KEYSERVE_SECRET in env content
  const newContent = upsertEnvValue(envContent, 'ORGIAST_KEYSERVE_SECRET', secret);
  fs.writeFileSync(envPath, newContent, { encoding: 'utf8', mode: 0o600 });

  // Fetch keys via onboarding-sync
  const syncScript = path.join(repoRoot, 'tools', 'onboarding-sync.mjs');
  const result = spawnFn(process.execPath, [syncScript, '--keys-only', '--force'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });

  if (result.status !== 0) {
    // Restore backup
    fs.writeFileSync(envPath, envContent, { encoding: 'utf8', mode: 0o600 });
    console.error('鍵取得に失敗しました。keyserve.env を復元しました。');
    process.exit(1);
  }

  // Rename pending to .activated
  fs.renameSync(pendingPath, pendingPath + '.activated');

  // Check workspace-sa.env
  const saEnvPath = path.join(home, '.claude', 'workspace-sa.env');
  if (fs.existsSync(saEnvPath)) {
    const saContent = fs.readFileSync(saEnvPath, 'utf8');
    const match = saContent.match(/^GOOGLE_SERVICE_ACCOUNT_JSON=(.*)$/m);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        console.log(`WORKSPACE-SA: present client_email=${parsed.client_email}`);
      } catch {
        console.log('WORKSPACE-SA: present (client_email 抽出不可)');
      }
    } else {
      console.log('WORKSPACE-SA: present (GOOGLE_SERVICE_ACCOUNT_JSON なし)');
    }
  } else {
    console.log('WORKSPACE-SA: missing');
  }
}

// ── collect ─────────────────────────────────────────────

export function collect({ mailFiles, home = HOME, privkeyPath = PRIVKEY_FILE, pubkeyPath = PUBKEY_FILE, expectMap = new Map() } = {}) {
  if (!fs.existsSync(privkeyPath)) {
    console.error('秘密鍵がありません。init-keypair を先に実行してください。');
    process.exit(1);
  }
  const privkeyPem = fs.readFileSync(privkeyPath, 'utf8');
  const pubkeyPem = fs.existsSync(pubkeyPath) ? fs.readFileSync(pubkeyPath, 'utf8') : null;
  const ledgerPath = path.join(home, '.claude', 'seat-secret-ledger.json');

  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch {}

  for (const mailFile of mailFiles) {
    const content = fs.readFileSync(mailFile, 'utf8');

    const pcMatch = content.match(/^SEAT-PC:\s*(.+)$/m);
    const hostMatch = content.match(/^SEAT-HOST:\s*(.+)$/m);
    const sealedMatch = content.match(/SEAT-SEALED-BEGIN\n([\s\S]*?)\nSEAT-SEALED-END/);

    if (!pcMatch || !hostMatch || !sealedMatch) {
      console.error(`封印文が見つかりません: ${mailFile}`);
      continue;
    }

    const pcId = pcMatch[1].trim();
    const hostname = hostMatch[1].trim();
    const sealedText = sealedMatch[1].trim();

    // Verify hostname against expect list
    if (expectMap.has(pcId)) {
      const allowed = expectMap.get(pcId);
      if (!allowed.includes(hostname)) {
        console.error(`ホスト名不一致: ${pcId} の報告 ${hostname} は許可リストにありません`);
        process.exitCode = 3;
        continue;
      }
    }

    // Decrypt
    const env = parseSealed(sealedText);
    const wrappedKey = Buffer.from(env.wrappedKey, 'base64url');
    const dataKey = crypto.privateDecrypt(
      { key: privkeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrappedKey
    );
    const plaintext = openWithDataKey(env, dataKey);

    // Re-seal with public key for storage
    const reSealed = pubkeyPem
      ? sealText(plaintext, { name: `seat:${pcId}`, publicKeyPem: pubkeyPem }).trim()
      : sealedText;

    // Store in ledger
    const existing = ledger[pcId];
    ledger[pcId] = {
      hostname,
      sealed: reSealed,
      receivedAt: new Date().toISOString(),
      seatNo: existing ? existing.seatNo : Object.keys(ledger).length + 1,
    };
  }

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ── build ───────────────────────────────────────────────

export function build({ outDir = DEFAULT_OUT_DIR, home = HOME, privkeyPath = PRIVKEY_FILE, pubkeyPath = PUBKEY_FILE, tierFor = [], existingTiersPath, env } = {}) {
  const ledgerPath = path.join(home, '.claude', 'seat-secret-ledger.json');
  if (!fs.existsSync(ledgerPath)) {
    console.error('台帳がありません。先に collect を実行してください。');
    process.exit(1);
  }
  if (!fs.existsSync(privkeyPath)) {
    console.error('秘密鍵がありません。');
    process.exit(1);
  }
  const privkeyPem = fs.readFileSync(privkeyPath, 'utf8');
  const pubkeyPem = fs.existsSync(pubkeyPath) ? fs.readFileSync(pubkeyPath, 'utf8') : null;
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

  const secrets = {};
  const tiers = {};

  for (const [pcId, entry] of Object.entries(ledger)) {
    const envObj = parseSealed(entry.sealed);
    const wrappedKey = Buffer.from(envObj.wrappedKey, 'base64url');
    const dataKey = crypto.privateDecrypt(
      { key: privkeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      wrappedKey
    );
    const plaintext = openWithDataKey(envObj, dataKey);
    secrets[pcId] = plaintext;
  }

  // Build tiers from --tier-for
  for (const pcId of tierFor) {
    tiers[pcId] = 'workspace';
  }

  // Merge existing tiers
  if (existingTiersPath) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingTiersPath, 'utf8'));
      Object.assign(tiers, existing);
    } catch {}
  }

  // Validate
  const validation = validateSeatConfig(secrets, tiers, env);
  if (!validation.valid) {
    for (const err of validation.errors) {
      console.error(`検証エラー: ${err}`);
    }
    process.exit(1);
  }

  // Write output
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pc-secrets.json'), JSON.stringify(secrets), { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'pc-tiers.json'), JSON.stringify(tiers), { encoding: 'utf8', mode: 0o600 });

  // Display only validation results, not values
  console.log(`pc-secrets.json: ${Object.keys(secrets).length} 件の秘密`);
  console.log(`pc-tiers.json: ${Object.keys(tiers).length} 件の tier`);
  console.log('検証: 合格');
}

// ── workspace-bundle ────────────────────────────────────

export function workspaceBundle(saJsonPath, outPath) {
  const saJson = JSON.parse(fs.readFileSync(saJsonPath, 'utf8'));
  const saStringified = JSON.stringify(saJson);
  const content = `GOOGLE_SERVICE_ACCOUNT_JSON=${saStringified}`;
  const bundle = { 'workspace-sa.env': content };
  fs.writeFileSync(outPath, JSON.stringify(bundle), { encoding: 'utf8', mode: 0o600 });
  console.log(`client_email=${saJson.client_email}`);
}

// ── CLI ─────────────────────────────────────────────────

function parseExpectArgs(args) {
  const expectMap = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--expect' && i + 1 < args.length) {
      const spec = args[++i];
      const eq = spec.indexOf('=');
      if (eq > 0) {
        const pcId = spec.slice(0, eq);
        const hosts = spec.slice(eq + 1).split(',').map(h => h.trim()).filter(Boolean);
        expectMap.set(pcId, hosts);
      }
    }
  }
  return expectMap;
}

function argValue(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];

  switch (cmd) {
    case 'init-keypair':
      initKeypair();
      break;

    case 'issue': {
      const pubkey = argValue(argv, '--pubkey');
      issue({ pubkeyPath: pubkey || PUBKEY_FILE });
      break;
    }

    case 'activate': {
      const confirm = argv.includes('--confirm');
      activate({ confirm });
      break;
    }

    case 'collect': {
      const mailFiles = [];
      const expectMap = parseExpectArgs(argv);
      const privkey = argValue(argv, '--privkey');
      const pubkey = argValue(argv, '--pubkey');
      for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--mail-file' && i + 1 < argv.length) {
          mailFiles.push(argv[++i]);
        }
      }
      collect({ mailFiles, expectMap, privkeyPath: privkey || PRIVKEY_FILE, pubkeyPath: pubkey || PUBKEY_FILE });
      break;
    }

    case 'build': {
      const outDir = argValue(argv, '--out-dir') || DEFAULT_OUT_DIR;
      const tierForArg = argValue(argv, '--tier-for');
      const tierFor = tierForArg ? tierForArg.split(',').map(s => s.trim()).filter(Boolean) : [];
      const existingTiersPath = argValue(argv, '--existing-tiers');
      const privkey = argValue(argv, '--privkey');
      const pubkey = argValue(argv, '--pubkey');
      build({ outDir, tierFor, existingTiersPath, privkeyPath: privkey || PRIVKEY_FILE, pubkeyPath: pubkey || PUBKEY_FILE });
      break;
    }

    case 'workspace-bundle': {
      const saPath = argValue(argv, '--sa-json');
      const outPath = argValue(argv, '--out');
      if (!saPath || !outPath) {
        console.error('Usage: seat-secret.mjs workspace-bundle --sa-json <path> --out <path>');
        process.exit(1);
      }
      workspaceBundle(saPath, outPath);
      break;
    }

    default:
      console.error('Usage: seat-secret.mjs <command> [options]');
      console.error('Commands:');
      console.error('  init-keypair                    RSA-3072 鍵ペア生成 (kim-PC 専用)');
      console.error('  issue [--pubkey <path>]         席秘密を発行・封印');
      console.error('  activate [--confirm]            pending を keyserve.env に反映');
      console.error('  collect --mail-file <f> [options] 封印文を収集・台帳に保存');
      console.error('  build [--out-dir <d>] [options]  台帳から JSON を生成');
      console.error('  workspace-bundle --sa-json <f> --out <f>  SA JSON を bundle');
      console.error('Options: --pubkey <path>  --privkey <path>');
      process.exit(1);
  }
}

if (isEntry(import.meta.url)) main();