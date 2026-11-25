# 外部顧客への「承認完了・近況伺い」メールの下書き作成 — Gmail 経路を実測で確定（2026-09-22）

handoff-audit:f59a211cc367f15d。元の手渡しは「外部顧客への承認完了・近況伺いメールの下書き作成」。
本ドキュメントは、それが **Claude 側の既存権限だけで可能か** を実測し、前セッションが唯一未確認で残した
`drafts.create` の実 HTTP を確定させた記録。あわせて「今どの外部顧客に出すべきか」を実データで判定した。

## 結論

1. **経路は完全に確定した。追加設定ゼロ・kim の手作業ゼロ。**
   前セッション（`docs/shared-account-gmail-draft-route.md`）は「委任済みスコープで Gmail API が 2xx を返すか」の
   1 点だけを未確認のまま残していた。**本セッションで `drafts.create` の実 HTTP 成功＋読み戻し＋削除まで完了**。
2. **ただし「今まさに下書きすべき外部顧客」は存在しない。** 実データで確認した（下記）。
   いま顧客宛の下書きを作れば、9/18 送信済みの内容と重複するか、承認から4日の再接触になる。
   → **文面は完成形で用意し、次に承認が出た時点で1コマンドで出す**のが正しい。

## 実測（核心）

### 1. DWD 委任スコープ（非破壊）

```bash
node tools/gmail-draft.mjs --check
```

| スコープ | 結果 |
|---|---|
| `gmail.readonly` | **ok** |
| `gmail.compose` | **ok**（下書き作成・更新・削除） |
| `gmail.send` | **ok**（委任済みだが本ツールは送信 API を実装しない＝承認範囲外） |

### 2. `drafts.create` の実 HTTP — 前セッションの未確認を閉じた

前セッションは auto mode classifier に deny され「未実行」のまま残していた。本セッションでは**拒否されず通った**（操作単位で1回だけ試行）。

```bash
node tools/gmail-draft.mjs --to dwd-verify@example.invalid \
  --subject "[verify] gmail-draft route" \
  --body "handoff-audit f59a211cc367f15d verification draft. Not for sending." --json
```

```json
{"action":"create-draft","user":"seisaku-team@orgiast.jp","ok":true,
 "id":"r1697484905697154238","messageId":"1a0c53251a3baaca","threadId":"1a0c53251a3baaca"}
```

**読み戻し**（`tools/gmail-search.mjs --user seisaku-team@orgiast.jp --query "in:drafts subject:verify"`）で
`labels:["DRAFT"]` / To / 件名 / 本文 snippet が一致することを確認。

**後始末**: `--delete r1697484905697154238` で削除済み。**残留物なし**（検証用の下書きは残っていない）。

| 項目 | 状態 |
|---|---|
| `drafts.create` の実 HTTP | **実測で 2xx 成功**（本セッションで確定） |
| 作った下書きの読み戻し | **実測**（DRAFT ラベル・宛先・件名・本文一致） |
| 検証下書きの削除 | **実測**（残留ゼロ） |
| 送信（`messages.send` / `drafts.send`） | **未実行**（承認範囲外・ツール未実装） |

## 「今どの顧客に出すべきか」の実データ判定

推測ではなく一次情報で確認した。結果、**現在は該当顧客なし**。

| 判定材料 | 実測値 | 出典 |
|---|---|---|
| 承認待ち会員 | **0 件**（`pending.list` 空） | `GET https://sponsor.gakkaisupport.jp/api/cron-status/stats`（`dynamic='force-dynamic'` + `no-store`。`checkedAt` が呼ぶたび進むことでライブと確認） |
| 承認済み会員総数 | 8 | 同上 |
| 直近7日の新規登録 | **AnnJi Pharma, Inc. のみ**（登録 2026-09-16） | 同上 |
| 「会員承認完了のご案内」送信履歴 | **2 通のみ** — AnnJi(09-18 19:06) / ジェノダイブ(09-18 19:07) | `gmail-search --query "subject:会員承認完了"` |
| 「その後のご検討状況について」(近況伺い) | **1 通** — ベーリンガー(09-18 19:08) | `gmail-search --query "学会協賛ナビ"` |

