# マキモノ本体に「自社出品の自動承認」を入れる（本体リポがあるPCで実行）

**このファイルは、マキモノ本体（`makimono-md.vercel.app`）のリポジトリがあるPCの Claude が読んで実行するための指示書。**
本体リポが無いPCでは何もしない（下の「0. 実行してよいPCかの判定」で必ず落とすこと）。

## なぜ必要か

`tools/makimono-publish.mjs --submit` で出品すると必ず `status: pending`（審査キュー）に入る。
2026-08-27 時点で **API経由の出品 58 件に対し、公開中の巻物は 19 件で、本文 sha256 が一致するものは 0 件**だった。
つまり**審査キューは一度も処理されておらず、API出品は1件も公開に至っていない**。
セッション終了のたびに出品しても、そのまま埋もれ続ける。

自社（オージャスト）の出品は、出品前に `makimono-publish.mjs` の送信禁止スキャン
（APIキー・webhook・社内ドメイン・メール・電話・Google リソースID・`C:\Users\<名>`・社内固有名）を通過している。
**自社の信頼済みキーからの出品に限り自動承認**し、第三者の出品は今まで通り審査キューに残す。

## 0. 実行してよいPCかの判定（最初に必ず行う）

次を満たさなければ**何もせずに終了**する。「たぶんここだろう」で別のリポを書き換えない。

```bash
# 本体リポの特定: /api/v1/listings のハンドラを持つリポがあるか
grep -rl "api/v1/listings\|submissionId" --include=*.ts --include=*.tsx --include=*.js ~ 2>/dev/null | head
```

- 見つからなければ「このPCにマキモノ本体リポは無い」と1行報告して終了する
- 見つかったら、そのリポで `git remote -v` と `vercel projects ls` を確認し、
  **`makimono-md` の本番デプロイ元であることを確かめてから**着手する

## 1. 信頼済み出品者の自動承認

出品ハンドラ（`POST /api/v1/listings`）に、承認判定を1か所だけ足す。

- 環境変数 `MAKIMONO_TRUSTED_SELLER_EMAILS`（カンマ区切り）に、自社の出品者メールを入れる
- APIキーに紐づくメールがこのリストに含まれ、**かつ既存の秘密情報スキャンを通過**した出品は、
  `pending` ではなく**公開状態**で登録する
- レスポンスは `{ ok: true, submissionId, status: "published", slug }` を返す
  （クライアントが「公開まで到達した」ことをその場で判定できるようにするため）
- リストに無いメールからの出品は**従来どおり `pending`**。ここは絶対に緩めない
- 環境変数が未設定なら全件 `pending`（既定は安全側）

**スキャンを外してはいけない。** 自動承認するのは「審査の人手」であって「秘密情報チェック」ではない。

## 2. 出品状態を問い合わせる API

クライアント側が「公開されたか」を機械的に確認できないと、同じ放置が再発する。

```
GET /api/v1/listings/{submissionId}
→ { ok: true, submissionId, status: "pending" | "published" | "rejected", slug?: string, title: string }
```

- 認証: 出品時と同じ `Authorization: Bearer <apiKey>`。**自分が出したものだけ**返す
- 存在しない ID は 404。他人の ID は 404（存在を漏らさない）

## 3. 滞留分の一括承認（管理用）

```
POST /api/v1/admin/approve
Authorization: Bearer <MAKIMONO_ADMIN_TOKEN>
body: { "submissionIds": ["sub_xxx", ...] }  // 省略時は信頼済みメールの pending 全件
→ { ok: true, approved: N, skipped: [{ submissionId, reason }] }
```

- `MAKIMONO_ADMIN_TOKEN` は本体の環境変数。**出品用 APIキーとは別物**にする
- 承認時にもう一度、秘密情報スキャンを通す（出品時から本文が変わっていない保証は無い）
- 重複タイトル・同一本文が既に公開済みなら `skipped` に入れて二重公開しない

## 4. 検証（ここまでやって完了）

1. 信頼済みメールのキーでテスト出品 → レスポンスが `status: "published"` になる
2. `GET /api/v1/search?q=<そのタイトルの特徴語>` に出る
3. `GET /api/v1/files/{slug}/raw` が 200 で本文を返す
4. **信頼リストに無いメール**のキーで出品 → `status: "pending"` のままであることを確認する（ここが緩んでいないか）
5. `POST /api/v1/admin/approve`（ID省略）で滞留分を一括承認し、`approved` の件数を報告する
6. 出品側のPCで `node <repo>/tools/makimono-publish.mjs --check` を実行し、審査待ちが0に近づくことを確認する

## 5. やってはいけないこと

- 第三者出品の自動承認（スパム・秘密情報の公開に直結する）
- 秘密情報スキャンの無効化・緩和
- 管理トークンをクライアント（出品側PC）へ配布すること。承認は本体側だけで完結させる
- 既存の公開済み巻物の本文・slug の書き換え（URL が変わると参照側が壊れる）
