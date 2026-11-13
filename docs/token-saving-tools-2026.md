# Claude Codeトークン節約GitHub 10選（2026年評価）

## 結論

`apps/expo-apply` は小規模・外部依存なしのため、常駐MCPや索引基盤を増やすより、**検索先行（01）＋短文規約（02/03）＋大出力の退避（05）＋ローカル計測（09）**が費用対効果と安全性に優れる。今回、この方針を `.claude/CLAUDE.md` と `tools/token-cost-report.mjs` に実装した。

削減率は各リポジトリの自己申告や特定条件のベンチマークであり、総請求額の削減率ではない。入出力の構成、キャッシュ、モデル、タスク成功率を揃えた前後比較が必要である。

## 評価表

| # | ツール | 仕組み | 公称・期待効果（概算） | 導入コスト | オージャストでの適用可否 | 推奨 |
|---:|---|---|---|---|---|---|
| 01 | [Token Savior](https://github.com/Mibayy/token-savior) | シンボル単位の構造検索、Bash出力圧縮、永続メモリをMCPで提供 | 作者ベンチで active token 約80%減。小規模repoでは索引の固定費が勝つ可能性 | 中（Python/MCP、初期索引、運用） | 規約だけ採用。現状のexpo-applyへ本体導入は過剰 | **採用（検索先行ルール）** |
| 02 | [claude-token-efficient](https://github.com/drona23/claude-token-efficient) | `CLAUDE.md` の短文規則で冗長な応答を抑制 | 作者例では出力約63%減。入力・ツール出力は減らない | 低（指示ファイル配置） | 既存規則と競合しない部分を短く移植可能 | **採用** |
| 03 | [Caveman](https://github.com/JuliusBrussee/caveman) | 出力スタイル/skill/proxyで説明を圧縮 | 作者主張で出力65%前後減。総トークンへの寄与は出力比率次第 | 低〜中（skillのみなら低、proxyは高） | 技術語・検証結果を残す軽量版が適合 | **採用（規約のみ）** |
| 04 | [token-optimizer-mcp](https://github.com/ooples/token-optimizer-mcp) | ツール出力の圧縮・キャッシュと共有知識グラフ | 反復出力で大幅減を掲げるが、全セッションへの削減率は要実測 | 中〜高（MCP、キャッシュ、競合確認） | 小規模repoには複雑。機密ログの保存範囲も要監査 | 保留 |
| 05 | [context-mode](https://github.com/mksglu/context-mode) | 生の巨大出力をSQLiteへ退避し、要約・検索結果だけを文脈へ返す | 作者測定で文脈内byte 99%減の例。ログ中心の作業ほど有効 | 中（plugin/MCP、ツール経路変更） | 発想は有効。本体導入前に一時ファイル＋`rg`で再現可能 | **採用（ローカル運用）** |
| 06 | [claude-context](https://github.com/zilliztech/claude-context) | BM25＋ベクトル検索で関連コードだけ取得 | 検索精度を保ちつつ読み込み量削減を狙う。効果はrepo規模依存 | 高（Node、埋め込み、ベクトルDB/クラウド又は自前運用） | 外部送信なしの現行アプリには不釣合い。機密コードの送信設計も要確認 | 不採用 |
| 07 | [Serena](https://github.com/oraios/serena) | Language Serverを使うシンボル検索・参照・編集MCP | 大規模、多言語repoで全文読みを回避。公式に一律削減率なし | 中（uv/Python、言語サーバー、MCP） | repo成長時は候補。現在は`rg`で十分 | 将来検討 |
| 08 | [claude-cost-optimizer](https://github.com/Sagargupta16/claude-cost-optimizer) | キャッシュ、モデルルーティング、Batch等の費用レバーと計算機 | API課金ワークロードでは大きいが、Claude APIを新規利用しない共通方針を優先 | 低〜中（skill/CLI、料金表保守） | 手法の参考にはなるが、Claude APIを新規利用しない共通方針を優先 | 参考のみ |
| 09 | [ccusage](https://github.com/ccusage/ccusage) | `~/.claude/projects` のJSONLから日別・セッション別・モデル別使用量/費用を集計 | 直接削減は0%。基準値と改善確認を可能にする | 低（通常は`npx ccusage`） | 有効。npm依存を増やさない自己完結版を今回実装 | **採用** |
| 10 | [Claude Code Usage Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | ローカルログからリアルタイム消費率、上限到達時刻、警告を表示 | 直接削減は0%。使い切り防止とペース調整 | 中（Python/常駐表示） | 自動処理には常駐UIが不要。必要時のみ候補 | 保留 |

## 導入方法の要点

- 01: Python環境で `pip install "token-savior-recall[mcp]"` 後、READMEどおり `ts init --agent claude --yes`。まず検証repoだけで試す。
- 02: リポジトリの `CLAUDE.md` をコピーせず、必要な短文ルールだけ既存指示へ統合する。
- 03: Claude Code plugin/skillとして導入できるが、本件では互換性の高い短文規約だけを利用する。
- 04: README記載のMCP設定を追加する前に、保存データ、telemetry、既存MCPとの所有リソース競合を監査する。
- 05: plugin marketplaceまたはREADMEのMCP手順で導入可能。本件ではまず `command > log.txt` → `rg -n "error|fail" log.txt` で同じ原理を使う。
- 06: READMEに従いMCP、embedding provider、Milvus/Zillizを構成する。コード外部送信の承認なしでは導入しない。
- 07: `uvx --from git+https://github.com/oraios/serena serena start-mcp-server` 等、公式READMEのクライアント別設定を使う。
- 08: repositoryのskill/CLIを個別利用する。API料金施策は利用中providerと契約条件を照合する。
- 09: 公式版は `npx ccusage`。本repoでは依存なしで `node tools/token-cost-report.mjs --days 30`、機械出力は `--json` / `--csv` を使う。
- 10: Python環境へ公式READMEどおり導入し、対話セッション中だけmonitorを起動する。

## 原因別選択ガイド

| 主な浪費原因 | 最初に使うもの | 次の候補 | 判断基準 |
+|---|---|---|---|
+| ファイル全文の再読 | `rg`検索先行（01の原理） | 07 Serena / 01本体 | 数百〜数千ファイルで参照追跡が多いか |
+| 長い回答・報告 | 02＋03の短文規約 | Caveman skill | コード・検証証拠が欠落していないか |
+| test/build/APIの巨大ログ | 05の一時ファイル退避 | context-mode / 04 | ログが文脈の主要部分を占めるか |
+| repo横断の意味検索 | `rg`＋ファイル索引 | 01 / 07 / 06 | 字句検索で目的箇所を見つけられないか |
+| 同じ情報の再説明 | 短い恒久ルール | 01の永続メモリ | 古い記憶が誤誘導しない更新手順があるか |
+| 費用が見えない | 09 / 今回のreport | 10 | 月次比較かリアルタイム警告か |
+| API単価・キャッシュが原因 | 利用providerの実請求確認 | 08 | Claude API新規利用禁止を含む社内方針に適合するか |

## 実装セットの根拠と測定手順

expo-applyは依存なしの小規模な静的アプリで、主な読み取り対象も限定される。MCPを複数常駐させると、tool schema、索引、更新、障害切り分けの固定費が削減分を上回り得る。そのため今回は外部依存ゼロで、効果が発生する場所を直接制御した。

1. 作業前に `node tools/token-cost-report.mjs --days 30 --json` を保存する。
2. `.claude/CLAUDE.md` のルールで同種タスクを行う。
3. 作業後に同じコマンドを実行し、日別・project別・model別の推定input/output/costを比較する。
4. タスク件数と成功率が異なる日は単純比較しない。最低でも複数セッションを観測する。
5. reportは約4文字=1 tokenの概算で、価格表も概算である。請求照合にはproviderの正式明細を使う。

`token-cost-report.mjs` は壊れたJSONL行をstderrへ警告して読み飛ばし、残りの集計を継続する。セッション本文は出力せず、件数・推定token・推定費用だけを表示する。
