# X-0031: Copilotスキルで手順を仕組み化 — PowerPoint / Copilot Cowork / GitHub Copilot

**AIニュース提案 X-0031**: いま開いている資料を伝わる形に整えたい→PowerPointスキル。メール・予定・Teamsをまたいで調べる・準備する仕事を任せたい→Copilot Coworkスキル。毎日繰り返す業務をアプリやフロー、エージェントとして仕組みにしたい→GitHub Copilotスキル。株式会社オージャストではブース制作資料やウェブサイトUI・開発の自動化にこれらのスキルを試す。

観測日: 2026-11-12

---

## 1. 概要

Microsoft 365 Copilot の「スキル」体系は、Copilot の機能を**ファイル操作・横断調査・コード自動化**の3層に整理したもの。2026年秋〜冬にかけて順次提供が進んでおり、特に **PowerPointスキル**、**Copilot Cowork（旧 Workforce）スキル**、**GitHub Copilot スキル** が 株式会社オージャストのブース制作・ウェブ開発に直接有用である。

| スキル | できること | オージャストでの主用途 |
|---|---|---|
| **PowerPoint スキル** | 開いている資料から見栄えの良いスライドを自動生成／企業テンプレート／ブランドキット反映 | 制作提案書・見積説明資料・イベント企画書の自動作成 |
| **Copilot Cowork スキル** | メール・予定・Teams・ファイルを横断して情報を集約・準備 | 案件情報の横断調査・顧客準備・社内調整の自動化 |
| **GitHub Copilot スキル** | 繰り返し業務をアプリ・フロー・エージェントとして仕組み化 | サイトUI自動化・データパイプライン・社内ワークフロー |

---

## 2. 各スキルの詳細と適用判断

### 2.1 PowerPoint スキル — 資料を伝わる形に整える

**何ができるか:**
- 開いている情報（PDF・Web・メモ・Word・Excel）を解析し、**PowerPoint スライドに自動構成**
- 社内ブランドテンプレート／ブランドキットの自動適用（フォント・配色・ロゴ配置）
- グラフや表を PowerPoint ネイティブオブジェクトとして貼り込み、後から手動編集可能
- 自然言語指示（「この資料を3枚の提案スライドにして。導入・メリット・事例の順」）でレイアウト作成

**オージャストでの活用:**

| 用途 | 入力 | 出力 | 効果 |
|---|---|---|---|
| ブース制作提案書の自動作成 | 案件Doc（Drive の要件定義・写真・見積） | テンプレート適用済みの提案スライド | 提案書作成時間を80%削減 |
| 見積説明資料 | 見積書（スプレッドシート）＋工数内訳 | 工数・価格・スケジュールの説明スライド | 顧客説明を効率化・ミス減少 |
| イベント企画書 | 企画メモ＋会場資料＋過去事例 | 構成済みの企画スライド | 複数案の一括生成で比較検討を迅速化 |
| 社内報告資料 | 週次進捗・KPIデータ | 定型フォーマットの報告スライド | 報告作成の手間をゼロに |

**導入条件:**
- Microsoft 365 Copilot ライセンス（Copilot for Microsoft 365、ユーザー月額$30）
- SharePoint／OneDrive へのブランドテンプレート配置
- 社内ブランドキット（色・フォント・ロゴ）の事前設定

### 2.2 Copilot Cowork スキル — 横断調査と準備を任せる

**何ができるか:**
- **メール・予定・Teams・ファイル・People をまたいで**「この案件について準備して」の1指示で情報収集
- 過去の類似案件・顧客とのやり取り・関連ファイルの自動検索と要約
- 会議の準備（アジェンダ案・関連資料の添付）を自動実行
- タスクの作成・割り当て・期限設定を含む「仕事の準備」まで完結

**オージャストでの活用:**

| 用途 | 指示例 | 効果 |
|---|---|---|
| 案件着手前の情報収集 | 「XX社のブース案件について、これまでのやり取りと過去の類似案件をまとめて」 | 案件ごとの事前調査時間を90%削減 |
| 顧客打ち合わせ準備 | 「XX社との来週の打ち合わせの準備をして。前回の議事録と見積もりを添付して」 | 準備漏れゼロ・アジェンダ自動生成 |
| 定例報告の下準備 | 「今週の全案件の進捗を顧客別にまとめて」 | 報告業務の自動化 |
| クレーム・問い合わせ対応 | 「XX社からの問い合わせ内容と、過去の類似対応をまとめて対応案を提案して」 | 初動の迅速化・対応品質の均一化 |

