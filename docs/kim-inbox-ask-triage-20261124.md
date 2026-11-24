---
name: kim-inbox-ask-triage-20261124
description: "kim-inbox open ask 106件の実データ内訳と判定（A=自動クローズ可 / B=事象解消済み / C=判断要）"
metadata:
  node_type: memory
  type: project
  originSessionId: wt-ask-autoclose
  modified: 2026-11-24
---

# kim-inbox open ask 106件 トリアージ（2026-11-24）

`node tools/kim-inbox.mjs --list --status open` → `open ask 106 / open info 936`
`node tools/kim-inbox-autoclose.mjs`（allowlist 修正後）→ 自動通知の件数を確認

## 判定基準

- **A**: 判断不要の自動通知（完了報告のみ）→ 自動 seen 化の対象
- **C**: 本当に kim の判断が要る（操作・判断待の通知）

実データに基づき、以下の source は allowlist から除外した。

### 除外した source と根拠（実本文引用）

| source | 実本文 | 正しい判定 | 根拠 |
|--------|--------|-----------|------|
| `login-health` | `🔑 ログイン切れ検知: ai-lane:gemini / 状態: gemini 停止 (billing) / 直し方: node tools/lane-doctor.mjs --probe` | **C** | kim の入金・再ログインが必要な通知。自動クローズ禁止 |
| `auto-progress-start-expired` | `セッション 15e481c1 / 対象: リーダー報酬 単価行自動追加の承認待ち` | **C** | kim の承認待ちセッション。自動クローズ禁止 |
| `auto-progress-periodic` | 定期進捗報告だが `確認結果: 未達` を含み追跡が必要 | **C 寄り** | 自動クローズ対象から外す |
| `auto-progress-heartbeat` | open ask に実例が 0 件 | — | A と確認できていないので入れない |

## 実測結果

`node tools/kim-inbox-autoclose.mjs` → 自動通知 **29件**（全て auto-progress-done）

### 判定別件数

| 判定 | 件数 | 内訳 |
|------|------|------|
| **A** | **29** | auto-progress-done 29（✅ check 達成: / ✅ 自動進行が完了しました / 📋 未通知一覧） |
| **C** | **77** | 残りは本当に kim の判断が必要 |
| うち login-health | 5 | 本文に `🔑 ログイン切れ検知:` を含む。kim の入金・再ログインが必要 |
| うち auto-progress-start-expired | 4 | 本文に `承認待ち` を含む。kim の承認操作が必要 |
| うち auto-progress-periodic | 1 | `確認結果: 未達` を含み追跡が必要 |

### A 型 29 件詳細

| source | 件数 | 理由 |
|--------|------|------|
| auto-progress-done | 29 | 自動進行の完了報告。✅ check 達成: / ✅ 自動進行が完了しました / 📋 未通知一覧