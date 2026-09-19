# 外部顧客宛の訂正メール送信要否 — Gmail を既存権限で実測（2026-09-20）

handoff-audit:06b13bfb2a89b62b。元の手渡しは「AnnJi 宛の訂正メールを送るかどうかを kim が判断する」。
本ドキュメントは、判断の材料（送信済み本文の実物）と、Claude 側で到達できた範囲を記録する。

## 結論

**要（送信すべき）。** ただし本セッションは外部送信を行わない方針のため、**送信は実施していない**。
完成済みの下書きが Gmail に存在し、送信は1アクションで済む。

## 送信経路（既存権限・追加設定ゼロ）

Gmail MCP は本環境に未登録（`mcpServers` = `gemini-cli` のみ）。ただし **DWD 経由の読み取りは既存ツールで通る**。

```bash
node tools/gmail-search.mjs --user seisaku-team@orgiast.jp --query "<検索式>" [--body] [--max N]
```

- 実装: `tools/gmail-search.mjs`。`tools/lib/drive-auth.mjs` の `getDriveToken({ scope: 'https://www.googleapis.com/auth/gmail.readonly', impersonate: user })` で impersonate。
- `gmail.readonly` は DWD 委任済みで**そのまま通った**（`drive.readonly` が `unauthorized_client` で落ちたのとは対照的）。
- 落とし穴: **kim@orgiast.jp 側では 0 件**。当該メールは `seisaku-team@orgiast.jp` から送信されている。`--user` を省略しない（既定は seisaku-team）。
- 書き込み系（send/compose）は本ツールに持たせていない。

## 実測した事実

### 1. 誤りは実在する（送信済み本文で確認）

| 項目 | 値 |
|---|---|
| message id | `1a0b3fb255d272dd` |
| 送信日時 | Fri, 18 Sep 2026 19:06:14 +0900 |
| From | 株式会社オージャスト 制作チーム `<seisaku-team@orgiast.jp>` |
| To | `i-ju.chen@ajpharm.com`（AnnJi Pharma, Inc. I-Ju Chen 様） |
| 件名 | 【学会協賛ナビ】ご登録・会員承認完了のご案内 |
| ラベル | `SENT` |

**同一メール内で料金が矛盾している。**

- 和文: 「ご検討段階は完全無料で、**成約時のみ成功報酬30%**となります。」
- 英文（末尾）: "No charge until a deal is made, with a **15% success fee**."

### 2. 影響範囲は 1 通 1 名に限定

同時刻に送られた同種メール 2 通はいずれも **30% で正しい**。

| 宛先 | 日時 | 料金の記載 | 判定 |
|---|---|---|---|
| `i-ju.chen@ajpharm.com` | 09-18 19:06:14 | 和文30% / 英文15% | **誤り** |
| `hiroyukikashio@genodive.co.jp` | 09-18 19:07:28 | 「出展費用の30%のみ」 | 正 |
| `sawa.saito@boehringer-ingelheim.com` | 09-18 19:08:32 | 「出展費用の30%のみ」 | 正 |

全メール走査（`--query "\"15% success fee\""`, max 30）でヒットしたのは
**AnnJi の送信済み1通と、その訂正下書き1通のみ**。他顧客への誤送信は無い＝訂正の連鎖は不要。

### 3. 訂正メールは下書き済み・未送信

| 項目 | 値 |
|---|---|
| message id | `1a0b41220fd4a5d7` |
| 作成日時 | Fri, 18 Sep 2026 12:31:22 +0200（= 19:31 JST、誤送信の25分後） |
| To | `i-ju.chen@ajpharm.com` |
| 件名 | 【学会協賛ナビ】料金に関するお詫びと訂正 / Correction of our fee structure |
| ラベル | `DRAFT`（送信済みコピーは存在しない） |

本文は和文＋英文の二段で、【誤】15% と【正】30%（出展費用の30%・出展時のみ）を明示済み。
他の2通が使っている「出展費用の30%のみ」という標準表現と一致しており、文言の整合も取れている。

## 判断の根拠（なぜ「要」か）

1. **誤りが顧客に有利な方向**（15% < 30%）。顧客が 15% を前提に意思決定した場合、後から 30% を請求すると
   「提示と違う」という典型的な紛争源になる。是正しない側のリスクが非対称に大きい。
2. **同一メール内で 30% と 15% が併存**しており、「どちらが正か」を顧客が判断できない状態。放置は混乱を固定化する。
3. AnnJi は 09-16 登録・09-18 承認の**新規リードで、まだ成約前**。関係性への影響が最小のタイミング。
4. 下書きは既に完成品質で、**送信は1アクション**。追加の作成コストが無い。
5. 影響範囲が 1 通に閉じているため、訂正の連鎖や他顧客への波及対応が不要。

## 未実施・未確認

- **送信は未実施**（本セッションは外部送信を行わない。手渡し範囲の遵守）。
- 下書きの**送信者アドレス**は確認していない（`from` ヘッダが `seisaku-team@orgiast.jp` 単体）。送信時に
  「株式会社オージャスト 制作チーム」の表示名を付けるかは元メールと揃えるかを要確認。
- **分類器による送信拒否の有無は未確認**（送信操作自体を試していないため）。読み取りは拒否されなかったが、
  送信が同様に通るかは実測していない。迂回せず、正規の送信経路で試すこと。

## 関連

- 記録: `tools/handoff-audit-knowledge.json` の「外部顧客宛の訂正メール送信要否」エントリ
- 同型の判断記録: `docs/classifier-denial-external-api-route.md`, `docs/drive-oldfile-trash-route.md`
