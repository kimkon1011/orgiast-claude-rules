# マキモノ本体の「自社出品の自動承認」— 実装済み（2026-08-28）。再実装しないこと

**状態: 実装・本番反映・検証すべて完了。** マキモノ本体リポ（`md-market` / Vercel プロジェクト `makimono-md`）を持つPCで
2026-08-28 に実装され、滞留 94 件のうち 93 件を一括承認して公開済み（1件は既存出品と重複でスキップ）。
**公開中の巻物は 19 件 → 112 件**になった（別PCから公開APIで実測確認済み）。

**このファイルを読んだPCがやることは「§6 残作業」だけ。§1〜§3 を作り直してはいけない。**
本体リポが無いPCでは何もしない（§0 で必ず落とす）。

---

## 実装されたもの（2026-08-28・本番反映済み）

- **自動承認**: `approve.ts` に集約。**秘密情報スキャンは通したまま**、人手の審査だけを省く。
- **状態問い合わせ API**: `GET /api/v1/listings/{submissionId}` — 自分の出品のみ返し、他人のIDと存在しないIDは 404。
  別PCから実測: 自分の出品は `200 {"ok":true,...,"status":"published","slug":...}`、架空IDは `404 {"ok":false,"error":"not_found"}`。
- **一括承認 API**: `POST /api/v1/admin/approve`（`MAKIMONO_ADMIN_TOKEN`）＋ **公開前の下見用 GET**（承認は取り消せないため）。
- **公開棚の構成変更**: 静的 `content/listings/*.md` と動的ストア（GitHub データリポ）のマージ方式へ。
  Vercel は FS 書き込み不可なので、これが無いと「実行時に公開」が成立しない。

### 指示書からの意図的な逸脱（この判断が正しい。元に戻さないこと）

当初の指示は「APIキーに紐づくメールが信頼済みリストに含まれれば自動承認」だった。
しかし `POST /api/v1/keys` は**メール所有確認なしで誰にでもキーを発行する**ため、
メール一致だけを条件にすると**第三者が自社ドメイン名義のキーを取って自動公開できる**状態だった（§5 の「第三者出品の自動承認禁止」に反する）。

→ **別シークレットで署名した信頼済みキー `mkt_` を必須**にした。
本番で「自社メールを騙った通常キー → pending 止まり」を実測確認済み。

`MAKIMONO_ADMIN_TOKEN` は Vercel の環境変数にのみ存在し、ローカルには残していない。

---

## §6 残作業（これだけやる）

### 6-1. 信頼済みキーを keyserve に載せる（本体リポのあるPCだけが実行できる。最優先）

出品側のPC（kim@ / seisaku-team@）は**まだ旧 `mk_` キー**なので、出品しても pending のまま止まる。
実測: 2026-08-28 時点で kim@ のPCの出品ログは published 71 / pending 1（残り1件は旧キーで出した当日分）。

**キーを Discord DM や口頭で配らないこと。** 会社には既に鍵の自動配布経路（keyserve）がある。
そこに1回入れれば全PCへ自動で届き、**人間の受け渡し作業がゼロになる**。

1. keyserve の Vercel 環境変数 `ORGIAST_KEYS_JSON`（プロジェクト `kimkon-s-projects/orgiast-keyserve`）に、
   信頼済みキーのエントリを追加する。配布クライアント（`tools/onboarding-sync.mjs` の `provisionKeys`）は
   **既存ファイルもキー単位でマージ更新する**ので、ファイル名が既存かどうかは気にしなくてよい
   （`mergeEnvFile` で該当キーだけ差し替え、他の値は保持される。実装を 2026-08-28 に確認済み）。
   ただし出品側の旧キーを壊さないよう、**`makimono.env` とは別の `makimono-trusted.env` に入れること**:

       "makimono-trusted.env": "MAKIMONO_TRUSTED_KEYS={\"kim@orgiast.jp\":\"mkt_…\",\"seisaku-team@orgiast.jp\":\"mkt_…\",\"<このPCのメール>\":\"mkt_…\"}"

   値は「メール → そのメール用の `mkt_` キー」の JSON。出品側は自分のメールに一致する1本だけを使う。
