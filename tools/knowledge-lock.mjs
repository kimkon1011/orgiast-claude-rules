#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { keyserveSecret, requireKeyservePcId, keyserveAuthHeaders } from './keyserve-auth.mjs';
import { loadLedger, serverProjection, isContractedLocal } from './claude-account-ledger.mjs';
import { sealText, parseSealed, openWithDataKey, decodeBase64url } from './lib/knowledge-envelope.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const APPLY_MESSAGE = '本番反映には keyserve の再デプロイが必要（kim 承認待ち）';
const ROTATE_MESSAGE = '既存の公開鍵があります。旧秘密鍵を KNOWLEDGE_LOCK_PRIVATE_KEY_OLD、旧 kid を KNOWLEDGE_LOCK_KID_OLD に production/preview とも保管してから、新しい --kid と --rotate を指定してください。Sensitive の旧秘密鍵は読み戻せないため、保管元が無い場合はローテーションできません。';
const fail = message => { throw new Error(message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const saveJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

export function canonicalVerdict(v) {
  return JSON.stringify({ email: v.email, orgUuid: v.orgUuid, contracted: v.contracted,
    reason: v.reason, pcId: v.pcId, iat: v.iat, exp: v.exp });
}

export function verifyVerdict(verdict, sig, publicKeyPem, pcId, now = Date.now(), { allowExpired = false } = {}) {
  try {
    if (!verdict || typeof verdict.email !== 'string' || typeof verdict.orgUuid !== 'string'
        || typeof verdict.contracted !== 'boolean' || typeof verdict.reason !== 'string'
        || verdict.pcId !== pcId || !Number.isSafeInteger(verdict.iat) || !Number.isSafeInteger(verdict.exp)
        || verdict.iat > Math.floor(now / 1000) + 60 || (!allowExpired && verdict.exp <= Math.floor(now / 1000))
        || verdict.exp <= verdict.iat) return false;
    return crypto.verify('sha256', Buffer.from(canonicalVerdict(verdict)), {
      key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }, decodeBase64url(sig));
  } catch { return false; }
}

export function parseCredentialBlob(blob) {
  const parts = typeof blob === 'string' ? blob.split('.') : [];
  if (parts.length !== 2) fail('パスキー blob の形式が不正です');
  decodeBase64url(parts[1], 32);
  const value = JSON.parse(decodeBase64url(parts[0]).toString('utf8'));
  if (!value || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || !decodeBase64url(value.id).length) fail('パスキーの形式が不正です');
  const key = crypto.createPublicKey({ key: decodeBase64url(value.spki), format: 'der', type: 'spki' });
  if (!((value.alg === -7 && key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1')
      || (value.alg === -257 && key.asymmetricKeyType === 'rsa'))) fail('パスキーのアルゴリズムが不正です');
  // HMAC の秘密はサーバ専用。ここでは形式のみ検査し、公開フィールドだけ保存する。
  return { id: value.id, spki: value.spki, alg: value.alg, createdAt: value.createdAt };
}

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  const allowed = {
    migrate: ['plan', 'apply', 'root', 'delete-plaintext', 'kim-approved'],
    seal: ['out'], open: ['out', 'request', 'grant'], 'verify-account': ['json'], status: [],
    keygen: ['kid', 'apply', 'rotate'], 'passkey-link': [], 'passkey-install': ['blob', 'apply'], 'ledger-sync': ['apply'],
  };
  if (!Object.hasOwn(allowed, command)) fail('使い方: knowledge-lock seal|open|verify-account|migrate|status|keygen|passkey-link|passkey-install|ledger-sync');
  const options = {};
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { files.push(rest[i]); continue; }
    const key = rest[i].slice(2);
    if (!allowed[command].includes(key) || Object.hasOwn(options, key)) fail('オプションが不正です');
    if (['json', 'apply', 'rotate', 'plan', 'delete-plaintext', 'kim-approved'].includes(key)) options[key] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) fail('オプションの値がありません');
      options[key] = value;
    }
  }
  if (files.length !== (['seal', 'open'].includes(command) ? 1 : 0)) fail('ファイル指定が不正です');
  if (!!options.request !== !!options.grant) fail('--request と --grant は両方指定してください');
  return { command, options, file: files[0] };
}

