#!/usr/bin/env node
/** 日報専用クローンへの配信。作業ブランチには一切触れない。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { clearStaleIndexLock } from './fleet-directive-send.mjs';
import { HUB_ID, FOLDER_NAME } from './portable-knowhow-push.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { findOrCreateFolder, listFiles, uploadFileContent } from './lib/drive-files.mjs';
import { reportLocations } from './lib/claude-pace-report-core.mjs';

const REPO = 'kimkon1011/orgiast-claude-rules';

/** @returns {{jsonPath:string, mdPath:string, latestPath:string}} */
export function reportPaths(dateJst) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateJst) || new Date(`${dateJst}T00:00:00Z`).toISOString().slice(0, 10) !== dateJst) throw new Error('invalid report date');
  const base = 'reports/claude-pace';
  return { jsonPath: `${base}/${dateJst}.json`, mdPath: `${base}/${dateJst}.md`, latestPath: `${base}/latest.json` };
}

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 120_000 });
  if (result.error || result.status !== 0) {
    // 診断全文には認証URL等が混じり得るので外へ持ち出さない。
    const rejected = /protected branch|GH006|GH013|non-fast-forward|fetch first|repository rule|changes must be made through a pull request/i.test(`${result.stderr}\n${result.stdout}`);
    const error = new Error(`${executable} ${args[0]} failed (exit ${result.status ?? 'unknown'})`);
    error.pushRejected = executable === 'git' && args[0] === 'push' && rejected;
    throw error;
  }
  return String(result.stdout || '').trim();
}

/**
 * @param {{report: {markdown:string,json:object}, dryRun?:boolean, home?:string}} options
 * run / driveFiles を注入でき、テストでは実サービスを呼ばない。
 */
