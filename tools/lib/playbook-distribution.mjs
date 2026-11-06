import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const normalizeNewlines = (value) => value.replace(/\r\n/g, '\n');

function isCommittedPlaybookVersion(repo, relativePath, content) {
  try {
    const commits = execFileSync('git', ['-C', repo, 'log', '--format=%H', '--follow', '--', relativePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .split(/\r?\n/)
      .filter(Boolean);
    return commits.some(commit => {
      try {
        const committed = execFileSync('git', ['-C', repo, 'show', `${commit}:${relativePath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        return normalizeNewlines(committed) === normalizeNewlines(content);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// 各PCで追記した実測は保持し、未編集の古い配布版だけを最新版へ更新する。
export function distributePlaybooks(repo, home) {
  const source = path.join(repo, 'playbooks'), target = path.join(home, '.claude', 'playbooks');
  if (!fs.existsSync(source)) return 0;
  fs.mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const sourceFile = path.join(source, entry.name), targetFile = path.join(target, entry.name);
    try { fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL); copied++; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = fs.readFileSync(sourceFile, 'utf8'), installed = fs.readFileSync(targetFile, 'utf8');
      if (normalizeNewlines(current) === normalizeNewlines(installed)) continue;
      const relativePath = path.posix.join('playbooks', entry.name);
      if (isCommittedPlaybookVersion(repo, relativePath, installed)) {
        fs.copyFileSync(sourceFile, targetFile);
        copied++;
      }
    }
  }
  return copied;
}
