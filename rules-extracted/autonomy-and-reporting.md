# Auto Mode・自律進行 詳細

ONBOARDING.compressed.md §1.14 / §1.15 の詳細。

## 1.14 Claude Code は Auto Mode を default にする

新規セッションを開くたびに `/auto-mode` を打たなくて済むよう、ユーザーグローバル設定で恒久化する。

`~/.claude/settings.json` の `permissions` オブジェクトに `defaultMode: "auto"` を追加:

```json
{
  "permissions": {
    "allow": [ /* ... */ ],
    "defaultMode": "auto"
  }
}
```

これで Claude は「迷ったら user に多択質問する」のではなく「合理的判断で進める、間違えたら user が止める」モードが標準になる。本ルール 1.1（徹底自動化）と整合。

注意点:
- user settings (`~/.claude/settings.json`) でのみ有効。プロジェクト直下の `.claude/settings.json` や `.claude/settings.local.json` に書いても無視される（リポジトリから自動付与されないよう Anthropic が制限）
- 前提: Claude Code v2.1.83+ / Opus 4.6+ または Sonnet 4.6+ （Haiku/4.5 系では未対応）
- CLI でも `claude --permission-mode auto` で同等になるが、settings.json に書くほうが恒久化される
- 1 度だけのお試し起動なら `/auto-mode` でセッション内 toggle 可

Why: Auto Mode 未設定だと多択質問が頻発し、本ルール 1.1〜1.2 と矛盾する。default にすれば「Bias toward working without stopping for clarifying questions」が常に効く。

参考: https://code.claude.com/docs/en/permission-modes.md#eliminate-prompts-with-auto-mode

## 1.15 完了報告で stop せず自律進行する

user に「すすめて」「続けて」「次は?」 と打たせない。 完了報告を書いた後は 自動で次の TODO に着手 する。

Why: 2026-06-30、 イベント見積/実施計画 + PJ フォルダ 自動作成 機能の本番化完了後、 kim から「すすめてと書かずとも勝手に進めるようにしてくれるかな」 と明示要望。 1.1 の徹底自動化と本質同じ — 「user の手間」 を 1 step たりとも残さない方針を、 conversation 内の「すすめて」 入力にも適用。

完了報告後の自動着手チェックリスト (該当するものを順に判定して全部やる):

| 残 TODO | 着手判定 |
|---|---|
| git commit (local) | 編集ファイルあり + commit 未実行 → feature 単位の commit message で local commit |
| vercel prod deploy | code 変更 + 未 deploy → `vercel --prod --yes` (kim memory `feedback-vercel-prod-pre-authorized` で事前承認済み) |
| Layer 2 e2e | UI/server action 変更 + 未検証 → Playwright で production fetch + click + DB read-back |
| memory 反映 | 新事実 (DwD 設定済 / API enable 済 / pattern 確立) があれば feedback or project memory を新規 / 更新 |
| MEMORY.md 追記 | memory file 新規作成時 1 行追記 |
| ONBOARDING.md 反映 | 全プロジェクト共通の rule 確立時 該当 section に追記 + GitHub push |
| HANDOFF.md 更新 | 大型 feature 完了時 progress note 追加 |
| git push to main | classifier block されがちなので vercel CLI で代替済 (`vercel --prod`) を report |

「完了」 と判定する条件 — typecheck PASS + Layer 2 e2e PASS まで通って初めて完了 (§1.10 と整合)。 typecheck だけは「完了」 ではない。

自律進行を抑制すべき例外 (これらは AskUserQuestion で待つ):
- 設計判断 (feature の方針確認 / OAuth 同意 / 支払い)
- 破壊的操作 (git reset --hard / branch -D / DB drop)
- 未承認の prod 送信系 (メール一斉 / Discord broadcast / production cron 起動)
- 大型リファクタ (> 5 files の趣旨変更)

報告書式 — 完了報告の末尾に「残 TODO」 section を必ず付け、 自動着手して終わったものは「✓ 着手済」、 残ったものは「⏳ 次回」 と marking。
