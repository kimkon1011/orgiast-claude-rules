# X-0063 一括画像クリーンアップ調査

2026-11-15 / 試行002。現時点では採用保留。対象のブラウザAI呼出し経路と現行逐次削除は未特定で、実装変更・外部API送信は行っていない。

## 証跡

対象版は `a1281338960532f9dcfb39407853cbb3206491e4`。確認ファイルのSHA-256は routing-002.json に保存。

- tools/bulk-context-audit.mjs: collectBulkPayloads は保存JSONLのテキスト一括データを集計する。画像削除やAPI要求構築の処理ではない。
- tools/cache-audit.mjs: Anthropic SDK呼出しとcache_controlの静的監査。冒頭にも書換えなしと記載。
- tools/x0017-prompt-cache-usage.mjs: チェックリスト、使用量記録、レポート。対象ブラウザAIとの接続は未確認。記載されたTTL等は今回の仕様根拠として採用していない。
- tools/discord-autoreply.mjs: createLlm/payloadForでsystemと単一user要求を構成し、input.images.slice(0,4)を添付。Discord返信用で、ブラウザ操作の過去画像の逐次除去を確認できない。
- tools/booth-perse-gen.mjs: generateは画像生成の参照画像を一要求へ組み立てる。会場調査の履歴経路とは確認できない。
- apps/workbuddy-screenshot/script.js: 展示会LPのサンプルUI。

検索は apps/packages/tools の mjs/js/ts/py（test除外）で screenshot、image_url、input_image、computer_use、browser_use を照合し51行。候補3ツールの参照を apps/packages/tools/config で検索した結果は監査ツール自身と prompt-memory-guideline.json の案内だった。scripts/config/.claude/docs では browser.use、computer.use、clear.*image、remove.*image、画像一括削除、X-0063 を補足検索した。生ログはローカル .loop/quota-sweep-codex-002-{search,routing}.log。検索した範囲で未特定であり、リポジトリ全体・外部製品に存在しないとは断定しない。未作成だった outputs/X-0063 も検索引数に含めたため補足検索は終了2。主要コード検索は終了0。

## 判定・残件

C1未達: 実利用の起動設定、呼出し元、匿名化した変更前要求が必要。次回はREADME/manifestとブラウザMCP・拡張設定の参照を有限検索し、会場リサーチ/競合ブース調査からAPI送信までを追う。
C2/C3未達: 対象未特定のため実装・要求観測・不変性証明なし。
C4未達: 両業務の実測なし。モデル/版、価格、画像量、操作数、反復数、cold/warm、cache read/write/input/output、総費用と計算式はすべて欠測。改善は主張しない。有料実験の権限・予算も未確認。
C5未達: 製品/テスト差分はなく、対象テストも未特定。今回の棚卸しでは追加・削除・統合するテストは0。必須 node --test tools/*.test.mjs は未実行でPASSとはしない。

## 利用・切戻し

本成果は調査記録のみ。運用設定や画像履歴は変更していない。新しいクリーンアップ機能を有効化する手順はまだ提供できない。切戻し対象の製品変更なし。経路特定後、閾値と保持設定、無効化手順、比較結果をここへ追記する。

## 試行003: 起動設定の追跡（2026-11-15）

README、manifest、共有設定、拡張監査、MCP登録、Meetブラウザ実装、VS Code拡張を有限検索。確認ファイルのSHA-256は routing-003.json に保存。

- manifest.json はルール・skill配布情報で、ブラウザAI起動設定ではない。
- tools/browser-extension-audit.mjs:73 は拡張の一覧監査。実プロファイルの走査は行っていない。
- tools/register-hooks.mjs:297–298 は gemini-cli の登録。会場調査の画像履歴処理とは確認できない。登録処理は実行していない。
- tools/lib/meet-cue-browser.mjs は Meet参加・字幕取得。失敗画像の保存があるが、LLM要求への画像選択の証拠ではない。
- packages/vscode-next-session/extension.js:95 は Claude Code の外部URI起動。これだけで対象ブラウザAIをClaude Codeと断定できない。

C1〜C5は引き続き未達。製品/テスト差分なし、テスト追加削除0、必須ゲートは未実行。既存テストの緑を完了証拠へ代用しない。ローカル生ログは .loop/quota-sweep-codex-003-{routing,followup,origin}.log。origin検索は存在しないknowledge指定により終了2、検索結果なしで製品不在とは判断しない。

次は既存の業務手順・提案元の名称から、会場リサーチ/競合ブース調査で使う製品・起動コマンド・設定所在を有限検索する。2試行ともC1未達なので、コード候補検索の反復から業務手順の特定へ仮説を変更する。必要な入力は実利用の製品名/起動経路と匿名化した変更前要求。モデル・価格・費用実測は依然欠測、採否保留。

## 試行004: 業務手順からの識別（2026-11-15）

README.md/docs/config/.claude のMarkdown・JSONを業務語で限定検索し、3資料を読んだ。X-0016の競合ブース調査はコンテキスト試算、X-0041はNotebookLM動画調査の適用案、X-0009はfetchベースのSEO構築案だった。いずれも対象ブラウザAIの画像要求・現行逐次削除を証明しない。参照箇所はそれぞれ docs/ai-news-x0016-subagent-evolution.md:103、docs/ai-news-x0041-monetization-research-master-prompt.md:31、docs/ai-news-x0009-seo-workflow-agent-9steps.md:255。出典hashと限定範囲は routing-004.json。キャッシュ関連4資料の補足確認でも画像履歴の実経路は未特定。文書中の性能値・価格・製品仕様は検証せず、実測証拠へ転用していない。

C1〜C5すべて未達。対象実装を所有するソース、製品名/版と実起動設定、匿名化した変更前要求が必要。これらが揃うまでは未接続helperを追加せず採否保留。C4は両業務のcold/warm比較と全token・費用項目が欠測。外部有料実験は権限と費用上限の証拠も必要。製品・テスト差分なし、テスト追加/削除/統合0。関連完了チェックポイントに達していないため必須ゲート未実行、C5をPASSとはしない。利用・切戻しは調査記録のみという既存説明を維持。

コード候補・設定・業務資料の有限検索を終え、次の操作は同じ検索の反復ではなく上記実利用情報の受領後に要求構築を追跡すること。gitdir書込制約はホスト側の正規権限付与でのみ解除できる。

## 試行005: 再開条件の照合（2026-11-15）

ユーザーの再開依頼には実利用製品名/版・起動設定・要求構築ソース・匿名化した変更前要求の追加がなく、既存記録にも対象特定の証拠はない。対象版は引き続き `a1281338960532f9dcfb39407853cbb3206491e4`。過去の有限検索は反復せず、C1の入力待ちを維持する。製品/テスト差分なし、テスト棚卸しは追加・削除・統合0。C2要求配線、C3履歴不変性/prefix、C4両業務の実測、C5指定ゲートはすべて未達。実測採否は保留、利用・切戻しは上記調査記録のみ。

解除に必要な入力は対象業務運用者/ソース所有者による実利用情報と正規ソースアクセス、有料比較については既存権限と費用上限。コミットの可否はローカル状態の005-add/commitログに保存する。実gitdirの書込制約を回避しない。
