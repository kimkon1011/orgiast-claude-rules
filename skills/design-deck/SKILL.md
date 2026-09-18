---
name: design-deck
description: 「提案書」「企画書」「営業資料」「プレゼン」「デッキ」「スライド」「ブースプラン」「パース入り資料」「見せる資料」「デザインして」「かっこよく」など、見た目が評価対象になる資料の作成・修正依頼では必ず使う。学会1枚資料のような定型の量産物・数表主体の実務資料は対象外で、従来の HTML→PDF を使う。
---

# 見せる資料は Genspark AI Slides で作る

ユーザーの目視レビューと修正負担を減らすため、見た目が評価対象になる複数ページ資料は Claude が HTML/CSS で組まず、Genspark AI Slides に生成させる。修正依頼でも HTML を直さず、Genspark に再生成させる。

## 1. 対象を判定する

- 対象: 提案書、企画書、営業資料、プレゼン、デッキ、スライド、ブースプラン、パース入り資料など、見た目が評価対象になる資料。
- 対象外: 学会1枚資料のような定型の量産物、数表主体の実務資料。従来の HTML→PDF を使う。

## 2. 前提と認証を確認する

対象アカウントは `seisaku-team@orgiast.jp`（Genspark Pro契約）。CLI は初回実行時に自動インストールされる。

```text
gsk --help
gsk login-info
```

`gsk login-info` の `data.email` が `seisaku-team@orgiast.jp`、`data.plan` が `pro` であることと、`data.credit_balance` を確認する。未ログインの場合だけ `gsk login` を実行する。

## 3. 素材と原稿を準備する

1. 写真素材を Drive の素材フォルダに集約し、アップロード前に目視選別する。Reブース写真素材の例はフォルダID `1hRRRV2hAXH_cjoFOd_YF0KPFE-xwrIgb`。
2. 次の写真は候補から除外する。
   - 来場者が少なく、ブースがまばら・閑散として見える写真
   - 設営中・搬入中など未完成の状態が写っている写真
   - 床にゴミ・養生材・梱包資材が写っている写真
   - 社員だけの私的な集合写真
3. 他社ロゴが大きく写っている写真はモザイクをかける。社長提供のパース素材がある場合は、AI生成パースを使わない。
4. 採用するのは、完成後のブース、賑わっている来場者、接客・商談、施工完了後のきれいな仕上がりなど、対外的に見せてよい写真だけにする。目安は10〜15枚。
5. 原稿を Markdown にし、全ページをページ番号付きで保持する。数値や表を含め、要約・省略しない。

## 4. 写真を Genspark にアップロードする

写真ごとに1枚ずつ順番に実行し、並列化しない。

```text
gsk upload <ローカル画像パス>
```

返り値の `data.file_wrapper_url` を保存する。このURLは Genspark 内部限定で、外部ツールからは403になるため使い回さない。各URLには `cover-hero(表紙向け)`、`leads-crowd 来場者の賑わい1` のような短い日本語ラベルを付ける。

## 5. スライド生成タスクを作る

プロンプト本文に改行・引用符・`$` を含むため、`--query` に直書きせず JSON の `--args-file` を使う。

```json
{
  "task_name": "<プロジェクト名>",
  "query": "<企画書テキスト全文 + 写真URL一覧（ラベル付き）を1本のテキストとして埋め込む>",
  "instructions": "<構造・文体・出力形式の指示>"
}
```

`query` は次の順で組む。

1. 「以下の企画書テキスト（全◯ページ・ページ順）をもとに、日本語で『◯◯提案書』を◯ページ前後のスライドとして作成してください。写真を大きく使い、余白を多めに、見出しは短くしてください。写真素材（下記URL、内容ラベル付き）を各ページの内容に合わせて自由に配置してください。」という生成指示。
2. `--- 企画書テキスト ---` の下に、元資料の全ページをページ番号付きでそのまま貼る。数値・表も省略しない。
3. `--- 写真素材(URL・内容ラベル) ---` の下に、`<ラベル>: <file_wrapper_url>` 形式で全画像を1行ずつ列挙する。
4. 写真を置くページは指定せず、Genspark の判断に任せる。

`instructions` には、日本語、想定読者、写真を大きく、余白を多め、見出しを短く、PPTX/PDFでエクスポート可能、写真配置はAI裁量、を記す。

```text
gsk task create slides --args-file <path-to-args.json>
```

社長から `ultra` の明示指示がある場合だけ `--slides_tier ultra` を付ける。それ以外は standard のままにする。`--wait` は付けない。`slides` タスクでは `--attach` / `--image` / `--file` を使わず、写真は必ず `gsk upload` のURLで渡す。

## 6. 完了を待って取得する

作成時に返る `data.run_id`、`data.project_id`、`data.task_url` を保存する。30〜60秒間隔で次を実行する。

```text
gsk task status <run_id>
```

`data.state` が `queued` / `running` の間は待ち、`succeeded` になったら完成。同じ内容で `gsk task create slides` を再実行して二重生成・二重課金しない。写真15枚＋約11ページの実績は約15〜20分。

```text
gsk task export <project_id> --format pdf -o <出力先.pdf>
gsk task export <project_id> --format pptx -o <出力先.pptx>
```

保存先は各レスポンスの `data.local_path` で確認する。

## 7. Drive保存と目視確認を行う

既存の `media-kit-node/drive-upload.mjs` と同じ手順で、PDFとPPTXを Drive の「作業ファイル」直下へ保存する。

```text
node drive-upload.mjs <ローカルファイル> <Drive上のファイル名> <MIMEタイプ> <作業ファイルのフォルダID>
```

- PDF: `application/pdf`
- PPTX: `application/vnd.openxmlformats-officedocument.presentationml.presentation`
- 続けてアップロードする場合は1〜2秒間隔を空ける。
- 返り値の `LINK=` を共有リンクとして使う。

PDFの各ページをPNG化し、Readで全ページを目視する。写真選定基準、余白、文字量、ページ抜け、崩れを確認してから完了とする。kim には Drive URL に `?authuser=kim@orgiast.jp` を付けて渡す。

## 8. 修正と代替経路

- 修正依頼が来たら Claude が HTML/CSS を直さず、原稿・素材・指示を直して Genspark に再生成させる。目的はユーザーの目視レビュー回数を減らすこと。
- Genspark が使えない場合、表紙など単発ページだけは Gemini 画像モデルを使う。複数ページを一貫したデザインで作る用途には使わない。
- Gemini の認証情報ファイル（`~/.gemini/.env` 等）を新規スクリプトから直接読む操作は、手順書の実測で classifier に拒否された。既存の許可済みリポジトリスクリプト（例: `gen-image.mjs`）を使う・拡張する。
- Canva は使わない。写真投入には公開URLが必要だが、Genspark の `file_wrapper_url` は外部から403になり、Driveの公開共有化は auto mode classifier に止められるため、写真を渡す経路がない。
