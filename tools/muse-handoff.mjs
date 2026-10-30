#!/usr/bin/env node
// muse-handoff: 認証情報を暗号化し最小権限で外部AI（Muse 等）へ渡すパイプライン（P-0306）
//
// 目的: eval-harness 等が持つプロバイダ鍵（openrouter / groq / gemini / mistral / anthropic）を
//       外部AIへ共有する際、平文のまま渡さず 暗号化 + 最小権限（scope/purpose/recipient/TTL 束縛）+ 監査 で渡す。
//
// 暗号化: AES-256-GCM。鍵はマスターキー から HKDF-SHA256 で recipient に束縛して導出。
//         バンドルのヘッダ（v/name/scope/purpose/recipient/ttl/issuer）は AAD として認証されるため、
//         改ざん・権限昇格は復号失敗として fail closed する。
//
// 使い方:
//   wrap  : node tools/muse-handoff.mjs wrap --name openrouter [--scope eval] [--ttl 3600] [--recipient muse-wonder]
//   open  : node tools/muse-handoff.mjs open <bundle> [--scope ...] [--allow-print]
//   verify: node tools/muse-handoff.mjs verify [--name openrouter]
//
// マスターキー: 環境変数 MUSE_HANDOFF_MASTER_KEY か ~/.claude/muse-handoff.key（32byte 以上・0600 推奨）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BUNDLE_MAGIC = 'muse1';
export const DEFAULT_RECIPIENT = 'muse-wonder';
export const DEFAULT_SCOPE = 'eval';
export const DEFAULT_TTL_S = 3600;
export const VERSION = 1;
export const KEY_MIN_BYTES = 32;

// ---- キー管理 ------------------------------------------------------------

export function getMasterKey({ home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  if (process.env.MUSE_HANDOFF_MASTER_KEY) {
    const k = Buffer.from(process.env.MUSE_HANDOFF_MASTER_KEY, 'utf8');
    if (k.length < KEY_MIN_BYTES) throw new Error(`master key (env) must be >= ${KEY_MIN_BYTES} bytes`);
    return k;
  }
  const f = path.join(home, '.claude', 'muse-handoff.key');
  if (fs.existsSync(f)) {
    const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'utf8');
    if (k.length < KEY_MIN_BYTES) throw new Error(`${f} must contain >= ${KEY_MIN_BYTES} bytes`);
    return k;
  }
  throw new Error(`no master key: set MUSE_HANDOFF_MASTER_KEY or create ${f}`);
}

// eval-harness.mjs と同じ優先順位（env → ~/.claude/<name>.env、gemini は ~/.gemini/.env も）
export function loadProviderKey(name, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const keyEnv = `${name.toUpperCase()}_API_KEY`;
  if (process.env[keyEnv]) return process.env[keyEnv];
  const files = [path.join(home, '.claude', `${name}.env`)];
  if (name === 'gemini') files.unshift(path.join(home, '.gemini', '.env'));
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        if (line.startsWith(`${keyEnv}=`)) return line.slice(keyEnv.length + 1).trim();
      }
    } catch { /* 次の候補へ */ }
  }
  return '';
}

export const PROVIDER_KEYS = ['openrouter', 'groq', 'gemini', 'mistral', 'anthropic'];

// ---- 暗号化コア ----------------------------------------------------------

function deriveKey(masterKey, salt, recipient) {
  return crypto.hkdfSync('sha256', masterKey, salt, `muse-handoff:v${VERSION}:${recipient}`, 32);
}

function b64u(b) { return Buffer.from(b).toString('base64url'); }
function unb64u(s) { return Buffer.from(s, 'base64url'); }

export function buildHeader({ name, scope, purpose, recipient, ttl, notBefore, issuer }) {
  const scopes = scope.split(',').map((s) => s.trim()).filter(Boolean).sort();
  if (scopes.length === 0) throw new Error('scope must not be empty');
  const t = Number(ttl);
  if (!Number.isFinite(t) || t <= 0) throw new Error('ttl must be a positive number (seconds)');
  return {
    v: VERSION,
    name,
    scope: scopes,
    purpose: purpose || '',
    recipient,
    ttl: t,
    notBefore: Number(notBefore),
    kid: crypto.randomBytes(4).toString('hex'),
    issuer: issuer || os.hostname(),
  };
}

