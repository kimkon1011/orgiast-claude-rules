# PR #547: 依頼主復元の追加検証（2026-09-24）

既存ブランチ fix/feedback-followup-notifications の追加修正。DM送信・マージなし。

## 実機結果

WSL Node で Windows ホームを ORGIAST_HOME=/mnt/c/Users/uers と明示し、実際の GitHub、feedback API、Discord 名簿を使って --dry-run --json を実行した。
エスカレーションは **5/6 → 4/6**。#21 は本文の `要望（kim / 2026-09-22、nishi の Claude Code セッションで受領）` から kim を抽出する。
Discord検索には別人 Kimi も返るため、既存のowner ID（kim）との一致を検証して別名を解決する。nishi を依頼主として扱わない。

```json
[
  {
    "key": "kimkon1011/purchasing-management-app#13",
    "resolution": "resolved",
    "recipient": "古川未歩",
    "escalated": false,
    "sent": false
  },
  {
    "key": "kimkon1011/purchasing-management-app#21",
    "resolution": "owner_is_kim",
    "recipient": "kim",
    "escalated": false,
    "sent": false
  },
  {
    "key": "kimkon1011/purchasing-management-app#7",
    "resolution": "escalated",
    "recipient": "kim",
    "escalated": true,
    "sent": false
  },
  {
    "key": "kimkon1011/purchasing-management-app#6",
    "resolution": "escalated",
    "recipient": "kim",
    "escalated": true,
    "sent": false
  },
  {
    "key": "kimkon1011/purchasing-management-app#5",
    "resolution": "escalated",
    "recipient": "kim",
    "escalated": true,
    "sent": false
  },
  {
    "key": "kimkon1011/purchasing-management-app#4",
    "resolution": "escalated",
    "recipient": "kim",
    "escalated": true,
    "sent": false
  }
]
```

## 一次ソースの限界と未解決理由

指定された BOOTH_FEEDBACK_URL の action=feedback は ok=true、counts={open:3,total:14}、items=3 を返した。
返却行は 11・12・14（2026-09-14〜21のブース制作の報告）。フィールドは key,rowNumber,ts,kind,title,body,status,note,source,images。
source は案件のダイアログ名で、人名・メール・Discord ID は無い。対象購買Issueと一致する報告は無い。
全14件の履歴を取得できたわけではなく、「一次ソース全体にも絶対に存在しない」とは断定しない。

- #7（領収書アップロード失敗）: 本文の提出者メールはあるが、既存calendar-cacheのメール対応は0件。Discord名簿も一意解決不可。API返却3件にも一致なし。
- #6（アリババ、お支払いのみ）: #7と同じ提出者メールで、同様に対応名簿がなく復元不可。API返却3件にも一致なし。
- #5（文字化けした疎通テスト）: 本文は提出者「不明」。文字化け部分から推測しない。API返却3件にも一致なし。
- #4（フォーム再導入の疎通テスト）: 本文は提出者「不明」。自動テストの記述から実在の依頼主を推測しない。API返却3件にも一致なし。

未解決文面に「この報告の依頼主が特定できません。元シートの行を確認してください」とAPIのsheetUrlを付加した。
これは指定APIの照合元シートで、購買Issueの原本行と確認できたものではないため「該当行は未特定」と明示している。

## 保存・誤送信防止

- --backfill は明示的な台帳保存専用モード。DM送信・通知台帳更新をしない。
- --backfill --dry-run は保存予定だけを返す。今回、本物のホーム台帳への保存は実施していない（dry-runを外す実行は禁止のため）。
- 一次ソースの照合は明示的なIssue URL、またはタイトル・本文・提出元URLの完全一致かつ候補1件のみ。日時の近さやタイトルだけでは採用しない。
- 人名は完全一致、メールはメール対応が確認できたメンバーのみ。部分名・メール断片で復元しない。
- 既存の自動backfillを明示フラグ必須へ変更した。通知時には本文から再解決できる。
- 安全面: 誤配送を避ける厳密照合と不明理由の可視化。価値面: kimへの不要なエスカレーションを1件削減し、未解決の調査先をリンク化。

## 回帰テスト

`node --test tools/feedback-progress-notify.test.mjs tools/feedback-done-notify.test.mjs tools/feedback-to-issues.test.mjs tools/discord-member-directory.test.mjs`: 63 passed, 0 failed（進捗通知単独25件）。
実保存・再読込は一時fixtureで確認し、本物のホームへの書込みやDM送信は行っていない。

## 実台帳 SHA-256

通常 dry-run と --backfill --dry-run の2回を実行。両モードで同じ6件の分類を確認。

```json
{
  "before": "cbc7446be78496e4b1f735fa0d8c35a424a8a5c8a640ae2b109309a3d41871fe",
  "after": "cbc7446be78496e4b1f735fa0d8c35a424a8a5c8a640ae2b109309a3d41871fe",
  "equal": true
}
```
