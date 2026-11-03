#!/usr/bin/env node
// 保有機材 STL 23 件を Drive から取得してキャッシュする（STL は Git に入れない）。
// 使い方: node tools/booth-3d/fetch-stl.mjs [--out <dir>]    既定の出力先 ~/.claude/booth-3d/stl
// 認証: サービスアカウント鍵 + ドメイン全体委任(DWD)。
//   BOOTH3D_SA_KEY   鍵 JSON のパス（既定 ~/.claude/keys/aujust-sheets-reader.json）
//   BOOTH3D_DWD_SUB  委任先ユーザー（既定 seisaku-team@orgiast.jp。STL はこのアカウントの権限でだけ見える）
// 既存ファイルが Drive の size と一致すれば再取得しない。鍵の中身はログに出さない。
import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isEntry } from '../is-entry.mjs';
import { loadSources } from './asset-naming.mjs';

const SCOPE = 'https://www.googleapis.com/auth/drive';

export function defaultOutDir(home = homedir()) {
  return path.join(home, '.claude', 'booth-3d', 'stl');
}

export function parseArgs(argv) {
  const opts = { out: defaultOutDir() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { opts.out = path.resolve(argv[i + 1] ?? ''); i += 1; }
    else throw new Error(`unknown option: ${argv[i]}\n使い方: node tools/booth-3d/fetch-stl.mjs [--out <dir>]`);
  }
  return opts;
}

export function buildAssertion(key, sub, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, sub, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')}`;
}

async function accessToken(env) {
  const keyPath = env.BOOTH3D_SA_KEY || path.join(homedir(), '.claude', 'keys', 'aujust-sheets-reader.json');
  const sub = env.BOOTH3D_DWD_SUB || 'seisaku-team@orgiast.jp';
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${buildAssertion(key, sub)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json();
  if (!json.access_token) throw new Error(`トークン取得失敗(sub=${sub}): ${json.error ?? res.status} ${json.error_description ?? ''}`);
  return json.access_token;
}

export async function fetchAll({ out, env = process.env, log = console.log } = {}) {
  mkdirSync(out, { recursive: true });
  const headers = { authorization: `Bearer ${await accessToken(env)}` };
  const results = [];
  for (const src of loadSources()) {
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${src.id}?fields=id,name,size&supportsAllDrives=true`, { headers });
    const meta = await metaRes.json();
    if (!metaRes.ok || !meta.size) throw new Error(`Drive メタ取得失敗 ${src.name}: ${metaRes.status} ${meta.error?.message ?? ''}`);
    const driveSize = Number(meta.size);
    const dest = path.join(out, src.name);
    let status = 'skip';
    if (!(existsSync(dest) && statSync(dest).size === driveSize)) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${src.id}?alt=media&supportsAllDrives=true`, { headers });
      if (!res.ok) throw new Error(`ダウンロード失敗 ${src.name}: ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      status = 'download';
    }
    const localSize = statSync(dest).size;
    if (localSize !== driveSize) throw new Error(`サイズ不一致 ${src.name}: local=${localSize} drive=${driveSize}`);
    results.push({ name: src.name, status, size: localSize, driveSize });
    log(`${status.padEnd(8)} ${String(localSize).padStart(9)}B  ${src.name}`);
  }
  const totalLocal = results.reduce((s, r) => s + r.size, 0);
  const totalDrive = results.reduce((s, r) => s + r.driveSize, 0);
  log(`files=${results.length} downloaded=${results.filter((r) => r.status === 'download').length} skipped=${results.filter((r) => r.status === 'skip').length} totalLocal=${totalLocal} totalDrive=${totalDrive} match=${totalLocal === totalDrive}`);
  return { results, totalLocal, totalDrive };
}

if (isEntry(import.meta.url)) {
  try {
    const { out } = parseArgs(process.argv.slice(2));
    const { totalLocal, totalDrive } = await fetchAll({ out });
    if (totalLocal !== totalDrive) process.exitCode = 1;
  } catch (err) {
    console.error(`fetch-stl: ${err.message}`);
    process.exitCode = 1;
  }
}