/** 秘密をマスターキーで暗号化して muse1 バンドル文字列を返す。秘密は戻り値に出ない。 */
export function wrapSecret(secret, opts) {
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('secret must be a non-empty string');
  const masterKey = opts.masterKey || getMasterKey(opts);
  if (masterKey.length < KEY_MIN_BYTES) throw new Error(`master key must be >= ${KEY_MIN_BYTES} bytes`);
  const header = buildHeader({
    name: opts.name || 'secret',
    scope: opts.scope || DEFAULT_SCOPE,
    purpose: opts.purpose || '',
    recipient: opts.recipient || DEFAULT_RECIPIENT,
    ttl: opts.ttl ?? DEFAULT_TTL_S,
    notBefore: opts.notBefore ?? Date.now(),
    issuer: opts.issuer,
  });
  const aad = Buffer.from(JSON.stringify(header), 'utf8');
  const salt = crypto.randomBytes(16);
  const key = deriveKey(masterKey, salt, header.recipient);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${BUNDLE_MAGIC}.${b64u(aad)}.${b64u(Buffer.concat([salt, nonce, tag, ct]))}`;
}

export function parseBundle(bundle) {
  const parts = String(bundle).split('.');
  if (parts.length !== 3 || parts[0] !== BUNDLE_MAGIC) throw new Error('invalid bundle format');
  const aad = unb64u(parts[1]);
  const body = unb64u(parts[2]);
  if (body.length < 16 + 12 + 16 + 1) throw new Error('bundle body too short');
  const header = JSON.parse(aad.toString('utf8'));
  const salt = body.subarray(0, 16);
  const nonce = body.subarray(16, 28);
  const tag = body.subarray(28, 44);
  const ct = body.subarray(44);
  return { aad, header, salt, nonce, tag, ct };
}

/**
 * バンドルを開く。最小権限: 要求 scope/purpose/recipient は認証済みヘッダの付与範囲内だけ。
 * 検証に失敗した場合はすべて throw（fail closed）。復号した秘密は戻り値にのみ現れる。
 */
export function unwrapSecret(bundle, opts) {
  const masterKey = opts.masterKey || getMasterKey(opts);
  if (masterKey.length < KEY_MIN_BYTES) throw new Error(`master key must be >= ${KEY_MIN_BYTES} bytes`);
  const { aad, header, salt, nonce, tag, ct } = parseBundle(bundle);
  if (header.v !== VERSION) throw new Error(`unsupported bundle version ${header.v}`);

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (now < header.notBefore) throw new Error('bundle not yet active');
  if (now > header.notBefore + header.ttl) throw new Error('bundle expired');

  // 最小権限: 要求 scope は付与済み scope の部分集合のみ（昇格は fail closed）
  const reqScope = opts.scope
    ? opts.scope.split(',').map((s) => s.trim()).filter(Boolean).sort()
    : header.scope;
  for (const s of reqScope) {
    if (!header.scope.includes(s)) throw new Error(`scope '${s}' not granted (granted: ${header.scope.join(',')})`);
  }
  if (reqScope.length === 0) throw new Error('scope must not be empty');
  if (opts.recipient && opts.recipient !== header.recipient) throw new Error('recipient mismatch');
  if (opts.purpose && opts.purpose !== header.purpose) throw new Error('purpose mismatch');

  const key = deriveKey(masterKey, salt, header.recipient);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  let secret;
  try {
    secret = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('authentication failed (tampered bundle or wrong key)');
  }
  return { header, secret };
}

// ---- 監査ログ ------------------------------------------------------------

export function auditLog(entry, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  try {
    const dir = path.join(home, '.claude', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'muse-handoff.log'),
      `[${new Date().toISOString()}] ${entry}\n`, 'utf8');
  } catch { /* 監査ログ失敗で処理は止めない */ }
}

// ---- CLI ----------------------------------------------------------------

export function parseArgs(argv) {
  const a = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x.startsWith('--')) {
      const key = x.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { a[key] = v; i += 1; } else { a[key] = true; }
    } else {
      positional.push(x);
    }
  }
  return { opts: a, positional };
}

export function redact(s) { return String(s).replace(/([A-Za-z0-9+/=_-]{12,})/g, '<REDACTED>'); }

export async function main(argv) {
  const { opts, positional } = parseArgs(argv);
  const home = opts.home || process.env.ORGIAST_HOME || os.homedir();
  const action = positional[0];
  const base = { home };

  try {
    switch (action) {
      case 'wrap': {
        const name = opts.name || 'secret';
        let secret = opts.secret;
        if (secret === undefined) {
          secret = opts.name ? loadProviderKey(name, base) : '';
          if (!secret) throw new Error(`no credential for '${name}' (set ${name.toUpperCase()}_API_KEY or ${name}.env)`);
        }
        const notBefore = opts['not-before'] ?? opts.notBefore;
        const bundle = wrapSecret(secret, {
          ...base,
          name,
          scope: opts.scope,
          purpose: opts.purpose,
          recipient: opts.recipient,
          ttl: opts.ttl,
          notBefore: notBefore === undefined ? undefined : Number(notBefore),
        });
        const { header } = parseBundle(bundle);
        auditLog(`wrap name=${name} scope=${header.scope.join(',')} purpose=${header.purpose || '-'} recipient=${header.recipient} ttl=${header.ttl}s ok`, base);
        process.stdout.write(`${bundle}\n`);
        return 0;
      }
      case 'open': {
        if (positional.length < 2) throw new Error('usage: open <bundle> [--scope ...] [--allow-print]');
        const { header, secret } = unwrapSecret(positional[1], {
          ...base,
          scope: opts.scope,
          purpose: opts.purpose,
          recipient: opts.recipient,
          now: opts.now === undefined ? undefined : Number(opts.now),
        });
        auditLog(`open name=${header.name} scope=${header.scope.join(',')} recipient=${header.recipient} outcome=ok`, base);
        if (opts['allow-print']) process.stdout.write(`${secret}\n`);
        else process.stdout.write(`[ok] name=${header.name} scope=${header.scope.join(',')} recipient=${header.recipient} purpose=${header.purpose || '-'}\n`);
        return 0;
      }
      case 'verify': {
        const names = opts.name ? opts.name.split(',') : PROVIDER_KEYS;
        let ok = 0;
        let missing = 0;
        for (const name of names) {
          const secret = opts.secret && opts.name === name ? opts.secret : loadProviderKey(name, base);
          if (!secret) { missing += 1; process.stdout.write(`verify ${name}: no credential present (skip)\n`); continue; }
          const bundle = wrapSecret(secret, { ...base, name, scope: opts.scope || DEFAULT_SCOPE, ttl: opts.ttl });
          const { header: h1, secret: back } = unwrapSecret(bundle, { ...base, scope: opts.scope || DEFAULT_SCOPE });
          if (back !== secret) throw new Error(`verify ${name}: roundtrip mismatch`);
          ok += 1;
          process.stdout.write(`verify ${name}: ok (scope=${h1.scope.join(',')} recipient=${h1.recipient})\n`);
        }
        if (ok === 0 && missing === 0) throw new Error('verify: no providers checked');
        process.stdout.write(`verify: ${ok} ok, ${missing} skipped\n`);
        return ok > 0 ? 0 : 2;
      }
      default:
        throw new Error('usage: muse-handoff.mjs <wrap|open|verify> [flags]');
    }
  } catch (err) {
    auditLog(`error action=${action} reason=${redact(err.message).slice(0, 200)}`, base);
    process.stderr.write(`muse-handoff: ${err.message}\n`);
    return 1;
  }
}

export function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}