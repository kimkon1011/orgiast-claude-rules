# X-0012: 製品デザイン用AIスキル8選 — Claude CodeでロードするUI設計の新しい常識

観測日: 2026-11-11。出典: AIニュース提案 [X-0012]。
本稿は、Claude Code 等のAIコーディングエージェントに「デザインの目」を与える8つのスキルを体系的に紹介し、株式会社オージャストの展示会ブース紹介サイト（orgiast.jp）のUI改善に適用する手順を提案する。

---

## 背景: スキルとは何か

AIコーディングエージェント（Claude Code, Cursor, Codex CLI, Gemini CLI 等）の「スキル」は、タスク前にロードする指示セットである。従来の「要件を文章で書いてコードを生成させる」アプローチに対し、スキルは以下を実現する:

- **デザイン語彙の統一**: 「polish」「critique」「bolder」といった設計コマンドをエージェントが理解する
- **品質ゲートの自動化**: 生成後にセルフチェック（撮影・採点・監査）を実行し、合格するまで修正を繰り返す
- **設計意図の保持**: 毎回の生成で同じ品質基準が適用されるため、一貫性が保たれる

本稿で扱う8スキルは、アニメーションデモからブランドアイデンティティ設計、受賞サイト参照までカバーする。

---

## 8スキル一覧

| # | スキル名 | 作成者 | インストール | 主な用途 |
|---|---------|--------|------------|---------|
| 1 | **Stageshow** | Benji Taylor | `npx skills add benjitaylor/skills --skill stageshow` | アニメーションデモ生成（Reactコンポーネント） |
| 2 | **Impeccable** | pbakaus | `npx skills add pbakaus/impeccable` | UI改善の24コマンド（polish/critique/audit等） |
| 3 | **Dimensional Drawing** | enesozturk | `npx skills add enesozturk/dimensional-drawing` | Apple風モノクロ仕様書の自動生成 |
| 4 | **Oil UI** | oil-oil | `npx skills add oil-oil/oil-ui` | 複数デザイン方向の比較検討と実ブラウザプレビュー |
| 5 | **Emil Kowalski's skills** | emilkowalski | `npx skills add emilkowalski/skills` | アニメーションルール（review-animations / animate） |
| 6 | **Taste Skill** | Leonxlnx | `npx skills add Leonxlnx/taste-skill` | figma.com/x.ai 級のプロフェッショナルサイト構築 |
| 7 | **Brand Identity** | rampstackco / cofoundy | `npx skills add cofoundy/brand-skills` | ロゴ・カラー・フォント・ブランドガイドライン |
| 8 | **Awwwards MCP** | INSANE0777 | `claude mcp add awwwards -- npx -y awwwards-mcp` | 受賞サイトのデザインDNA抽出と再現 |

各スキルの詳細を以下に述べる。

---

## 1. Stageshow — アニメーションデモ

**概要**: プロダクトUIのアニメーションデモをReactコンポーネントとして生成する。デスクトップ・スマホの両サイズ対応。生成後はセルフリハーサル（撮影・チェック）を実行し、品質基準を満たすまで修正を繰り返す。

**特筆点**:
- 実CSS/Tailwindの色・フォント・角丸を読み取ってスタイルに反映
- デモは10〜16秒のループに収める

**オージャスト活用例**: ブース紹介ページのトップヒーローに、Re:ブースの組み立て〜完成〜来場者の3モーメントループデモを配置する。

## 2. Impeccable — UI改善の24コマンド

**概要**: 62のルールベース検出器（LLM不要・APIキー不要）で「AIスロップ」（不自然な間隔・スキップされた見出し・低コントラスト等）を自動検出。24のコマンドで構成される。

**コマンド分類**:
- **Steer系**: bolder, quieter, distill, colorize, typeset, layout, animate, delight, overdrive
- **Review系**: critique（スコア付きUXレビュー）, audit（技術品質レポート）
- **Finish系**: polish, harden, clarify, adapt, optimize, onboard
- **Plan系**: shape, init, document, extract

**オージャスト活用例**: 既存の展示会事例ギャラリーに対して `/impeccable critique` を実行し、具体的な改善点をスコア付きで抽出する。

## 3. Dimensional Drawing — Apple風モノクロ仕様書

