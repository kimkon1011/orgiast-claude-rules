## 概要

### X-0036 実装: 本体 Sonnet + 要所 Fable アドバイザー委譲

Claude Code の日常作業は Sonnet 5.5（effort medium）で行い、ブースレイアウト・イベント予算・契約条件などの要所判断だけ Fable 5.1 をアドバイザー（`/advisor fable`）として使う使い分けを正式ルール化。

### 変更内容

- **ONBOARDING.md**: §1.13.1 直後に「大事な判断の前は必ず /advisor に相談してから決めて」を追記
- **CLAUDE.md.template**: ONBOARDING から自動同期（1行追加）
- **.claude/settings.json**: `advisorModel: "claude-fable-5-1"` + `maxEffortLevel: "medium"` を追加

Fable の使用は全体の 5〜10%（要所判断のみ）に限定し、発生時だけ課金される。

## 変更ファイル
- `ONBOARDING.md` — アドバイザー委譲ルール追記（+2行）
- `CLAUDE.md.template` — ONBOARDING からの自動同期（+1行）
- `.claude/settings.json` — advisorModel + maxEffortLevel 設定追加（+2行）