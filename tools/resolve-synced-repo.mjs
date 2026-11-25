// 定時タスクが「どのリポジトリを実行するか」を解決する。resolve-synced-repo.ps1 の JS 版で、
// 解決順序・fallback 条件・警告方針をあちらと一致させてある（片方だけ直すと差が再発する）。
//
// nightly-bootstrap.ps1 が同期しているのは $HOME\.claude\nightly-repo だけ。register-* が
// 「自分の置き場所」をタスクに焼き込むと、誰も同期していないコピーの古いコードを毎日
// 実行し続ける（2026-09-16 に4タスクで実害。bootstrap のログは別ディレクトリについて
// 正しく ok: を出し続けていたので、失敗は最後まで無音だった）。
// 同期先がそのタスクを実行できない時だけ実行ツリーへ戻り、その時は必ず警告を出す。
// 無言 fallback はこの不具合と同型なので入れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function normalizeRoot(target) {
  if (!target) return '';
  return path.resolve(String(target)).replace(/[\\/]+$/, '');
}

function defaultHome(env) {
  return env.ORGIAST_HOME || env.USERPROFILE || os.homedir();
}

// repair-task-paths.ps1 の Get-SyncedRepo / resolve-synced-repo.ps1 の Get-SyncedRepoRoot と同順。
export function getSyncedRepoRoot({ env = process.env } = {}) {
  if (env.ORGIAST_NIGHTLY_REPO) return normalizeRoot(env.ORGIAST_NIGHTLY_REPO);
  return normalizeRoot(path.join(defaultHome(env), '.claude', 'nightly-repo'));
}

// fallback: 呼び出し側が本来使っていたリポジトリルート（自分の置き場所）。
// requiredPaths: 登録するタスクが実際に実行する、リポジトリ相対のパス。
//   同期先にそれが無いまま指すと「古いタスク」が「壊れたタスク」になるだけなので確認する。
export function resolveRegisterRepoRoot({
  fallback,
  requiredPaths = [],
  env = process.env,
  exists = (target) => fs.existsSync(target),
  warn = (message) => console.warn(message),
} = {}) {
  if (!fallback) throw new Error('resolveRegisterRepoRoot: fallback は必須です');
  const fallbackRoot = normalizeRoot(fallback);
  const synced = getSyncedRepoRoot({ env });
  if (synced.toLowerCase() === fallbackRoot.toLowerCase()) return synced;
  if (!exists(synced)) {
    warn(`[resolve-synced-repo] 同期先 '${synced}' が見つかりません。'${fallbackRoot}' に対して登録します。このツリーは誰も更新しないため、タスクは古いコードを実行し続けます。`);
    return fallbackRoot;
  }
  for (const relative of requiredPaths) {
    if (!relative) continue;
    if (!exists(path.join(synced, relative))) {
      warn(`[resolve-synced-repo] '${relative}' が同期先 '${synced}' にありません。'${fallbackRoot}' に対して登録します。main にマージして nightly-bootstrap の同期を待ってから登録し直してください。`);
      return fallbackRoot;
    }
  }
  return synced;
}

// tools ディレクトリを直接扱う呼び出し側向け。fallback は tools ディレクトリそのもの。
export function resolveRegisterToolsDir({ fallback, requiredLeaves = [], ...rest } = {}) {
  if (!fallback) throw new Error('resolveRegisterToolsDir: fallback は必須です');
  const fallbackDir = normalizeRoot(fallback);
  const fallbackRoot = normalizeRoot(path.dirname(fallbackDir));
  const requiredPaths = requiredLeaves.filter(Boolean).map((leaf) => path.join('tools', leaf));
  const root = resolveRegisterRepoRoot({ fallback: fallbackRoot, requiredPaths, ...rest });
  if (root.toLowerCase() === fallbackRoot.toLowerCase()) return fallbackDir;
  return path.join(root, 'tools');
}