**概要**: UIコンポーネントや物理プロダクトのApple風モノクロ仕様書（スペックシート）をHTML1枚で生成。「アーキテクチャ優先・スロットベース・無ブランド」がルール。

**ルール**:
- モノクロのみ、変数コードで寸法表現（実数値不使用）
- 中身はスロット（`[TBD]`）、ダミーコンテンツ禁止
- CSSアニメーションでプロダクトを回転表示する `dimensional-drawing-motion` スキルも同梱

**オージャスト活用例**: Re:ブースの各構成パーツのスペックシートを統一フォーマットで生成し、提案資料に添付。

## 4. Oil UI — 複数デザイン方向の比較検討

**概要**: リサーチ→複数方向の比較ページ生成→実ブラウザ撮影→絞り込み→実装の5段階ワークフロー。デフォルト1方向だが、依頼すれば3〜5方向のvisually distinctなデザイン案を比較ページとして生成する。

**特筆点**:
- Playwrightで実レンダリングを撮影して確認（コードだけで判断しない）
- デスクトップ(1440×900)とモバイル(390×844)の両方を生成

**オージャスト活用例**: ブース一覧ページのリデザイン案を3方向（カードグリッド型・タイムライン型・マップ型）生成し、チームで選択。

## 5. Emil Kowalski's skills — アニメーションルール

**概要**: Framer Motion作者（emilkowalski）によるアニメーション品質基準。`animate`（生成）と `review-animations`（監査）の2スキル。

**review-animationsの10非交渉ルール**:
1. UIアニメーションは300ms未満
2. `transform` と `opacity` のみ（GPUコンポジット）
3. enter/exitは `ease-out`（`ease-in` 禁止）
4. `transform-origin` はトリガー位置基準
5. インターラプティブル（割り込み可能）
6. `prefers-reduced-motion` 対応
7. `transition: all` 禁止
8. `scale(0)` 禁止
9. 非対称なenter/exit（進入と退出で違うイージング）
10. レイアウトプロパティのアニメーション禁止

**オージャスト活用例**: 事例ギャラリーのホバーエフェクトやページトランジションをこの基準で見直す。

## 6. Taste Skill — プロフェッショナルサイト構築

**概要**: 247サイトの研究に基づく6〜10ステップのビルドプロセス。figma.com や x.ai レベルのサイトを生成する。ブラウザ実検証（1440/768/390px）とAwwwards加重ルーブリック採点（デザイン40%・操作性30%・創造性20%・内容10%）を通過するまで修正。

**特筆点**:
- 実際の写真（オープンアーカイブ）を使用、ダミー画像禁止
- WebGL/シェーダーはテック/ゲーム/ソフトウェア系のみ許可

**オージャスト活用例**: 全社サイトの「イベントプロデュース」ランディングページをTaste Skillで再構築し、現行版と比較検証。

## 7. Brand Identity — ブランドガイドライン設計

**概要**: 2つの主要なスキルセットがある。

**rampstackco/brand-identity**: ロゴシステム・カラー・タイポグラフィ・イメージ・アイコン・モーションの6領域をカバー。スタック・ツール非依存。

**cofoundy/brand-skills**: 16スキルセットで命名→アーキテクチャ→アイデンティティ→ボイス→ガイドライン→監査→修正の全パイプラインをカバー。70以上のエージェント対応。

**オージャスト活用例**: オージャストのブランドガイドライン（コーポレートカラー・フォント・ロゴ使用ルール）をcofoundyパイプラインでドキュメント化・自動監査可能にする。

## 8. Awwwards MCP — 受賞サイト参照

**概要**: Awwwards受賞サイトをデザインリファレンスとして参照できるMCPサーバー。自然言語検索・デザインDNA抽出・モーション分析・セクション再現・スコアリングが可能。無料・オフライン。

**機能**: 
- 自然言語で受賞サイト検索（「ダーク3Dポートフォリオ」「ソフトパステルEコマース」）
- カラーパレット・テクノロジースタック・デザイン要素を抽出
- 2〜5の参照サイトからデザインブリーフ作成
- バンドごとの再現（Vite/Astro/Next.js出力）

**オージャスト活用例**: 競合の展示会ブースサイトや同業の受賞デザインをリファレンスに、自社のイベント事例ページのデザイン方向を決定する。

