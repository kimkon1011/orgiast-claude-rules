# PR のマージ可否は gh api で機械判定する（kim に伺わない）

対象の handoff: `[handoff-audit:ee77d5457c15c5fc] PR のマージ可否を kim に一言伺う`
再発防止の経路: gh api / 実装: `tools/pr-merge-eligibility.mjs`

## なぜ「伺う」のが違反なのか

kim の手作業1回は最上位のコスト（監査基準 rule 1）。マージ可否は次の3つで**完全に決まる**ので、
kim の判断を挟む余地がない。どれも `gh` の実測値から取れる（rule 2 / rule 4）。

| 決定要因 | 実測の取り方 |
|---|---|
| `automerge` ラベルが付いているか | `gh pr list --json labels` |
| 変更ファイルに安全弁パスが含まれるか | `gh pr list --json files`（`.github/workflows/*` / `*keyserve*` / `*secrets*` / `*.env*`） |
| auto-merge が予約済みか | `gh pr list --json autoMergeRequest` |

## 落とし穴（過去に何度も誤読した）

Auto merge ワークフローの `enable-auto-merge` ジョブは、**安全弁で `eligible=false` になっても success 表示になる**
（`Enable squash auto-merge` ステップが `skipped` になるだけ）。「ジョブが pass した＝自動マージが有効」と
読み替えると、PR は OPEN のまま永久に残る。判定は `autoMergeRequest` と変更ファイルの実測だけで行う。

```bash
# 誤読の実例（実測 2026-09-26）
gh api repos/kimkon1011/orgiast-claude-rules/actions/runs/36164966842/jobs \
  --jq '.jobs[] | .name, (.steps[] | "  \(.name): \(.conclusion)")'
# enable-auto-merge => success
#   Enable squash auto-merge: skipped   ← pass 表示でも skipped
```

## 使い方

```bash
node tools/pr-merge-eligibility.mjs --repo kimkon1011/orgiast-claude-rules
node tools/pr-merge-eligibility.mjs --repo <owner/name> --json
```

verdict と、その verdict に対して Claude が取るべき行動:

| verdict | 意味 | Claude の行動（kim に聞かない） |
|---|---|---|
| `auto_merge_enabled` | auto-merge 予約済み | 何もしない。GitHub が squash する |
| `missing_label` | 安全弁なし・ラベル未付与 | `gh pr edit <n> --repo <repo> --add-label automerge`（`gh pr edit` は allow 済み） |
| `manual_merge_required` | 安全弁パスに該当 | 人（kim）の手動マージ1回。**可否を聞く必要はない**（決定は既に機械的に済んでいる） |
| `pending_auto_merge` | ラベル済み・安全弁なし・予約未了 | ワークフロー実行を gh api で確認（上の落とし穴を参照） |
| `ineligible_fork` / `ineligible_draft` / `ineligible_author` | 自動マージ対象外（設計どおり） | head が fork / draft / 非 collaborator。base リポのブランチへ載せ替えない限り自動化できない |

## 実測（2026-09-26・open PR 20件）

```
open 20 件: ineligible_draft=1 / ineligible_fork=8 / manual_merge_required=3 / missing_label=8
```

- `manual_merge_required` 3件: #567 / #566（`.github/workflows/test.yml`）・#404（`tools/keyserve-auth.mjs`）。
  いずれも CLEAN・CI green で、安全弁だけが理由。kim の手動マージ1回で解消する。
- `ineligible_fork` 8件: head が他PCアカウントの fork（`cr568` / `nishiOrgiast` / `mihofurukawa0430-svg`）。
  ワークフローは fork に書き込み権限を渡さない設計なので、自動マージは**できない**（不具合ではない）。
- `missing_label` 8件: うち CLEAN は #552 / #516 / #420 の3件で、ラベル1つで自動マージに載る。
  残りは DIRTY（main と衝突）で、先に衝突解消が要る。

## この監査で分かったこと

「マージ可否を kim に伺う」という handoff は 2026-09-24 に記録されて以降、**再発していない**
（`~/.claude/next-session.md` に問い合わせ形の依頼は無く、直近の auto-session ランにも該当なし）。
滞留している PR の実体は「聞き忘れ」ではなく、上記の3分類（安全弁 / fork / ラベル未付与）で、
すべて gh api で判別できる。次に同じ状況に遭遇したセッションは、kim に聞かずにこのツールを回し、
`missing_label` の CLEAN な PR は自分でラベルを付けて自動マージに載せること。

## 関連

- 安全弁の定義: `.github/workflows/auto-merge.yml` / `docs/pr-flow-canonical-branch.md`
- 手動マージの REST 経路: `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f merge_method=squash`
