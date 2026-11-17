---
description: SEO・表示品質のミスを防止する自動生成ルール
source: tools/mistake-registry/registry.json
version: 1
---

# SEO・表示ルール

## SEO-001: meta description
head 内に meta description が必須。新規HTMLファイル作成時に `<meta name="description" content="...">` を含める。

## SEO-002: HTML言語
`<html>` に `lang="ja"` が必須。HTML生成時に必ず付与する。

## SEO-003: viewport
新規HTMLには viewport meta タグを含める。

## SEO-004: 画像代替テキスト
全ての `img` に、用途に合った `alt` 属性を付与する。

## SEO-005: ページタイトル
head 内に空でない `title` タグを必須とする。

## SEO-006: 主見出し
ページ構造に `h1` を1つ以上含める。

## UI-001: フォーカス表示
インタラクティブ要素には `:focus-visible` スタイルを設定する。

## UI-002: タップターゲット
ボタン・リンクの最小高さは44pxとする。

## UI-003: アイコンボタン名
アイコンのみの button には内容を説明する `aria-label` を付与する。

## UI-004: カスタム操作要素
クリック可能な非セマンティック要素には適切な `role="button"` または `role="link"` を付与する。
