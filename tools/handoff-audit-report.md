# handoff-audit 実装・検証報告

着手: 2026-09-12 / audit/handoff-audit。指定 worktree 内の tools に直接実装。

同期段は全regexの判定後に実行し、既存blockがあればLLMを呼ばない。groq → openrouter → deepseek、総待機20秒、異常時fail-open。再試行上限は既存runnerの2回を維持。runnerのrun/evaluateGatesはasyncとなりawaitが必要。

夜間段は前日（実行PCのローカル日付）のpass/retry-cap/差し戻し後passを監査。patternで重複排除し、mediumは別観測で同じ経路が再登場した場合のみhighに昇格。同じ記録の再処理では昇格しない。既知台帳にない生成経路は自動キューに採用しない。既存の残TODOを保持して番号付き1行を追加。DM送信なし。

nightly-batchに登録済み。register-hooksのStop timeoutを10秒から30秒へ変更。本番settings登録・本番orgiast-mainの編集・commit/pushは行っていない。新規成果の別ディレクトリ/bundleへの退避はない。

## テスト

新規22件、runner/登録を含む関連37件は成功。全体最終結果: **2,053件中2,050成功・失敗0・既存skip3**、229.834秒。

実行コマンド: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false node --test --test-concurrency=1 tools/*.test.mjs`。
初回の全体実行は2,053件（2,047成功・3失敗・3skip）。既存batch-runの1秒制限、およびcodex-doの2件の30秒制限に抵触。batch-run単独は成功。最終確認は並列負荷を下げ、Git fsmonitorを無効にして実行（テストのassertは緩和していない）。

## 実Groq煙テスト

入力は指定のTETSUKO GA4否定断定とGrepのみ。出力枠1600では回答の途中切れを検出してaudit-unavailable/passとなったため、最大4000へ修正し、整数ruleと最大5違反を明示。再実行でblock確認。

provider: groq / latency: 3655ms / verdict: block / 入力実測: 2259 tokens（1回約2,300、本文・tool履歴量で増加）。

```json
{
  "violations": [
    {
      "rule": 1,
      "quote": "kim@orgiast.jp には TETSUKO の GA4 は存在しない可能性が高い。確定は analytics.google.com を開いて有るか無いか教えてください。",
      "fix": "手渡しは品質が唯一の正当化理由で、効率目的は不可。GA4 の有無は Claude 側で analyticsadmin API を直接照会し、結果を返す。"
    },
    {
      "rule": 3,
      "quote": "kim@orgiast.jp には TETSUKO の GA4 は存在しない可能性が高い。確定は analytics.google.com を開いて有るか無いか教えてください。",
      "fix": "依頼前に [手渡し判定] を作成し、試したこと・結果・user でしかできない理由（例: OAuth 初回同意）を記載する。"
    },
    {
      "rule": 4,
      "quote": "kim@orgiast.jp には TETSUKO の GA4 は存在しない可能性が高い。確定は analytics.google.com を開いて有るか無いか教えてください。",
      "fix": "GA4 の存在は DWD サービスアカウントで analyticsadmin API を呼び、存在すれば true、なければ false とし、未照会なら「未確認」と記す。"
    },
    {
      "rule": 5,
      "quote": "kim@orgiast.jp には TETSUKO の GA4 は存在しない可能性が高い。確定は analytics.google.com を開いて有るか無いか教えてください。",
      "fix": "手渡しが必要な場合は URL・画面・番号付き手順・成功判定・失敗時対処を全て記載し、自己完結させる。"
    }
  ],
  "learned": [
    {
      "pattern": "Google 系プロパティ(GA4/Search Console/GTM)の有無確認",
      "route": "DWD サービスアカウント(kim impersonate)で analyticsadmin/webmasters/tagmanager API を直接照会（tools/google-property-check.mjs）。Claude 履歴の Grep は証拠にならない。分類器で止まるなら『未確認』と書く",
      "confidence": "high"
    }
  ]
}
```

## working tree に書いたファイルの絶対パス一覧

- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-gate.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-gate.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-gate.test.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-gate.test.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-nightly.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-nightly.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-nightly.test.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-nightly.test.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-rules.md](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-rules.md)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-knowledge.json](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-knowledge.json)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/stop-gate-runner.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/stop-gate-runner.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/stop-gate-runner.test.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/stop-gate-runner.test.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/register-hooks.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/register-hooks.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/register-hooks.test.mjs](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/register-hooks.test.mjs)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/nightly-batch.ps1](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/nightly-batch.ps1)
- [/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-report.md](/mnt/c/Users/uers/.claude/worktrees/handoff-audit/tools/handoff-audit-report.md)