// 子プロセスの出力は秘密を含みうるので、そのまま表示しない。
export async function vercelEnv(ctx, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = ctx.spawn(ctx.platform === 'win32' ? 'vercel.cmd' : 'vercel', ['env', ...args], {
      cwd: ctx.serverDir, shell: ctx.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let diagnostic = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    child.on('error', () => reject(new Error('Vercel CLI を起動できません')));
    child.stdin.on('error', () => reject(new Error('Vercel CLI への入力に失敗しました')));
    child.on('close', code => {
      if (code === 0 || (args[0] === 'rm' && /(?:environment variable[^\n]*not found|could not find[^\n]*environment variable)/i.test(diagnostic))) resolve();
      else reject(new Error('Vercel 環境変数の更新に失敗しました'));
    });
    child.stdin.end(input);
  });
}

export async function putEnv(ctx, name, value, replace = true) {
  for (const target of ['production', 'preview']) {
    if (replace) await vercelEnv(ctx, ['rm', name, target, '-y']);
    await vercelEnv(ctx, ['add', name, target, '--sensitive'], value);
  }
}

function context(deps) {
  const platform = deps.platform || process.platform;
  const dir = deps.toolsDir || toolsDir;
  return {
    home: deps.home || os.homedir(), env: deps.env || process.env, platform, toolsDir: dir,
    fetch: deps.fetch || globalThis.fetch, spawn: deps.spawn || nodeSpawn,
    stdout: deps.stdout || (text => process.stdout.write(text)), stderr: deps.stderr || (text => process.stderr.write(text)),
    now: deps.now || Date.now, timeoutMs: deps.timeoutMs || 30000,
    serverDir: deps.serverDir || (platform === 'win32' ? 'C:\\Users\\uers\\Downloads\\orgiast-keyserve'
      : fs.existsSync('/mnt/c/Users/uers/Downloads/orgiast-keyserve') ? '/mnt/c/Users/uers/Downloads/orgiast-keyserve' : path.resolve(dir, '../../orgiast-keyserve')),
  };
}

// symlink は移行対象にしない。Downloads は直下の git リポだけ探索する。
export function migrateTargets(home, root) {
  const targets = [];
  const entries = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  const walk = dir => {
    for (const entry of entries(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) targets.push(file);
    }
  };
  const claude = path.join(home, '.claude');
  for (const entry of entries(claude)) {
    if (entry.isFile() && /^next-session.*\.md$/i.test(entry.name)) targets.push(path.join(claude, entry.name));
    if (entry.isDirectory() && /^handoff/i.test(entry.name)) walk(path.join(claude, entry.name));
  }
  for (const entry of entries(root)) {
    if (!entry.isDirectory()) continue;
    const repo = path.join(root, entry.name);
    if (!fs.existsSync(path.join(repo, '.git'))) continue;
    for (const child of entries(repo)) if (child.isFile() && /^HANDOVER\.md$/i.test(child.name)) targets.push(path.join(repo, child.name));
  }
  return targets.sort();
}

export async function openKnowledge(file, deps = {}) {
  let text = '', approval;
  const code = await main(['open', file], { ...deps, stdout: v => { text += v; },
    stderr: () => {}, onApproval: v => { approval = v; } });
  if (code === 3) throw Object.assign(new Error('kim の承認が必要です'), {
    code: 'approval_required', request: approval.request, approveUrl: approval.approveUrl });
  if (code !== 0) throw Object.assign(new Error('引き継ぎの開封に失敗しました'), { code: 'knowledge_open_failed' });
  return text;
}