**導入条件:**
- Microsoft 365 Copilot ライセンス（同上）
- 社内データが SharePoint／Exchange／Teams に統一的に保存されていること
- Teams チャネルの整理（案件別チャネル・ファイル命名規則）
- **注意点**: データが散在（ローカルファイル・Google Workspace・Discord 等）していると効果が半減する。Google Workspace を主に使っている現状（seisaku-team@orgiast.jp）では、**Google Workspace 連携（Copilot for Google Workspace またはサードパーティ連携）が必要**。純粋な Microsoft 365 Copilot では Drive／Gmail を横断できない。

**※ Microsoft 365 Copilot と Google Workspace の併用戦略が必要。** 現状の Google Workspace 主体の運用では、Copilot Cowork スキルの効果は限定的。以下の選択肢がある:

| 選択肢 | コスト | 効果 |
|---|---|---|
| **A. Google Workspace に統一し Gemini 連携を強化** | Google Workspace ライセンス内で完結（追加費用なし） | Gemini の Gmail／Drive／Calendar 横断検索・要約を活用 |
| **B. Microsoft 365 へ移行** | ライセンス移行コスト大・移行期間の業務停滞 | Copilot Cowork スキルのフル活用が可能 |
| **C. ハイブリッド運用** | 両方のライセンス費用＋連携ツール | 用途に応じて使い分け・連携に工夫が必要 |

**推奨: A（Google Workspace 統合＋Gemini）**。移行コストを考慮すると、現状の Google Workspace 基盤を維持し、Gemini の横断調査能力を活用する方が現実的。Gemini は Gmail／Drive／Calendar とネイティブ連携しており、Copilot Cowork スキルと同等の機能を Google Workspace 内で実現できる。

### 2.3 GitHub Copilot スキル — 業務を仕組み化する

**何ができるか:**
- 繰り返し業務の**アプリ化・フロー化・エージェント化**を GitHub Copilot（Claude Code／Codex とは別の文脈で、Microsoft／GitHub が提供する Copilot 製品群）で実現
- GitHub Copilot Chat で自然言語から GitHub Actions ワークフローを生成
- GitHub Copilot Extensions で社内ツール・API を Copilot から操作可能に
- GitHub Copilot Workspace（プレビュー）で Issue → PR のワークフローを Copilot が自動生成

**オージャストでの活用:**

| 用途 | 仕組み化対象 | 実装方法 |
|---|---|---|
| 価格更新パイプライン | モノタロウ提出表 → サイト価格同期 | GitHub Actions 定期実行（TSV変換→apply） |
| SEO 監視・改善ループ | GSCデータ取得 → 推奨生成 → PR作成 | GitHub Copilot Agent Mode で Issue 駆動の改善サイクル |
| 案件管理の自動化 | Drive の案件Doc → 進捗追跡 → 報告 | GitHub Copilot Workspace で Issue テンプレート→PR |
| UI 開発の標準化 | 要件 → コンポーネント実装 → レビュー | GitHub Copilot のコード生成＋レビュー支援 |
| デプロイ自動化 | ブランチ → CI → 本番反映 | GitHub Actions（Copilot Chat で生成） |

**GitHub Copilot スキルと現在の Codex 委委譲の棲み分け:**

| 軸 | GitHub Copilot スキル | Codex（現在の実装） |
|---|---|---|
| 操作範囲 | GitHub エコシステム内（コード生成・Actions・Issue） | CLI からの任意コード生成・ファイル操作 |
| 自動化の単位 | Issue → PR → マージのワークフロー全体 | 単一指示のコード生成・編集 |
| コスト構造 | Copilot ライセンス（月額 個人$10 / Business $19） | Codex 定額プラン（枠内）＋超過分は従量 |
| 連携 | GitHub ネイティブ（コードレビュー・Actions） | 任意のスクリプト・CLI（汎用性が高い） |

**両者は競合ではなく補完関係。** GitHub Copilot は GitHub 上のワークフロー自動化（Issue → PR → CI → デプロイ）を得意とし、Codex はより汎用的なファイル操作・コード生成（手順書からの実装・データ変換等）を担当する。

**導入条件:**
- GitHub Copilot ライセンス（Business 推奨：チーム管理・ポリシー制御・プライバシー）
- GitHub にプロジェクトが存在すること（orgiast-claude-rules は既に対応）
- .github/workflows/ へのワークフロー記述の浸透
- GitHub Copilot Extensions のための社内 API の整備

---

## 3. 優先順位と推奨アクション

