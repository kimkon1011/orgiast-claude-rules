#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { command, OWNER, pages } from './lib/seat-github.mjs';

export function trustedInvitation(invite) {
  return invite?.inviter?.login === OWNER && invite?.repository?.owner?.login === OWNER
    && Number.isSafeInteger(invite.id) && invite.id > 0;
}
export function acceptInvites({ home = process.env.ORGIAST_HOME || os.homedir(), dryRun = false, daily = false,
  run = command, out = console.log, now = Date.now } = {}) {
  if (!isKimOperated(home)) { out('招待: kim 操作席ではないためスキップ'); return { skipped: true }; }
  const stamp = path.join(home, '.claude', 'gh-accept-invites.daily');
  let claimed = false;
  if (daily && !dryRun) {
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    try {
      const age = now() - fs.statSync(stamp).mtimeMs;
      const completed = fs.readFileSync(stamp, 'utf8') === 'done';
      // hookの親プロセスがタイムアウトした場合は24時間止めず2分後に再試行。
      if (age > -60_000 && age < (completed ? 86400000 : 120000)) {
        out(completed ? '招待: 本日は確認済み' : '招待: 別セッションで確認中'); return { skipped: true };
      }
      fs.unlinkSync(stamp);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.writeFileSync(stamp, '', { flag: 'wx' }); claimed = true; }
    catch (error) { if (error.code === 'EEXIST') return { skipped: true }; throw error; }
  }
  try {
    run('gh', ['auth', 'status']);
    const invites = pages(run, 'user/repository_invitations?per_page=100');
    let accepted = 0, failed = 0;
    for (const invite of invites) {
      const name = invite.repository?.full_name || '(名前不明)';
      if (!trustedInvitation(invite)) { out(`招待: 対象外 ${name}`); continue; }
      if (dryRun) { out(`招待: 承諾予定 ${name}`); continue; }
      try {
        run('gh', ['api', '--method', 'PATCH', `user/repository_invitations/${invite.id}`]);
        accepted++; out(`招待: 承諾 ${name}`);
      } catch { failed++; out(`招待: 承諾失敗 ${name}（node tools/gh-accept-invites.mjs で再試行）`); }
    }
    if (!invites.length) out('招待: 保留なし');
    if (claimed) {
      if (failed) fs.unlinkSync(stamp);
      else fs.writeFileSync(stamp, 'done');
    }
    return { invites, accepted, failed };
  } catch {
    if (claimed) { try { fs.unlinkSync(stamp); } catch {} }
    out('招待: gh 未インストール・未ログイン、または GitHub 接続失敗。gh --version / gh auth status で確認');
    return { unavailable: true };
  }
}
export function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.some(arg => !['--dry-run', '--daily'].includes(arg))) return 2;
  try { acceptInvites({ ...deps, dryRun: argv.includes('--dry-run'), daily: argv.includes('--daily') }); }
  catch { (deps.out || console.log)('招待: ローカル状態を保存できないためスキップ'); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = main();
