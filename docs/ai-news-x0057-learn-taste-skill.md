# X-0057: learn-taste — デザイン修正をルール化して再現するAIスキル

**AIニュース提案 X-0057**: セッション中のデザイン修正を捕捉し、ルールとしてDESIGN.mdやプロジェクトスキルに書き出すClaude Codeスキル `learn-taste` の導入。株式会社オージャストのウェブサイトUIをClaude Codeで調整する際、修正をルール化して再現可能なデザインワークフローとして活用する。

観測日: 2026-11-15

---

## 1. 概要

**learn-taste** は [emilkowalski/skills](https://github.com/emilkowalski/skills) が公開するClaude Codeスキルで、セッション中のデザイン修正（明示的な指示・エディット・やり直し・却下・暗黙の選択）を検出し、それぞれをルールとしてDESIGN.mdやプロジェクトスキルに書き出す。

| 項目 | 内容 |
|---|---|
| 提供元 | emilkowalski/skills（オープンソース、79エージェント） |
| インストール | `npx skills@latest add emilkowalski/skills --skill learn-taste` |
| インストール先 | `~/.claude/.agents/skills/learn-taste/`（Claude Code, Codex, Gemini CLI, GitHub Copilot +15 環境にユニバーサル対応） |
| セキュリティ | Gen: Safe / Socket: 0 alerts / Snyk: Low Risk |
| 呼び出し | `/learn-taste` — 現在のセッションから修正を収集・ルール化（報告のみで停止） |
| バリアント | `/learn-taste <sessions>` — 過去Nセッションのトランスクリプトも読む |
| 追記 | `write all` / `write 1,3` — 承認されたルールだけを書き込む |
| 整理 | `/learn-taste prune` — DESIGN.md 内の重複・矛盾の統合を提案 |

---

## 2. なぜデザイン修正のルール化が重要か

### 2.1 改善点

| 問題 | 従来のワークフロー | learn-taste導入後 |
|------|------------------|-----------------|
| 同じデザイン修正を毎回受ける | 修正はセッション内で忘れられる | 次回セッション開始時にDESIGN.mdを読み、ルール化された修正を再現 |
| 修正が暗黙的 | ユーザーが「Smaller.」「Ok」と繰り返す理由が記録されない | 最終着地点（値・トークン）をルール化、なぜそこに着いたかが追跡可能 |
| ルールが散逸 | CLAUDE.md、DESIGN.md、スキルファイルに点在 | learn-tasteが一貫したフォーマットでDESIGN.mdに集約 |
| 新エージェントの学習曲線 | 過去の修正を知らずに同じミス | ルールがエージェント変更間で生き残る |

### 2.2 5つの修正信号

learn-tasteが検出する修正の種類:

| 信号 | 例 | ルール化の価値 |
|------|-----|--------------|
| 明示的修正 | "No, semi-transparent shadow, not a border" | 直接ルールに変換可能 |
| サイレントエディット | ファイルの外部変更で `duration: 400` → `200` | 暗黙のテイストを掘り起こす |
| 繰り返し調整 | "Smaller." → "Still too big." → "Ok" | 最終着地点のみを記録 |
| 却下・差し戻し | "Undo that"、バリアントBを選択 | 「してはいけないこと」の辞書 |
| 確認された非自明な選択 | "Yes, keep the icon outside the button" | 新鮮なエージェントが迷う分岐点 |

---

## 3. インストール

### 3.1 実行したコマンド

```bash
cd ~/.claude
npx skills@latest add emilkowalski/skills --skill learn-taste
```

### 3.2 インストール結果

- 79エージェントが検出され、うち1スキル（learn-taste）を選択
- インストール先: `~/.claude/.agents/skills/learn-taste/`
- セキュリティ評価: **Gen: Safe** / Socket: 0 alerts / Snyk: Low Risk
- 対応環境: Claude Code, Codex, Gemini CLI, GitHub Copilot, Amp, Cline +15
- Claude Codeへのsymlink作成済み

### 3.3 インストール後のファイル構造

```
~/.claude/.agents/skills/learn-taste/
└── SKILL.md          # スキル定義（Phase 1〜6のワークフロー）
```

---

## 4. learn-tasteのワークフロー

### Phase 1: 修正の収集
現在の会話から全ターンを読み、5つの信号を検出する。過去セッションのトランスクリプトも指定可能。

### Phase 2: フィルタリング
各修正を以下のツリーで判定:
- 別のコンポーネントでも起きるか？ → Noならスキップ
- 既存ルールでカバーされているか？ → Yesなら強化
- コードマッチで検出可能か？ → チェック候補
- グローバルルールかプロジェクトルールか？

### Phase 3: 一般化とWhyの特定
最も狭いレベル（Instance / Class / Universal）でルールを書き、ユーザーの理由または推定理由を付与。

### Phase 4: 格納先の決定
チェック候補 → リントルール・トークン制限・テスト
DESIGN.mdの該当セクションが〜40行超 → プロジェクトスキルに分離
デフォルト → DESIGN.md

### Phase 5: 報告
ルールの候補一覧・確認が必要な質問・競合一覧・スキップされた修正を報告。ここで停止。

### Phase 6: 承認後書き込み
ユーザーが `write all` または `write 1,3` で承認した項目のみを書き込む。

---

## 5. オージャストでの活用シーン

### 5.1 ウェブサイトUI調整の再現性向上

| シーン | 従来 | learn-taste活用後 |
|--------|------|-----------------|
| 価格表のスタイル調整 | 毎回「文字をもっと大きく」「余白を広く」と指示 | 前回の調整値がルール化され、初回から正しい値で生成 |
| スマホ表示の修正 | 「カードを1列に」「タップターゲットを48px以上に」を毎回手修正 | ルールとしてDESIGN.mdに記録、次回から自動適用 |
| フォームデザイン | 入力欄の高さ・ボタンの色を毎回調整 | ルールが一律適用され、一貫性が向上 |
| 色・トークン選択 | ブランドカラーとトークンの対応を都度説明 | ルールによりトークン選択が自動化 |

### 5.2 導入ステップ

| # | ステップ | 内容 | 状態 |
|---|---------|------|------|
| 1 | スキルのインストール | `npx skills@latest add emilkowalski/skills --skill learn-taste` | ✅ **完了** |
| 2 | 初回実行 | `/learn-taste` または `/learn-taste look at my last 3 sessions too, I keep fixing the same things` を対話セッションで実行 | ⏳ **未実行**（ヘッドレスでは実行不可） |
| 3 | DESIGN.mdの確認 | learn-tasteが提案するルールをレビューし `write all` で承認 | ⏳ |
| 4 | AIニュース文書化 | 本ドキュメントの作成 | ✅ **完了** |
| 5 | 運用定着 | Claude Code起動時にDESIGN.mdが読み込まれることを確認 | ⏳ |

---

## 6. 制約と注意点

| 制約 | 内容 |
|------|------|
| **対話セッション必須** | `/learn-taste` はスラッシュコマンドであり、ヘッドレス（`claude -p`）では実行不可。対話セッションで初回実行が必要 |
| **トランスクリプトの読取権限** | 過去セッションを読むには `~/.claude/projects/*/` への読み取り権限が必要 |
| **DESIGN.mdの読込設定** | `CLAUDE.md` または `AGENTS.md` で `Before building or changing UI, read DESIGN.md.` の行が必要。設定がないとルールが読まれない |
| **disable-model-invocation: true** | このスキルはモデル（Claude自身）からは呼び出せない。ユーザーが明示的に `/learn-taste` と入力する必要がある |
| **ルールの品質** | 一般化レベル（Instance / Class / Universal）の判断はスキルに委ねられる。誤った一般化は逆効果になるため、提案を鵜呑みにせずユーザー自身の確認が必須 |

---

## 7. 結論

learn-tasteは、Claude Codeでのデザインワークフローにおける**「同じ修正を繰り返す」問題**に対する実用的な解決策を提供する。ユーザーのデザイン判断をルールとして蓄積し、DESIGN.mdに一元管理することで、エージェントのデザイン出力の一貫性と再現性を段階的に向上させられる。

インストールは1コマンドで完了し、セキュリティリスクも低い。初回の `/learn-taste` 実行は対話セッションで行う必要があるが、その後はClaude Code起動のたびにルールが自動反映される状態になる。

オージャストのウェブサイトUI調整において、learn-tasteを活用することで、価格表・フォーム・モバイル表示など頻繁に調整する箇所の修正サイクルを短縮し、デザインの一貫性を維持できる見込み。