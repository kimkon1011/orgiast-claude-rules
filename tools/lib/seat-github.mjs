import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OWNER = 'kimkon1011';
// 配布正本リポジトリ。origin が「届かない URL」になったときの向け替え先（PC004 実害 2026-11-05）。
export const RULES_ORIGIN_URL = `https://github.com/${OWNER}/orgiast-claude-rules.git`;
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
// git 呼び出しを非対話にする（GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never）。
// 認証プロンプトや Credential Manager ダイアログで処理が停止しないようにする。
export function nonInteractiveGitEnv(extra = {}) {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...extra };
}
// repoDir 内で git を実行する runner。access-doctor / setup.mjs が共用する。
export function makeRepoRun(repoDir) {
  return (file, args) => command(file, ['-C', repoDir, ...args], repoDir, { env: nonInteractiveGitEnv() });
}
// ls-remote 等の git 失敗を、修復対象（届かない URL）と対象外（認証・ネットワーク断）に分ける。
export function originFailureKind(error) {
  const stderr = String(error?.stderr ?? '') || String(error?.message ?? '');
  if (/could not read Username|authentication failed|permission denied|publickey|terminal prompts disabled/i.test(stderr)) return 'auth';
  if (/Repository not found|repository '[^']*' not found|does not appear to be a git repository/i.test(stderr)) return 'not-found';
  return 'network';
}
// リポジトリ origin の到達性。kind: ok / not-found / auth / network / no-repo。
export function originReachability({ repoDir, run = makeRepoRun(repoDir) }) {
  let originUrl;
  try { originUrl = String(run('git', ['remote', 'get-url', 'origin'])).trim(); }
  catch { return { kind: 'no-repo' }; }
  try { run('git', ['ls-remote', 'origin', 'HEAD']); return { kind: 'ok', originUrl }; }
  catch (error) { return { kind: originFailureKind(error), originUrl }; }
}
function sharesHistory(run, ref, probe) {
  // ローカル側の ref が正しいリポジトリの履歴に含まれる（またはその逆＝ローカルだけ進んでいる）なら同一系。
  try { run('git', ['merge-base', '--is-ancestor', ref, probe]); return true; } catch { /* 続けて逆方向を見る */ }
  try { run('git', ['merge-base', '--is-ancestor', probe, ref]); return true; } catch { return false; }
}
// origin が「届かない URL」になっていたら、履歴が一致するときに限り正しいリポジトリへ向け替える。
// 条件: (a) git ls-remote origin HEAD が not-found、または未認証で認証エラーに見える auth で失敗
//       (b) 正しい URL への ls-remote が通る (c) ローカル HEAD か origin/main が正しいリポジトリの履歴に含まれる
// GitHub は未認証の相手に存在しない／見えないリポジトリを認証エラーとして返すため、auth と not-found は区別できない
// （PC004 実測: "could not read Username ... terminal prompts disabled"）。ネットワーク断・履歴不一致では
// 向け替えない（(b) が失敗する・別リポジトリを誤って指さない）。
export function repairUnreachableOrigin({ repoDir, home = os.homedir(), run = makeRepoRun(repoDir), log = appendOriginRepairLog }) {
  const state = originReachability({ repoDir, run });
  if (state.kind === 'ok') return { ...state, repaired: false };
  if (state.kind !== 'not-found' && state.kind !== 'auth') return { ...state, repaired: false };
  // (b) 正しい URL が届く
  let correctHead = '';
  try { correctHead = String(run('git', ['ls-remote', RULES_ORIGIN_URL, 'HEAD'])).trim().split(/\s+/)[0] || ''; }
  catch { return { kind: 'correct-url-unreachable', repaired: false, originUrl: state.originUrl }; }
  if (!/^[0-9a-f]{40}$/i.test(correctHead)) return { kind: 'correct-url-unreachable', repaired: false, originUrl: state.originUrl };
  // (c) fetch してローカル履歴との一致を確認。未確認のまま向け替えない。
  const probe = 'refs/remotes/nightly-origin-probe/rules';
  try { run('git', ['fetch', RULES_ORIGIN_URL, `HEAD:${probe}`]); }
  catch { return { kind: 'fetch-failed', repaired: false, originUrl: state.originUrl }; }
  const related = ['HEAD', 'refs/remotes/origin/main']
    .filter(ref => { try { run('git', ['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; } })
    .some(ref => sharesHistory(run, ref, probe));
  try { run('git', ['update-ref', '-d', probe]); } catch { /* 後始末の失敗で向け替えは止めない */ }
  if (!related) return { kind: 'unrelated-history', repaired: false, originUrl: state.originUrl };
  run('git', ['remote', 'set-url', 'origin', RULES_ORIGIN_URL]);
  if (String(run('git', ['remote', 'get-url', 'origin'])).trim() !== RULES_ORIGIN_URL) throw new Error('origin の read-back 不一致');
  log({ home, repoDir, oldUrl: state.originUrl, newUrl: RULES_ORIGIN_URL });
  return { kind: 'ok', repaired: true, originUrl: state.originUrl };
}
// 向け替えの証跡を ~/.claude/logs/access-doctor-origin-repair.jsonl へ追記する（旧URLと時刻）。
export function appendOriginRepairLog({ home, oldUrl, newUrl, repoDir, at = new Date().toISOString() }) {
  const dir = path.join(home, '.claude', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'access-doctor-origin-repair.jsonl'),
    `${JSON.stringify({ repairedAt: at, repoDir, oldUrl, newUrl })}\n`, 'utf8');
}
