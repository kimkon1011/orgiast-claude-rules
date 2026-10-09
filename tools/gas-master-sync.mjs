import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BOOTH_SCRIPT = '1aYHQBPvVdw8CvdLZS1-C23R6dSSZB_8B51UqFxMpRiQunTLDdAUqq-pB';
export const BOOTH_REPO = 'kimkon1011/booth-production-app';
export const spawnCommand = (command, args, options = {}) => spawnSync(command, args, {
  shell: false, windowsHide: true, encoding: 'utf8', timeout: 120_000,
  maxBuffer: 32 * 1024 * 1024, ...options,
});
export function checked(spawn, command, args, cwd) {
  const r = spawn(command, args, { cwd, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`${command} ${args[0]}: ${r.error?.message || r.stderr || r.status}`);
  return String(r.stdout || '').trim();
}

// Compare only GAS source: local tests and clasp configuration are not deployed.
// clasp versions use either .gs or .js for server source.
export function gasFiles(root, prefix = '') {
  const files = new Map();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlink は同期できません: ${rel}`);
    if (entry.isDirectory()) {
      for (const pair of gasFiles(path.join(root, entry.name), rel + '/')) files.set(...pair);
    } else if ((/\.(?:gs|js|html)$/.test(rel) && !/\.(?:test|spec)\.js$/.test(rel)) || rel === 'appsscript.json') {
      const key = rel.replace(/\.gs$/, '.js');
      if (files.has(key)) throw new Error(`GAS ファイル名重複: ${key}`);
      files.set(key, { relative: rel, text: fs.readFileSync(path.join(root, entry.name), 'utf8').replace(/\r\n/g, '\n') });
    }
  }
  return files;
}
export function assertGasEqual(left, right) {
  const a = gasFiles(left), b = gasFiles(right);
  if (a.size !== b.size || [...a].some(([k, v]) => b.get(k)?.text !== v.text)) throw new Error('本番 pull と同期対象 src に差分があります');
}

export function syncGasMaster({ project, snapshot, dryRun = false }, {
  spawn = spawnCommand, stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s),
} = {}) {
  if (dryRun) {
    stdout('dry-run: 本番 read-back → 隔離 clone の src を commit → git push origin HEAD → git push origin HEAD:master（ff 不可なら PR）\n');
    return { status: 'dry-run' };
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-master-sync-'));
  const cwd = path.join(temp, 'repo');
  const git = (...args) => checked(spawn, 'git', args, cwd);
  try {
    const origin = checked(spawn, 'git', ['remote', 'get-url', 'origin'], project);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)kimkon1011\/booth-production-app(?:\.git)?$/.test(origin)) throw new Error('制作アプリの origin が一致しません');
    const head = checked(spawn, 'git', ['rev-parse', 'HEAD'], project);
    checked(spawn, 'git', ['clone', '--no-local', '--no-checkout', project, cwd], temp);
    git('remote', 'set-url', 'origin', origin);
    // clone does not inherit repository-local author settings.
    for (const key of ['user.name', 'user.email']) {
      const value = checked(spawn, 'git', ['config', '--get', key], project);
      if (!value) throw new Error(`Git author 設定がありません: ${key}`);
      git('config', key, value);
    }
    const branch = `gas-sync/${Date.now()}-${path.basename(temp)}`;
    git('checkout', '-b', branch, head);
    const target = path.join(cwd, 'src');
    fs.mkdirSync(target, { recursive: true });
    const source = gasFiles(snapshot), existing = gasFiles(target);
    if (!source.has('appsscript.json')) throw new Error('本番 snapshot に appsscript.json がありません');
    for (const [key, file] of existing) if (!source.has(key)) fs.unlinkSync(path.join(target, file.relative));
    for (const [key, file] of source) {
      const dest = path.join(target, existing.get(key)?.relative || file.relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.text);
    }
    assertGasEqual(snapshot, target);
    git('add', '-A', '--', 'src');
    const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
    if (staged.some(file => !file.startsWith('src/'))) throw new Error('src 外の staged 変更を検知');
    if (staged.length) git('commit', '-m', 'fix(gas): 本番 read-back を GitHub に同期\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>');
    git('push', 'origin', 'HEAD');
    git('fetch', 'origin', 'master');
    const ff = spawn('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], { cwd, windowsHide: true });
    if (ff.error || ![0, 1].includes(ff.status)) throw new Error('master の fast-forward 判定に失敗');
    if (ff.status === 0) {
      const pushed = spawn('git', ['push', 'origin', 'HEAD:master'], { cwd, windowsHide: true });
      if (!pushed.error && pushed.status === 0) return { status: 'pushed', branch };
      // Re-fetch to distinguish a concurrent master advance from auth/network failure.
      git('fetch', 'origin', 'master');
      const retry = spawn('git', ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], { cwd, windowsHide: true });
      if (retry.error || retry.status !== 1) throw new Error(`master push 失敗: ${pushed.error?.message || pushed.stderr || pushed.status}`);
    }
    const body = path.join(temp, 'pr.md');
    fs.writeFileSync(body, '本番 GAS への push と read-back は成功しました。master が先行しているため、本番スナップショットを PR で統合します。\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n');
    const url = checked(spawn, 'gh', ['pr', 'create', '--repo', BOOTH_REPO, '--base', 'master', '--head', branch, '--title', 'fix(gas): 本番 GAS の変更を master に同期', '--body-file', body], cwd);
    stderr('master が先行。PR で統合\n');
    stdout(`${url}\n`);
    return { status: 'pr', url, branch };
  } catch (error) {
    stderr(`GitHub 同期失敗（clasp push の結果は維持）: ${error.message}\n`);
    return { status: 'failed', error: error.message };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
