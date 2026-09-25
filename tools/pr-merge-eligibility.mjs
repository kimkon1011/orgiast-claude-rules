#!/usr/bin/env node
// PR のマージ可否を「kim に一言伺う」前に gh api で機械判定する。
//
// なぜ必要か: 2026-09-24 の handoff 監査 [handoff-audit:ee77d5457c15c5fc]
// 「PR のマージ可否を kim に一言伺う」の再発防止。可否は次の3つで完全に決まり、
// どれも gh の実測値から取れる（人の判断は要らない）。
//   1. `automerge` ラベルが付いているか
//   2. 変更ファイルに安全弁パス（.github/workflows/* / *keyserve* / *secrets* / *.env*）が含まれるか
//   3. `auto_merge`（auto-merge の予約）が入っているか
//
// 注意: Auto merge ワークフローのジョブは eligible=false でも success 表示になる。
// 「ジョブが pass した＝自動マージが有効」と読み替えると PR が OPEN のまま残るので、
// 判定は必ず `auto_merge` フィールドと変更ファイルの実測で行う（docs/pr-merge-eligibility-route.md）。
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const USAGE = '使い方: node tools/pr-merge-eligibility.mjs --repo <owner/name> [--json]';

// auto-merge.yml の case 文と同じ4パターン。
// bash の case は `/` も `*` に食われるので、パス全体に対する部分一致で判定する。
export function firstGuardedPath(files) {
  for (const file of files) {
    const path = typeof file === 'string' ? file : file?.path;
    if (typeof path !== 'string' || path === '') continue;
    if (path.startsWith('.github/workflows/')) return path;
    if (path.includes('keyserve')) return path;
    if (path.includes('secrets')) return path;
    if (path.includes('.env')) return path;
  }
  return null;
}

export function hasLabel(pr, name) {
  return (pr.labels ?? []).some((label) => (typeof label === 'string' ? label : label?.name) === name);
}

// 1件の PR を判定する。collaborator が undefined のときは作者権限を未照会として扱う。
export function evaluatePr(pr, { repo, collaborators } = {}) {
  const owner = String(repo ?? '').split('/')[0];
  const headOwner = pr.headRepositoryOwner?.login ?? null;
  const files = pr.files ?? [];
  const notes = [];

  const isFork = headOwner !== null && owner !== '' && headOwner !== owner;
  const guarded = firstGuardedPath(files);
  const labeled = hasLabel(pr, 'automerge');
  const checks = pr.mergeStateStatus ?? 'UNKNOWN';
  const queued = Boolean(pr.autoMergeRequest);

  if (checks === 'DIRTY') notes.push('conflicts: main と衝突している（先に解消が必要）');
  if (checks === 'BLOCKED') notes.push('blocked: ブランチ保護か必須チェックで止まっている（gh pr checks で実測）');
  if (Array.isArray(collaborators) && !collaborators.includes(pr.author?.login)) {
    notes.push(`author: ${pr.author?.login ?? '?'} は collaborator ではない`);
  }

  let verdict;
  let action;
  if (queued) {
    verdict = 'auto_merge_enabled';
    action = '待つのみ。マージは GitHub が実行する（kim に聞かない）';
  } else if ((pr.isDraft ?? pr.draft) === true) {
    verdict = 'ineligible_draft';
    action = 'draft を解除しない限り自動マージ対象外';
  } else if (isFork) {
    verdict = 'ineligible_fork';
    action = `head が fork（${headOwner}）のため自動マージ対象外`;
  } else if (labeled && Array.isArray(collaborators) && !collaborators.includes(pr.author?.login)) {
    verdict = 'ineligible_author';
    action = '作者が collaborator でないため自動マージ対象外';
  } else if (guarded !== null) {
    verdict = 'manual_merge_required';
    action = `安全弁（${guarded}）に該当。人（kim）の手動マージ1回が必要＝可否を聞く必要はない`;
  } else if (!labeled) {
    verdict = 'missing_label';
    action = `gh pr edit ${pr.number} --repo ${repo} --add-label automerge`;
  } else {
    verdict = 'pending_auto_merge';
    action = 'ラベル済み・安全弁なし・auto_merge 未設定。ワークフロー実行を gh api で確認する';
  }

  return {
    number: pr.number,
    title: pr.title ?? '',
    verdict,
    action,
    guarded,
    labeled,
    mergeStateStatus: checks,
    autoMergeQueued: queued,
    notes,
  };
}

export function evaluateAll(state) {
  const items = (state.prs ?? []).map((pr) => evaluatePr(pr, { repo: state.repo, collaborators: state.collaborators }));
  const counts = {};
  for (const item of items) counts[item.verdict] = (counts[item.verdict] ?? 0) + 1;
  return { repo: state.repo, asOf: state.asOf ?? null, counts, items };
}

export function renderText(report) {
  const lines = [`PR マージ可否（gh api 実測・${report.repo}）`];
  if (report.asOf) lines.push(`基準時刻: ${report.asOf}`);
  const order = Object.keys(report.counts).sort();
  lines.push(`open ${report.items.length} 件: ${order.map((key) => `${key}=${report.counts[key]}`).join(' / ')}`, '');
  for (const item of report.items) {
    lines.push(`#${item.number} ${item.verdict} (${item.mergeStateStatus}${item.autoMergeQueued ? ', auto-merge 予約済み' : ''}) ${item.title}`);
    lines.push(`  → ${item.action}`);
    for (const note of item.notes) lines.push(`  note: ${note}`);
  }
  return `${lines.join('\n')}\n`;
}

function defaultRun(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} が失敗: ${(result.stderr ?? '').trim()}`);
  return result.stdout;
}

const PR_FIELDS = 'number,title,isDraft,labels,mergeStateStatus,autoMergeRequest,headRepositoryOwner,files,author';

// auto_merge の予約が無く・安全弁も無い PR だけ、作者権限を1件ずつ照会する（無駄な API 呼び出しを避ける）。
function collaboratorsFor(repo, prs, run) {
  const logins = [...new Set(prs.map((pr) => pr.author?.login).filter(Boolean))];
  const known = [];
  for (const login of logins) {
    try {
      run(['api', `repos/${repo}/collaborators/${login}/permission`, '--jq', '.user.login']);
      known.push(login);
    } catch {
      // 404 = collaborator ではない。既知リストに入れない。
    }
  }
  return known;
}

export function fetchState(repo, { run = defaultRun, asOf = null } = {}) {
  const prs = JSON.parse(run(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', PR_FIELDS]));
  return { repo, asOf, prs, collaborators: collaboratorsFor(repo, prs, run) };
}

export function main(argv, { run, log = console.log } = {}) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    log(USAGE);
    return 0;
  }
  const repoIndex = args.indexOf('--repo');
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : null;
  if (!repo || !repo.includes('/')) {
    log(USAGE);
    return 2;
  }
  const report = evaluateAll(fetchState(repo, run ? { run } : {}));
  log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderText(report).trimEnd());
  return 0;
}

if (isEntry(import.meta.url)) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