### Phase 1（即日〜1週間）: 導入判断と環境準備

1. **PowerPoint スキル**: Microsoft 365 Copilot のトライアルライセンス取得（既存の Business Standard から Copilot アドオン$30/ユーザー/月を追加）。社内ブランドキット（フォント・色・ロゴ）を SharePoint に配置。
2. **Google Workspace + Gemini 検証**: 現状の Google Workspace 運用で Gemini の横断調査（Gmail 要約／Drive 検索／Calendar 連携）がどの程度使えるかを実測。Copilot Cowork に代わる基盤としての評価。
3. **GitHub Copilot Business**: 1ライセンス契約（$19/月/ユーザー）。Actions のテンプレート生成・コードレビュー支援を test。

### Phase 2（1〜2週間）: パイロット実装

1. **PowerPoint スキル試行**: 実際の案件資料（ブース提案書）を PowerPoint スキルで生成 → 修正箇所・品質を評価
2. **Gemini 横断調査の評価**: 案件着手前の情報収集を Gemini で実行 → 出力品質・網羅性を評価。Copilot Cowork 相当の機能が実現できるか判断
3. **GitHub Copilot の自動化試行**: 簡単な業務フロー（価格更新の一部）を GitHub Copilot Workspace で Issue→PR 化

### Phase 3（2〜4週間）: 定着と拡大

1. **PowerPoint スキル定型化**: 提案書・見積説明・報告書のテンプレートを整備し、Copilot 生成を社内フローに組み込み
2. **Gemini 横断調査のフロー化**: 案件着手時の「事前調査コマンド」を定型プロンプトとして整備
3. **GitHub Copilot パイプライン構築**: SEO 改善ループ・価格更新パイプライン・案件管理の一部を GitHub Copilot ワークフローに移行

---

## 4. 注意点・リスク

- **Microsoft 365 Copilot と Google Workspace の非互換**: Copilot Cowork スキルは Microsoft 365 のメール・カレンダー・ファイルを横断する。現状 Google Workspace 主体の seisaku-team@ では効果が出ない。**Copilot スキル導入前にデータ基盤の方向性を決める必要がある。**
- **Gemini は Microsoft Copilot の完全代替ではない**: Gemini は Gmail／Drive の横断検索・要約に強いが、PowerPoint スキルのような「開いている資料をリアルタイムにスライド化」には対応していない。用途別に使い分ける。
- **GitHub Copilot の権限管理**: Business ライセンスでは IP 単位・リポジトリ単位のポリシー制御が可能。機密情報を含むリポジトリへのアクセス制限を事前設定する。
- **AI 生成スライドの品質**: 自動生成されたスライドは内容の正確性・数値の最新性・ブランドガイドライン適合を人間が確認するフローを組む。**提案書の誤情報は顧客との信頼に関わる。**
- **ライセンスコストの積み上げ**: 3スキルすべてを最大限使う場合、ユーザーあたり月額$49〜$59（Copilot M365 $30 + GitHub Copilot $19〜）の追加コスト。費用対効果を Phase 1 で実測してから判断する。

---

## 5. 結論

| スキル | オージャストでの優先度 | 推奨アクション | 開始条件 |
|---|---|---|---|
| **PowerPoint スキル** | 高い（提案書・見積・企画書の作成効率が劇的に向上） | Copilot M365 トライアル → テンプレート整備 → パイロット | トライアルライセンス |
| **Copilot Cowork スキル** | **保留（データ基盤が Google Workspace のため）** | Gemini の横断調査能力を先に評価し、足りない部分のみ Microsoft 365 移行を検討 | Gemini 評価完了 |
| **GitHub Copilot スキル** | 高い（既存の Codex 委譲と補完・現状の GitHub 基盤で即試行可能） | Business ライセンス契約 → 簡単なフローから自動化試行 | GitHub Copilot Business 契約 |

**3スキル中、最も即効性が高いのは PowerPoint スキル（提案資料の自動作成）と GitHub Copilot スキル（開発の仕組み化）の2つ。** Copilot Cowork スキルは Google Workspace 基盤との折り合いをつける必要があるため、まず Gemini の横断調査能力を評価し、その結果で Microsoft 365 移行の要否を判断する。

株式会社オージャストのブース制作・ウェブ開発の自動化において、Copilot スキルは「人がやっている作業を Copilot に任せる」というより、**「人が判断すべきこと（企画・方向性）と、AIに任せるべきこと（資料作成・準備・実装）を Copilot スキルで切り分ける」** という設計思想での導入が効果的である。