export async function verifyAccount(deps = {}) {
  const ctx = context(deps);
  const pem = fs.readFileSync(path.join(ctx.toolsDir, 'knowledge-lock-pubkey.pem'), 'utf8');
  const pcId = requireKeyservePcId(ctx.home, ctx.env);
  try {
    const cached = readJson(path.join(ctx.home, '.claude/state/knowledge-verdict.json'));
    if (verifyVerdict(cached.verdict, cached.sig, pem, pcId, ctx.now())) return cached.verdict;
  } catch { /* Invalid cache requires server verification. */ }
  let output = '';
  const code = await main(['verify-account', '--json'], { ...deps,
    stdout: v => { output += v; }, stderr: () => {} });
  if (![0, 4].includes(code)) throw new Error('アカウント判定不能');
  return JSON.parse(output).verdict;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const ctx = context(deps);
  let command = argv[0];
  const out = text => ctx.stdout(`${text}\n`);
  const pubFile = path.join(ctx.toolsDir, 'knowledge-lock-pubkey.pem');
  const metaFile = path.join(ctx.toolsDir, 'knowledge-lock-pubkey.json');
  const verdictFile = path.join(ctx.home, '.claude/state/knowledge-verdict.json');
  const publicKey = () => fs.readFileSync(pubFile, 'utf8');
  const kid = () => fs.existsSync(metaFile) ? readJson(metaFile).kid : 'k1';
  const ledger = () => loadLedger(path.join(ctx.toolsDir, 'claude-account-ledger.json'));
  const pc = () => requireKeyservePcId(ctx.home, ctx.env);
  async function request(action, fields = {}) {
    const secret = keyserveSecret(ctx.home, ctx.env);
    if (!secret) fail('keyserve 認証が未設定です');
    let claudeToken;
    if (action !== 'register-link') {
      claudeToken = readJson(path.join(ctx.home, '.claude/.credentials.json'))?.claudeAiOauth?.accessToken;
      if (typeof claudeToken !== 'string' || !claudeToken) fail('Claude OAuth トークンがありません');
    }
    const url = new URL('/api/knowledge', ctx.env.ORGIAST_KEYSERVE_URL || 'https://orgiast-keyserve.vercel.app/api/keys');
    const response = await ctx.fetch(url.href, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...keyserveAuthHeaders(secret, ctx.now(), pc()) },
      body: JSON.stringify({ action, ...(claudeToken ? { claudeToken } : {}), ...fields }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    const result = await response.json();
    if (!response.ok && !(action === 'unwrap' && result.status === 'approval_required')) fail('keyserve が要求を拒否しました');
    return result;
  }
  try {
    const parsed = argumentsFor(argv);
    command = parsed.command;
    const { options, file } = parsed;
    if (command === 'migrate') {
      const stateFile = path.join(ctx.home, '.claude/state/knowledge-migrate.json');
      const hash = value => crypto.createHash('sha256').update(value).digest('hex');
      if (options['delete-plaintext'] || options['kim-approved']) {
        if (!options['delete-plaintext'] || !options['kim-approved'] || options.plan || options.apply) {
          ctx.stderr('削除には --delete-plaintext と --kim-approved の両方だけを指定してください\n');
          return 2;
        }
        const records = readJson(stateFile);
        for (const record of records) {
          if (record.roundTrip !== 'ok' || !fs.existsSync(record.path)) continue;
          // 往復検証後に変更された平文・封印は削除しない。
          if (!fs.lstatSync(record.path).isFile() || hash(fs.readFileSync(record.path)) !== record.sha256
              || !fs.existsSync(`${record.path}.lock`) || hash(fs.readFileSync(`${record.path}.lock`)) !== record.sealedSha256) continue;
          fs.unlinkSync(record.path);
          record.deleted = true;
          saveJson(stateFile, records);
          out(JSON.stringify({ path: record.path, deleted: true }));
        }
        return 0;
      }
      if (!!options.plan === !!options.apply) {
        ctx.stderr('migrate は --plan または --apply を1つ指定してください\n');
        return 2;
      }
      const targets = migrateTargets(ctx.home, options.root || (ctx.platform === 'win32'
        ? 'C:\\Users\\uers\\Downloads' : '/mnt/c/Users/uers/Downloads'));
      if (options.plan) {
        out('path\tbytes\tsealedExists');
        for (const file of targets) out(`${file}\t${fs.statSync(file).size}\t${fs.existsSync(`${file}.lock`)}`);
        return 0;
      }
      const records = [];
      for (const file of targets) {
        const record = { path: file, sealed: false, roundTrip: 'failed' };
        try {
          const bytes = fs.readFileSync(file);
          const sealed = sealText(bytes.toString('utf8'), { name: path.basename(file), publicKeyPem: publicKey(), kid: kid(), now: ctx.now() });
          fs.writeFileSync(`${file}.lock`, sealed, { mode: 0o600 });
          record.sealed = true;
          const envelope = parseSealed(sealed);
          const result = await request('unwrap', { kid: envelope.kid, wrappedKey: envelope.wrappedKey, name: envelope.name, sha256: envelope.sha256 });
          if (result.status === 'approval_required') record.roundTrip = 'skipped(kim承認待ち)';
          else if (result.status === 'ok') {
            const key = decodeBase64url(result.dataKey, 32);
            try {
              if (hash(openWithDataKey(envelope, key)) === hash(bytes)) {
                record.roundTrip = 'ok';
                record.sha256 = hash(bytes);
                record.sealedSha256 = hash(sealed);
              }
            } finally { key.fill(0); }
          }
        } catch { /* 秘密を含みうる例外本文は保存しない */ }
        records.push(record);
        saveJson(stateFile, records);
        out(JSON.stringify(record));
      }
      if (!targets.length) saveJson(stateFile, records);
      return records.some(r => r.roundTrip !== 'ok') ? 2 : 0;
    }
    if (command === 'status') {
      out(fs.existsSync(pubFile) ? `公開鍵: 設定済み / kid: ${kid()}` : '公開鍵未設定');
      if (fs.existsSync(verdictFile)) {
        const cached = readJson(verdictFile);
        const valid = fs.existsSync(pubFile) && verifyVerdict(cached.verdict, cached.sig, publicKey(), pc(), ctx.now());
        out(`キャッシュ済み判定: ${valid ? (cached.verdict.contracted ? '契約' : '契約外/判定不能') : '無効または期限切れ'}`);
      } else out('キャッシュ済み判定: なし');
      const accountFile = path.join(ctx.home, '.claude.json');
      const email = fs.existsSync(accountFile) ? readJson(accountFile)?.oauthAccount?.emailAddress : '';
      out(`ローカル email: ${email || '未設定'} / 台帳: ${isContractedLocal(email, ledger()) ? 'active' : 'active 登録なし'}`);
      return 0;
    }
    if (command === 'seal') {
      if (!fs.existsSync(pubFile)) { ctx.stderr('公開鍵未設定\n'); return 2; }
      const sealed = sealText(fs.readFileSync(file, 'utf8'), { name: path.basename(file), publicKeyPem: publicKey(), kid: kid(), now: ctx.now() });
      fs.writeFileSync(options.out || `${file}.lock`, sealed, { mode: 0o600 });
      out('封印しました');
      return 0;
    }
    if (command === 'open') {
      const env = parseSealed(fs.readFileSync(file, 'utf8'));
      const result = await request('unwrap', { kid: env.kid, wrappedKey: env.wrappedKey, name: env.name, sha256: env.sha256,
        ...(options.request ? { request: options.request, grant: options.grant } : {}) });
      if (result.status === 'approval_required') {
        if (typeof result.request !== 'string' || typeof result.approveUrl !== 'string') fail('承認レスポンスが不正です');
        deps.onApproval?.(result);
        ctx.stderr(`契約外アカウントのため kim の承認が必要。${result.dmSent ? 'kim のスマホに承認リンクを送りました。' : `リンク: ${result.approveUrl}`}\n承認後に表示される8文字コードで再実行: node tools/knowledge-lock.mjs open ${JSON.stringify(file)} --request ${result.request} --grant <コード>\n`);
        return 3;
      }
      if (result.status !== 'ok') fail('開封できませんでした');
      const key = decodeBase64url(result.dataKey, 32);
      try {
        const plaintext = openWithDataKey(env, key);
        if (options.out) fs.writeFileSync(options.out, plaintext, { mode: 0o600 });
        else ctx.stdout(plaintext);
      } finally { key.fill(0); }
      return 0;
    }
    if (command === 'verify-account') {
      const pem = publicKey();
      const result = await request('verify-account');
      if (!verifyVerdict(result.verdict, result.sig, pem, pc(), ctx.now())) fail('判定署名が不正です');
      const cached = { verdict: result.verdict, sig: result.sig };
      saveJson(verdictFile, cached);
      const unknown = result.verdict.reason === 'profile_unavailable';
      out(options.json ? JSON.stringify(cached) : unknown ? '判定不能' : result.verdict.contracted ? '契約アカウント' : '契約外アカウント');
      return unknown ? 5 : result.verdict.contracted ? 0 : 4;
    }
    if (command === 'passkey-link') {
      const result = await request('register-link');
      if (typeof result.registerUrl !== 'string' || typeof result.dmSent !== 'boolean') fail('登録レスポンスが不正です');
      out(`registerUrl: ${result.registerUrl}\ndmSent: ${result.dmSent}`);
      return 0;
    }
    if (command === 'keygen') {
      const exists = fs.existsSync(pubFile);
      if (exists && !options.rotate) { ctx.stderr(`${ROTATE_MESSAGE}\n`); return 2; }
      const nextKid = options.kid || 'k1';
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(nextKid) || (exists && nextKid === kid())) fail('新しい有効な kid を指定してください');
      if (exists) out(ROTATE_MESSAGE);
      // --apply 無しはローカル公開鍵も変更せず、生成した秘密鍵を破棄する。
      const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      if (!options.apply) { out(`計画: RSA-3072 / kid=${nextKid} / 公開鍵保存と production/preview の環境変数設定（未適用）`); return 0; }
      await putEnv(ctx, 'KNOWLEDGE_LOCK_PRIVATE_KEY', pair.privateKey, exists);
      await putEnv(ctx, 'KNOWLEDGE_LOCK_KID', nextKid, exists);
      await putEnv(ctx, 'KNOWLEDGE_GRANT_SECRET', crypto.randomBytes(32).toString('base64url'), exists);
      fs.writeFileSync(pubFile, pair.publicKey);
      saveJson(metaFile, { kid: nextKid });
      out(APPLY_MESSAGE);
      return 0;
    }
    if (command === 'passkey-install') {
      const value = parseCredentialBlob(options.blob);
      const file = path.join(ctx.toolsDir, 'knowledge-passkeys.json');
      const entries = fs.existsSync(file) ? readJson(file) : [];
      if (!Array.isArray(entries)) fail('パスキー台帳が不正です');
      const previous = entries.find(entry => entry.id === value.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) fail('同じ ID の異なるパスキーが登録されています');
      if (!previous) entries.push(value);
      out(`計画: 公開パスキー ${entries.length} 件を production/preview に設定（blob の署名はサーバ専用のためローカルでは未検証）`);
      if (options.apply) {
        // 片環境だけ失敗しても再実行できるよう公開情報の台帳を先に保存する。
        saveJson(file, entries);
        await putEnv(ctx, 'KIM_PASSKEY_CREDENTIALS', JSON.stringify(entries));
        out(APPLY_MESSAGE);
      }
      return 0;
    }
    if (command === 'ledger-sync') {
      const projection = serverProjection(ledger());
      const snapshotFile = path.join(ctx.toolsDir, 'knowledge-ledger-synced.json');
      const previous = fs.existsSync(snapshotFile) ? readJson(snapshotFile) : null;
      out('差分（前回のローカル同期記録との比較。Sensitive のサーバ現在値は取得不可）:');
      for (const key of Object.keys(projection)) {
        out(`${key}: 追加=${JSON.stringify(projection[key].filter(v => !previous?.[key]?.includes(v)))} 削除=${JSON.stringify((previous?.[key] || []).filter(v => !projection[key].includes(v)))}`);
      }
      if (options.apply) {
        await putEnv(ctx, 'KNOWLEDGE_LEDGER_JSON', JSON.stringify(projection));
        saveJson(snapshotFile, projection);
        out(APPLY_MESSAGE);
      }
      return 0;
    }
  } catch {
    // fetch/spawn/JSON 例外にトークン・平文が含まれる可能性があるため詳細は出さない。
    ctx.stderr(command === 'verify-account' ? 'アカウント判定不能（認証・公開鍵・署名・有効期限を確認してください）\n'
      : '処理に失敗しました（引数・ファイル形式・認証・環境変数設定を確認してください）\n');
    return command === 'verify-account' ? 5 : 2;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