---

## スキル選択基準（オージャストの用途別）

| タスク | 推奨スキル | 理由 |
|-------|-----------|------|
| トップページのアニメーションヒーロー | Stageshow | リハーサル付きアニメーションデモ生成が最適 |
| 既存UIの品質監査・改善 | Impeccable | 62ルールの自動スロップ検出＋critiqueコマンド |
| ブースパーツの仕様ドキュメント | Dimensional Drawing | Apple風の統一フォーマット提案書 |
| ページリデザインの方向性検討 | Oil UI | 複数案の比較ページを実ブラウザで確認可能 |
| アニメーション品質の統一 | Emil Kowalski's skills | 業界標準のアニメーションルールを自動適用 |
| 新規LPの高品質構築 | Taste Skill | figma.com級のクオリティをコードで実現 |
| CI/CDパイプラインへの品質組み込み | Dimensional Drawing + Impeccable | ルールベース検出＋仕様書自動生成でゲート化 |
| 競合分析からのデザイン方向決定 | Awwwards MCP | 受賞サイトのデザインDNAを客観的データとして取得 |

---

## インストール手順（Claude Code）

```bash
# Skills CLI の最新版をインストール
npx skills@latest

# 各スキルのインストール
npx skills add benjitaylor/skills --skill stageshow
npx skills add pbakaus/impeccable
npx skills add enesozturk/dimensional-drawing
npx skills add oil-oil/oil-ui
npx skills add emilkowalski/skills
npx skills add Leonxlnx/taste-skill
npx skills add cofoundy/brand-skills
claude mcp add awwwards -- npx -y awwwards-mcp
```

インストール先は `~/.claude/skills/`（グローバル）またはプロジェクトの `.claude/skills/`。各スキルは Claude Code の `/` スラッシュコマンドとして使用可能になる。

---

## 期待効果（推定）

| 指標 | 現状 | 導入後 | 備考 |
|------|------|--------|------|
| UI品質の一貫性 | 生成ごとにバラつく | スキルで統一基準が適用される | Impeccable + Emil Kowalski |
| デザインリサーチ時間 | 2〜3時間/回 | 15〜30分/回 | Oil UI + Awwwards MCP |
| 提案書作成時間 | 4〜8時間/件 | 30分〜1時間/件 | Dimensional Drawing |
| 新規LP品質 | 手直し多数 | 初版でAwwwards基準の70%以上 | Taste Skill |
| アニメーション品質 | 属人的 | 10ルールで機械的に担保 | Emil Kowalski's skills |

---

## 制約と注意点

1. **Node.js 要件**: Stageshow / Taste Skill は Node.js 20.19+ / 22+, Chrome ブラウザ必須
2. **API費用**: Impeccable はフルビルドで約 $7.49（46ターン）。部分適用を推奨
3. **スキル間の競合**: 同時ロード時のコマンド名衝突に注意（`/critique` 等）
4. **AIの品質限界**: スキルの指示に従うのはAIエージェント次第。人間の最終確認は必須
5. **学習曲線**: 各スキルのコマンド体系に習熟するまで初期コストがかかる

---

## 関連資料

- [Stageshow GitHub](https://github.com/benjitaylor/skills)
- [Impeccable 公式サイト](https://impeccable.style/)
- [Dimensional Drawing GitHub](https://github.com/enesozturk/dimensional-drawing)
- [Oil UI 公式サイト](https://ui.oiloil.org/en/)
- [Emil Kowalski's skills](https://github.com/emilkowalski/skills)
- [Taste Skill GitHub](https://github.com/Leonxlnx/taste-skill)
- [cofoundy/brand-skills](https://github.com/cofoundy/brand-skills)
- [Awwwards MCP GitHub](https://github.com/INSANE0777/awwwards-mcp)

## 関連タスク

| タスク | 関係 |
|--------|------|
| X-0015 | Craft Anything（サイト再現構築）— 補完的: Awwwards MCPで分析→Craft Anythingで再現 |
| X-0014 | Grok Bot + Claude Code — Oil UIのリサーチ工程をGrok Botに委譲可能 |
| X-0013 | 再現可能AIワークフロー — スキルの品質ゲートをLangGraphパイプラインに統合 |