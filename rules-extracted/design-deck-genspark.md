# 見せる資料は Genspark AI Slides で作る

ONBOARDING.md §1.19.2 の詳細ルール。2026-09-19、kim 決定。

## 対象

提案書、企画書、営業資料、プレゼン、デッキ、スライド、ブースプラン、パース入り資料など、見た目が評価対象になる資料の作成・修正では `/design-deck` を必ず使う。Claude は HTML/CSS でデザインを組まない。修正も HTML を直さず、Genspark AI Slides に再生成させる。

学会1枚資料のような定型の量産物、数表主体の実務資料は対象外で、従来の HTML→PDF を使う。

## 理由

同じ写真素材と原稿によるブースプラン案で、Claude の HTML/CSS は写真の使い方について3回差し戻しになった一方、Genspark AI Slides の1版目は「すばらしい」と評価された。写真の使い方 / 余白 / 文字量の5点満点評価は Claude が 3 / 3 / 2、Genspark が 5 / 4 / 4、Gemini画像が 5 / 5 / 5（単発ページのみ）。デザイン修正に伴うユーザーの目視レビュー負担を減らすことが目的。

## 制作ルール

- 写真は Drive の素材フォルダへ集約し、目視選別後に `gsk upload` で1枚ずつ順にアップロードする。
- まばら・閑散、設営中・搬入中、床のゴミ・養生材・梱包資材、私的集合写真は使わない。
- 他社ロゴが大きければモザイクをかける。社長提供のパース素材があればAI生成パースを使わない。
- 原稿はMarkdownにし、数値・表を省略せずページ番号付きで `gsk task create slides --args-file <path-to-args.json>` に渡す。
- 生成完了後はPDF/PPTXを取得し、Driveの「作業ファイル」直下へ保存する。PDFをページPNG化し、Readで全ページを目視する。
- kim への共有URLには `?authuser=kim@orgiast.jp` を付ける。
- Reブース写真素材フォルダ例: `1hRRRV2hAXH_cjoFOd_YF0KPFE-xwrIgb`。

実行手順、認証確認、プロンプトの型、完了待ち、エクスポート、Drive保存は `skills/design-deck/SKILL.md` に従う。

## 代替

Genspark が使えない場合、Gemini画像モデルは表紙など単発ページだけに使う。Canva は使わない。写真投入に公開URLが必要だが、GensparkのURLは外部から403となり、Driveの公開共有化は auto mode classifier に止められるため。

Gemini の認証情報を新規スクリプトから直接読む操作も、手順書の実測で classifier に拒否された。既存の許可済みリポジトリスクリプト（例: `gen-image.mjs`）を使う・拡張する。
