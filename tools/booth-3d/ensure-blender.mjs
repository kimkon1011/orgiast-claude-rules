#!/usr/bin/env node
// Blender（ヘッドレス実行用ポータブル版）の場所を 1 行で標準出力に返す。無ければ公式配布から取得して展開する。
//   優先順: 環境変数 BOOTH3D_BLENDER → ~/tools/blender/blender.exe → 無ければ download.blender.org から最新の 5.2.x を取得
// 管理者権限は不要（zip 展開のみ）。Windows x64 専用（配布 zip 名が windows-x64 のため）。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { isEntry } from '../is-entry.mjs';

const RELEASE_INDEX = 'https://download.blender.org/release/Blender5.2/';

export function defaultBlenderPath(home = homedir()) {
  return path.join(home, 'tools', 'blender', 'blender.exe');
}

// ディレクトリ一覧 HTML から最新の blender-5.2.x-windows-x64.zip 名を選ぶ。
export function pickLatestZip(html) {
  const names = [...String(html).matchAll(/href="(blender-5\.2\.(\d+)-windows-x64\.zip)"/g)].map((m) => ({ name: m[1], patch: Number(m[2]) }));
  if (!names.length) return null;
  names.sort((a, b) => b.patch - a.patch);
  return names[0].name;
}

export function blenderVersion(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.status !== 0) return null;
  return String(r.stdout).split(/\r?\n/)[0].trim() || null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ダウンロード失敗 ${res.status}: ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function ensureBlender({ env = process.env, home = homedir(), log = () => {} } = {}) {
  const wanted = env.BOOTH3D_BLENDER || defaultBlenderPath(home);
  if (existsSync(wanted)) {
    const version = blenderVersion(wanted);
    if (!version) throw new Error(`Blender が起動しません: ${wanted}`);
    log(`既存の Blender を使用: ${version}`);
    return wanted;
  }
  if (env.BOOTH3D_BLENDER) throw new Error(`BOOTH3D_BLENDER が指す場所に blender がありません: ${wanted}`);
  if (process.platform !== 'win32') throw new Error('自動取得は Windows x64 のみ対応。BOOTH3D_BLENDER で既存の Blender を指定してください');

  const html = await (await fetch(RELEASE_INDEX)).text();
  const zipName = pickLatestZip(html);
  if (!zipName) throw new Error(`${RELEASE_INDEX} に blender-5.2.x-windows-x64.zip が見つかりません`);
  const work = path.join(tmpdir(), `booth3d-blender-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const zipPath = path.join(work, zipName);
  log(`取得中: ${RELEASE_INDEX}${zipName}`);
  await download(RELEASE_INDEX + zipName, zipPath);
  // Windows 10 以降の tar(bsdtar) は zip を展開できる。
  const x = spawnSync('tar', ['-xf', zipPath, '-C', work], { encoding: 'utf8', windowsHide: true });
  if (x.status !== 0) throw new Error(`zip 展開に失敗: ${x.stderr || x.stdout}`);
  const extracted = readdirSync(work, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith('blender-'));
  if (!extracted) throw new Error('展開結果に blender-* フォルダがありません');
  const target = path.dirname(wanted);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  renameSync(path.join(work, extracted.name), target);
  rmSync(work, { recursive: true, force: true });
  const version = blenderVersion(wanted);
  if (!version) throw new Error(`展開後に Blender が起動しません: ${wanted}`);
  log(`取得・展開完了: ${version}`);
  return wanted;
}

if (isEntry(import.meta.url)) {
  try {
    const exe = await ensureBlender({ log: (m) => console.error(m) });
    console.log(exe);
  } catch (err) {
    console.error(`ensure-blender: ${err.message}`);
    process.exitCode = 1;
  }
}