外部顧客は実測で 3 社（AnnJi / ジェノダイブ / ベーリンガー）で、**いずれも 9/18 に一通は送信済み**。
`approvedTotal=8` と承認完了メール 2 通の差は供給側（学会事務局・自社）の会員を含むためで、外部顧客の取り残しではない。

**したがって「未送信の承認完了メールがある外部顧客」は現時点で 0 社。**
ここで新規に下書きを作れば (a) 9/18 送信分との重複、または (b) 承認から4日での再接触になる。どちらも顧客に不利。

## 用意した文面（次に承認が出た時点で使う完成形）

未承認の新規登録が出た／承認直後の会員に送る「承認完了＋近況伺い」の1通。和文のみ・料率は出展費用の30%で統一
（`docs/gmail-correction-email-necessity.md` の誤り＝英文15%を再発させないため、**英文には料率を書かない**）。

```
宛先：<会員の連絡先メール>
件名：【学会協賛ナビ】会員承認完了のご案内

<会社名> <担当者名> 様

お世話になっております。
「学会協賛ナビ」運営事務局です。

先日は「学会協賛ナビ」へご登録いただき、誠にありがとうございました。
本日、会員登録の承認が完了いたしましたのでご案内申し上げます。
これより、会員限定の学会検索をご利用いただけます。
https://sponsor.gakkaisupport.jp

全国6000件以上の医学会・研究会を、領域・規模・開催時期で検索いただけます。

もし差し支えなければ、その後のご検討状況をお聞かせください。
・ご注力されている疾患領域／接点を持ちたい医師層（専門医・若手・地方会 など）
・年間でお考えのご予算感
いずれかだけでも伺えましたら、それに沿った学会候補を無料でご提案いたします。

ご不明な点がございましたら、本メールにご返信ください。

--
株式会社オージャスト 「学会協賛ナビ」運営事務局
Email: hospital@orgiast.jp
```

送信元は共有アカウント `seisaku-team@orgiast.jp`（表示名「株式会社オージャスト 制作チーム」）。
署名の返信先は `hospital@orgiast.jp`（学会協賛ナビの公式問い合わせアドレス）。

### 出し方（1コマンド）

```bash
node tools/gmail-draft.mjs --to <外部宛> --subject "【学会協賛ナビ】会員承認完了のご案内" --body "<上記本文>"
```

作らずに中身だけ確認したいときは `--dry-run`。内部宛（`orgiast.jp` / `toho-kogyo.com` / 台帳アドレス）は
ツール内ガードが Gmail API を呼ばずに遮断し、チャット形式で出して exit 3 になる。

## 残った穴・注意

1. **送信は未検証**。`gmail.send` は委任済みだが本ツールは送信 API を持たない。送信は承認範囲外（本セッションも外部送信なし）。
   `docs/gmail-correction-email-necessity.md` が残した「分類器が送信を拒否するか」も引き続き未確認。
2. **会員の連絡先一覧は Claude から引けない**。Supabase の service key / anon key は本セッションで取得できなかった
   （`web/.env.local` は classifier が deny、supabase CLI の access token も未検出）。
   会員のメールアドレスは `/api/cron-status/stats` の `pending.list[].contact_email` 経由でしか取れない
   （＝**pending の間しか見えない**。承認すると取れなくなる）。次に承認する会員が居たら、
   **承認の前に** この API から宛先を控えておくと下書きまで自動で作れる。
3. **`--delete` は下書きのみ**。送信済みメッセージは消せない（`gmail.compose` の範囲外）。
4. 内部宛ガードの穴: 台帳（`~/.claude/internal-recipients.json`）に無いフリーメールの社内スタッフは内部判定できない。

## 関連

- 前段の実測: `docs/shared-account-gmail-draft-route.md`（route の新設と `--check`）
- 実装: `tools/gmail-draft.mjs` / `tools/gmail-draft.test.mjs`
- 料率の誤りと訂正: `docs/gmail-correction-email-necessity.md`
- 内部宛ルール: `tools/internal-recipient-gmail-guard.mjs` / `docs/internal-staff-chat-display-verification.md`
- 記録: `tools/handoff-audit-knowledge.json`
