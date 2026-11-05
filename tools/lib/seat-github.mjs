import { execFileSync } from 'node:child_process';

export const OWNER = 'kimkon1011';
export function command(file, args, cwd = process.cwd(), options = {}) {
  return String(execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options })).trim();
}
export function api(run, endpoint) {
  return JSON.parse(run('gh', ['api', endpoint]));
}
export function pages(run, endpoint) {
  const result = JSON.parse(run('gh', ['api', '--paginate', '--slurp', endpoint]));
  if (!Array.isArray(result) || result.some(page => !Array.isArray(page))) throw new Error('GitHub の一覧を取得できません');
  return result.flat();
}
export function githubRepo(url) {
  const match = String(url).trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}
export function repositoryTarget(run) {
  const originUrl = run('git', ['remote', 'get-url', 'origin']);
  const origin = githubRepo(originUrl);
  if (!origin) throw new Error('origin は GitHub リポジトリではありません');
  const info = api(run, `repos/${origin}`);
  let base = info;
  if (info.owner?.login?.toLowerCase() !== OWNER) {
    let upstream;
    try { upstream = githubRepo(run('git', ['remote', 'get-url', 'upstream'])); } catch { /* source API below */ }
    const sources = [info.parent, info.source].filter(item => item?.owner?.login?.toLowerCase() === OWNER);
    const source = sources.find(item => item.full_name === upstream) || sources[0];
    // 明示 upstream は GitHub の fork メタデータがない移行済み clone でも使える。
    // 同名だけでは推測しない。upstream がないときは GitHub の親リポ確認が必須。
    const explicit = upstream?.startsWith(`${OWNER}/`) && upstream.split('/')[1] === origin.split('/')[1] ? upstream : null;
    const destination = source?.full_name || explicit;
    if (!destination) throw new Error('kimkon1011 の upstream / fork 関係を確認できません');
    base = api(run, `repos/${destination}`);
  }
  if (base.owner?.login?.toLowerCase() !== OWNER || !base.full_name?.startsWith(`${OWNER}/`)) throw new Error('base 所有者が不一致です');
  return { origin, originUrl, base: base.full_name, url: `https://github.com/${base.full_name}.git`,
    push: base.permissions?.push === true, fork: origin.toLowerCase() !== base.full_name.toLowerCase(), defaultBranch: base.default_branch || 'main' };
}
export function repairOrigin(target, run) {
  if (!target.fork || !target.push) return false;
  // 別の fork リモートや明示 pushurl を上書きしない。
  let existing;
  try { existing = run('git', ['remote', 'get-url', 'fork']); } catch { /* absent */ }
  if (existing && githubRepo(existing) !== target.origin) throw new Error('fork リモートが別リポジトリを指しています。git remote rename fork saved-fork で保存して再実行');
  let pushUrl;
  try { pushUrl = run('git', ['config', '--get-all', 'remote.origin.pushurl']); } catch { /* absent */ }
  if (pushUrl) throw new Error('origin に pushurl があります。git config --unset-all remote.origin.pushurl 後に再実行');
  if (!existing) run('git', ['remote', 'add', 'fork', target.originUrl]);
  run('git', ['remote', 'set-url', 'origin', target.url]);
  if (githubRepo(run('git', ['remote', 'get-url', 'origin'])) !== target.base) throw new Error('origin の read-back 不一致');
  return true;
}
