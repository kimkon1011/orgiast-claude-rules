import crypto from 'node:crypto';

const MAGIC = 'ORGLOCK1';
const ALG = 'A256GCM+RSA-OAEP-256';
const aad = env => Buffer.from(`${MAGIC}|${env.name}|${env.sealedAt}|${env.sha256}`, 'utf8');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function decodeBase64url(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('不正な base64url');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) {
    throw new Error('不正な base64url 長');
  }
  return bytes;
}

export function sealText(plaintext, { name, publicKeyPem, kid = 'k1', now = Date.now() }) {
  if (typeof plaintext !== 'string' || typeof name !== 'string' || !name || typeof kid !== 'string' || !kid) {
    throw new Error('封印の引数が不正です');
  }
  const bytes = Buffer.from(plaintext, 'utf8');
  const env = { v: 1, kid, alg: ALG, name, sealedAt: new Date(now).toISOString(), sha256: digest(bytes) };
  const key = crypto.randomBytes(32);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(env));
    const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
    env.wrappedKey = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64url');
    Object.assign(env, { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ct: ct.toString('base64url') });
    return `${MAGIC}\n${JSON.stringify(env)}\n`;
  } finally { key.fill(0); }
}

export function parseSealed(text) {
  if (typeof text !== 'string' || !text.startsWith(`${MAGIC}\n`)) throw new Error('封印ファイルではありません');
  const env = JSON.parse(text.slice(MAGIC.length + 1));
  if (!env || env.v !== 1 || env.alg !== ALG || typeof env.kid !== 'string' || !env.kid
      || typeof env.name !== 'string' || !env.name || typeof env.sealedAt !== 'string'
      || !Number.isFinite(Date.parse(env.sealedAt)) || !/^[a-f0-9]{64}$/.test(env.sha256)) {
    throw new Error('封印形式が不正です');
  }
  if (!decodeBase64url(env.wrappedKey).length) throw new Error('包まれた鍵がありません');
  decodeBase64url(env.iv, 12);
  decodeBase64url(env.tag, 16);
  decodeBase64url(env.ct);
  return env;
}

export function isSealed(text) {
  try { parseSealed(text); return true; } catch { return false; }
}

export function openWithDataKey(env, dataKeyBuf) {
  if (!Buffer.isBuffer(dataKeyBuf) || dataKeyBuf.length !== 32) throw new Error('データ鍵が不正です');
  parseSealed(`${MAGIC}\n${JSON.stringify(env)}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKeyBuf, decodeBase64url(env.iv, 12));
  decipher.setAAD(aad(env));
  decipher.setAuthTag(decodeBase64url(env.tag, 16));
  const plaintext = Buffer.concat([decipher.update(decodeBase64url(env.ct)), decipher.final()]);
  if (digest(plaintext) !== env.sha256) throw new Error('平文ハッシュが一致しません');
  return plaintext.toString('utf8');
}