2. 出品側の受け取りは**実装済み**（`tools/makimono-publish.mjs` が `~/.claude/makimono-trusted.env` を読み、
   自分のメールに一致する `mkt_` キーがあればそれを優先して使う）。**出品側PCでの手作業は不要**。
3. 入れたら、出品側のPCで `node <repo>/tools/makimono-publish.mjs --check` を実行し、
   新規出品が `published` で返ることを確認する。

Vercel env の更新手順（このPCから実行できる）:

       vercel env pull は値を返さないので、既存の ORGIAST_KEYS_JSON を上書きする時は
       必ず「今の値を取得 → JSON に新キーを1つ足す → 書き戻す」の順で行う。
       既存キーを消すと他PCのAI実行者が全部止まる。

### 6-2. フォーム経由の10件は人が見る

出品者メールが無い（Webフォームから投稿された）10件は自動承認の対象外。
**第三者出品なので自動承認してはいけない。** 管理画面で人が中身を見て個別に承認/却下する。

### 6-3. やってはいけないこと（§5 から継続・不変）

- 第三者出品の自動承認（スパム・秘密情報の公開に直結する）
- 秘密情報スキャンの無効化・緩和
- 管理トークン（`MAKIMONO_ADMIN_TOKEN`）をクライアント（出品側PC）へ配布すること
- 既存の公開済み巻物の本文・slug の書き換え（URL が変わると参照側が壊れる）
- 署名なしの「メール一致だけで自動承認」へ戻すこと（上の「意図的な逸脱」を参照）

---

## §0 実行してよいPCかの判定（§6 に着手する前に必ず行う）

次を満たさなければ**何もせずに終了**する。「たぶんここだろう」で別のリポを書き換えない。

```bash
# 本体リポの特定: /api/v1/listings のハンドラを持つリポがあるか
grep -rl "api/v1/listings\|submissionId" --include=*.ts --include=*.tsx --include=*.js ~ 2>/dev/null | head
```

- 見つからなければ「このPCにマキモノ本体リポは無い」と1行報告して終了する
- 見つかったら、そのリポで `git remote -v` と `vercel projects ls` を確認し、
  **`makimono-md` の本番デプロイ元であることを確かめてから**着手する

---

## 付録: 当初の設計（実装済みの内容。参照用）

### 信頼済み出品者の自動承認

出品ハンドラ（`POST /api/v1/listings`）に、承認判定を1か所だけ置く。

- 信頼済みキー（別シークレットで署名した `mkt_`）からの出品で、**かつ既存の秘密情報スキャンを通過**したものは、
  `pending` ではなく公開状態で登録する
- レスポンスは `{ ok: true, submissionId, status: "published", slug }`
  （クライアントが「公開まで到達した」ことをその場で判定できるようにするため）
- 信頼済みキーでない出品は**従来どおり `pending`**。ここは絶対に緩めない
- 設定が無ければ全件 `pending`（既定は安全側）

**スキャンを外してはいけない。** 自動承認するのは「審査の人手」であって「秘密情報チェック」ではない。

### 出品状態を問い合わせる API

```
GET /api/v1/listings/{submissionId}
→ { ok: true, submissionId, status: "pending" | "published" | "rejected", slug?: string, title: string }
```

- 認証: 出品時と同じ `Authorization: Bearer <apiKey>`。**自分が出したものだけ**返す
- 存在しない ID は 404。他人の ID も 404（存在を漏らさない）

### 滞留分の一括承認（管理用）

```
POST /api/v1/admin/approve
Authorization: Bearer <MAKIMONO_ADMIN_TOKEN>
body: { "submissionIds": ["sub_xxx", ...] }  // 省略時は信頼済みの pending 全件
→ { ok: true, approved: N, skipped: [{ submissionId, reason }] }
```

- `MAKIMONO_ADMIN_TOKEN` は本体の環境変数。**出品用 APIキーとは別物**にする
- 承認時にもう一度、秘密情報スキャンを通す（出品時から本文が変わっていない保証は無い）
- 重複タイトル・同一本文が既に公開済みなら `skipped` に入れて二重公開しない
