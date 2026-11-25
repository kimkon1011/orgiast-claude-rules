---
name: daily-report
description: 日次レポート（Daily.md）を自動出力する。セッション終了時の状態を要約し、キャッシュ切れ後の復帰を容易にする。トリガーは `/daily` または `/daily-report`。
---

# Daily.md レポート生成

## 目的

Claude Code のキャッシュ切れ後や長期休暇後のセッション再開時に、前回の状態を効率的に把握するための日報を生成する。

## 出力先

`outputs/daily/YYYY-MM-DD.md`

## 実行方法

### 手動
```
/daily
```

### 自動（session-close 時）
```json
{
  "hooks": {
    "SessionFinish": [
      {
        "command": "node tools/daily-report.mjs",
        "async": true,
        "timeout": 60
      }
    ]
  }
}
```

## 出力形式

```markdown
# Daily Report — {YYYY-MM-DD}

## 完了
- {完了したタスク}

## 進行中
- {進行中のタスク}

## 判断待ち
- {判断待ちの項目}

## 残課題
- {次回に持ち越す課題}

## トークン消費
- 総入力: {N}K / 総出力: {N}K
- キャッシュヒット率: {N}%
```

## 収集する情報

1. **完了タスク**: このセッションで完了したタスクの一覧
2. **進行中タスク**: 未完了のタスク
3. **判断待ち**: ユーザーの判断が必要な項目
4. **残課題**: 次回セッションへの引き継ぎ事項
5. **トークン消費**: usage 情報（input_tokens / output_tokens / cache_read / cache_creation）