export async function publishReport({ report, dryRun = false, home = process.env.ORGIAST_HOME || os.homedir(),
  run = command, print = console.log, getToken = getDriveToken,
  driveFiles = { findOrCreateFolder, listFiles, uploadFileContent }, clearLock = clearStaleIndexLock } = {}) {
  const date = report.json.date;
  const paths = reportPaths(date);
  const jsonText = `${JSON.stringify(report.json, null, 2)}\n`;
  let markdown = report.markdown;
  const files = () => ({ [paths.jsonPath]: jsonText, [paths.mdPath]: markdown, [paths.latestPath]: jsonText });
  // 最初に分岐し、ディレクトリ作成・認証・clone さえしない。
  if (dryRun) {
    for (const [file, body] of Object.entries(files())) print(`[dry-run] ${file}\n${body}`);
    return { dryRun: true, paths, files: files(), markdown, fallback: false, driveError: null };
  }
  let driveError = null, driveUrl = `https://drive.google.com/drive/folders/${HUB_ID}`;
  let token, folder, existing;
  try {
    token = await getToken();
    const parent = await driveFiles.findOrCreateFolder(token, FOLDER_NAME, HUB_ID);
    if (!parent?.id) throw new Error('missing folder');
    folder = await driveFiles.findOrCreateFolder(token, 'claude-pace', parent.id);
    if (!folder?.id) throw new Error('missing folder');
    driveUrl = `https://drive.google.com/drive/folders/${folder.id}`;
    existing = await driveFiles.listFiles(token, folder.id);
  } catch { driveError = 'Drive 接続またはフォルダ取得失敗（認証・GWS 経路を確認）'; }

  const dir = path.resolve(home, '.claude', 'claude-pace-reports-repo');
  // reset 対象は固定の専用クローンだけ。symlink/junction の別作業場は拒否する。
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('dedicated clone must not be a symlink');
  const git = (args) => run('git', args, dir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    run('git', ['clone', '--branch', 'main', '--single-branch', `https://github.com/${REPO}.git`, dir], path.dirname(dir));
  } else {
    const top = git(['rev-parse', '--show-toplevel']);
    if (path.resolve(top).toLowerCase() !== dir.toLowerCase()) throw new Error('dedicated clone root mismatch');
    const remote = git(['remote', 'get-url', 'origin']);
    if (!/^https:\/\/github\.com\/kimkon1011\/orgiast-claude-rules(?:\.git)?\/?$/.test(remote)) throw new Error('dedicated clone origin mismatch');
    clearLock(dir);
    git(['fetch', 'origin', 'main']);
    git(['reset', '--hard', 'origin/main']);
    git(['checkout', '-B', 'main', 'origin/main']);
  }
  let fallback = false, prUrl = null;
  const branch = `report/claude-pace-${date}`;
  const refreshMarkdown = () => {
    const body = report.markdown.split('\n## 置き場所')[0].trimEnd();
    markdown = `${body}\n\n## 配信結果\n- リポジトリ: ${fallback ? `main への push 拒否 → ${branch} の PR / auto-merge にフォールバック（マージ待ちの間 main URL は未更新）` : 'main へ配信'}\n- driveError: ${driveError || 'なし'}\n\n${reportLocations(date, driveUrl)}`;
  };
  const commit = () => {
    refreshMarkdown();
    for (const [file, body] of Object.entries(files())) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, 'utf8');
    }
    git(['add', '--', ...Object.values(paths)]);
    if (!git(['diff', '--cached', '--name-only', '--', ...Object.values(paths)])) return;
    git(['-c', 'user.name=Claude Pace Report', '-c', 'user.email=claude-pace-report@localhost',
      'commit', '--only', '-m', `report: Claude pace ${date}`, '--', ...Object.values(paths)]);
  };
  const push = () => {
    commit();
    try { git(['push', 'origin', fallback ? `HEAD:${branch}` : 'main']); }
    catch (error) {
      if (fallback || !error.pushRejected) throw error;
      fallback = true;
      git(['fetch', 'origin', 'main']);
      git(['checkout', '-B', branch, 'origin/main']);
      // 前回の同日PRがあれば、その先端から更新する（force push 不要）。
      if (git(['ls-remote', '--heads', 'origin', branch])) {
        git(['fetch', 'origin', branch]);
        git(['reset', '--hard', 'FETCH_HEAD']);
      }
      commit();
      git(['push', '-u', 'origin', `HEAD:${branch}`]);
      const prs = JSON.parse(run('gh', ['pr', 'list', '--repo', REPO, '--head', branch, '--base', 'main', '--state', 'open', '--json', 'url'], dir));
      prUrl = prs[0]?.url || run('gh', ['pr', 'create', '--repo', REPO, '--base', 'main', '--head', branch,
        '--title', `report: Claude pace ${date}`, '--body', '日次台帳の自動更新。main への直接 push が拒否されたため PR で配信。',
        '--label', 'automerge'], dir);
      run('gh', ['pr', 'merge', prUrl, '--repo', REPO, '--auto', '--squash'], dir);
    }
  };
  push();
  if (!driveError) {
    try {
      for (const name of [`claude-pace-${date}.md`, 'latest.md']) {
        await driveFiles.uploadFileContent(token, { fileId: existing.find((f) => (f.name || f.title) === name)?.id,
          name, parentId: folder.id, content: markdown, mimeType: 'text/markdown', contentType: 'text/markdown; charset=utf-8' });
      }
    } catch {
      driveError = 'Drive markdown 書込失敗（日付分または latest.md が未反映）';
      push(); // 失敗をリポジトリの日報と通知にも残し、処理は続ける。
    }
  }
  return { paths, markdown, fallback, prUrl, driveError, driveUrl };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const build = io.buildDailyReport ?? (() => {
    const output = command(process.execPath, [path.join(import.meta.dirname, 'claude-pace-report.mjs'), '--dry-run', '--json-output'], import.meta.dirname);
    return JSON.parse(output);
  });
  const report = await build();
  return publishReport({ report, dryRun: argv.includes('--dry-run') });
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
