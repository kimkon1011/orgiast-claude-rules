# 展示会ブース制作 キーワードリサーチ AIエージェント 実装指示

## 概要
skills/booth-kw-research/ の process scripts（phase1〜4）に TODO(codex) マーカーで示された未実装部分を完成させる。
各 Phase は --dry-run <outdir> で test/fixtures の固定データを使い、通常実行では実際の HTTP クロール + LLM 分類を行う。

## 共通ルール
- ES modules (import/export)、Node.js 22+
- 外部 npm パッケージを追加しない。node:http, node:https, node:fs, node:path, node:child_process 等の標準ライブラリのみを使用。
- 出力は既存スケルトンと同じ形式・ファイル名を維持する。
- --dry-run <outdir> フラグは全 Phase で維持。dry-run 時は test/fixtures/ から読み込むのではなく、前 Phase の出力を outdir から読み込むパイプライン形式。
- 日本語コメント、日本語ログメッセージ（console.log/error は日本語可）。

## Phase 1: process/phase1-crawl.mjs

### 変更点
crawlPage() 関数を本実装に置き換える:

1. **robots.txt 取得とパース**: 各ドメインの `https://domain/robots.txt` を fetch し、Disallow パスを記録する。User-agent には `data/competitors.json` の settings.user_agent を使う。robots.txt 取得失敗（404等）は全許可と見なす。

2. **HTML 取得**: fetch() または node:https で HTTP GET。User-Agent を設定。タイムアウトは competitors.json の request_timeout_ms（デフォルト15000ms）。ステータス200以外はスキップしてログ出力。

3. **HTML パース**: 標準ライブラリのみで簡易パース。`/<title>([^<]*)<\/title>/i` でタイトル、`/<h1[^>]*>([^<]*)<\/h1>/i` で H1、`/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*\/?>/i` で meta description を抽出。完全なDOMパースは不要。

4. **再帰的クロール**: 同一ドメイン内の `<a href="...">` を抽出。相対パスは絶対 URL に変換。`max_depth`（`data/adjustment-params.json` から読み込み、デフォルト3）まで再帰。`max_pages_per_site`（competitors.json の設定、デフォルト200）を上限。既にクロールした URL は seen Set で重複排除。`crawl_delay_s` の間隔で待機。

5. **既存の dry-run 実装は変更しない**（DRY_RUN_MOCK_DATA と --dry-run の挙動）。

6. クロール間隔は competitors.json の settings.crawl_delay_s（デフォルト1.0秒）。各リクエスト間に await する。

7. エラーハンドリング: 各URLの取得失敗は pages に含めず、console.error に記録して継続。クロール終了時にエラー数をサマリ出力。

8. config 読込は既存の competitors.json に加え、adjustment-params.json の crawl.max_depth も読む。adjustment-params.json が無ければデフォルト3を使う。

## Phase 2: process/phase2-collect.mjs

### 変更点

1. **キーワード抽出の改善**: extractKeywords() で漢字・カタカナ連続の抽出に加え、「展示会ブース」「ブース制作」「イベント企画」のような複合語も抽出できるよう、n-gram（bi-gram）的なアプローチも追加する。具体的には：
   - 既存の単語抽出（漢字・カタカナ連続2文字以上）を維持
   - 連続する単語の組み合わせ（bi-gram）もキーワード候補に追加
   - 頻出汎用語ストップワードを拡充：['オージャスト', '一覧', '株式会社', '株式会社オージャスト', 'サービス', 'メニュー']

2. **類似キーワードマージの改善**: mergeKeywords() で完全一致に加え、類似度80%以上のキーワードをマージ。類似度計算には Jaro-Winkler 距離を標準ライブラリ（string-similarity 等は使わず自前実装）で計算する。マージ時は text は長い方を採用、volume は加算、source は配列で保持。

3. **GSC CSV 読込の追加**: スケルトンには実装予定のコメントのみなので、以下の機能を追加：
   - `--gsc-csv <path>` オプションで Google Search Console の CSV エクスポートを指定可能にする
   - CSV 形式: "Top queries","Clicks","Impressions","CTR","Position" のカラムを想定
   - GSC データがある場合、queries 列からキーワードを抽出して統合
   - GSC のクリック数・表示回数を volume 推定値として優先使用

4. **カテゴリ分類の改善**: 既存の keyword_category_map の部分一致に加え、未分類キーワードは tools/llm-ask.mjs --kind classify を使って分類する。llm-ask が使えない場合は「未分類」のままにする。llm-ask の呼び出しは非同期で、Promise.all を使って並列化する（ただしレート制限を考慮して最大5並列）。

5. tools/llm-ask.mjs へのパス解決: スクリプトからの相対パス `../../tools/llm-ask.mjs` で OK。

## Phase 3: process/phase3-score.mjs

### 変更点

1. **LLM による検索意図分類の実装**: classifyIntent() で tools/llm-ask.mjs --kind classify を呼び出す。プロンプト:
   "次のキーワードの検索意図を分類してください。選択肢: Informational（情報収集）/ Commercial（比較検討）/ Transactional（購入・申込）。\nキーワード: {keyword}\n回答は選択肢の英語1単語のみでお願いします。"
   llm-ask が使えない場合は Keywords の末尾パターンでルールベース分類:
   - 「費用」「価格」「料金」を含む → Commercial
   - 「代行」「依頼」「申込」「見積」を含む → Transactional
   - 「とは」「意味」「方法」「違い」を含む → Informational
   - その他 → Commercial（デフォルト）

2. **tools/llm-ask.mjs へのパス**: phase2 と同じ解決方法。

3. Phase2 で未分類のキーワードに対しても、ここで tools/llm-ask.mjs でカテゴリ分類を試みる（llm-ask が利用可能な場合のみ）。

4. テスト: dryrun.test.mjs の既存アサーション（スコア降順、priority連番、recommended_actionの3値）は変更しない。

## Phase 4: process/phase4-propose.mjs

### 変更点

1. **コンテンツギャップ分析の改善**: 現状の単純なタイトル部分一致から、より精緻な分析に変更：
   - 自社サイトの全ページから「トピック」（タイトル + H1 + 説明文）を収集
   - 各優先キーワードについて、自社サイトの全トピックとの類似度（Jaro-Winkler）を計算
   - 最大類似度が0.3未満のキーワードを「コンテンツギャップ」と判定
   - ギャップキーワードには tools/llm-ask.mjs --kind classify で推奨ページ種別を割り当て（プロンプト:
     "次のキーワードに最適なページ種別を1つ選んでください。選択肢: サービスページ（高意図・高ボリューム）/ 事例ページ（高意図・低ボリューム）/ コラム（低意図・高ボリューム）\nキーワード: {keyword}\n意図: {intent}\n検索ボリューム: {volume}\n回答は「サービスページ」「事例ページ」「コラム」のいずれか。")

2. **既存ページ最適化候補の実装**: 現状の "（TODO: ...）" プレースホルダを実際の提案に置き換え：
   - 優先キーワード上位10件について、自社サイト内でそのキーワードを含むページを検索
   - 各ページのタイトルにキーワードが含まれているかチェック
   - 含まれていない場合、タイトル最適化案を生成（既存タイトル + ' | ' + キーワード）
   - H1、meta description の最適化案も同様に生成

3. **内部リンク改善案の実装**: 同様にプレースホルダを実装に置き換え：
   - 自社ページ間のリンク関係を分析（ページAがページBにリンクしているか）
   - 同一カテゴリのページ間にリンクがない場合、改善案として提示
   - トップページと下層ページのリンク構造の改善提案

4. dry-run モードでは、tools/llm-ask.mjs を呼ばずにルールベースの簡易分類を使う。

## 新規作成: skills/booth-kw-research/run.mjs (Master Orchestrator)

全 Phase を順次実行するエントリポイント。

### 仕様
- 使用法: `node run.mjs [--dry-run <outdir>] [--gsc-csv <path>]`
- Phase 1 → Phase 2 → Phase 3 → Phase 4 を順次実行
- 各 Phase の標準出力・エラーは "=== Phase N: 説明 ===" のセクション見出しで区切る
- エラー発生時はそこで停止し、exit code 1 で終了（Phase 番号を stderr に出力）
- 全 Phase 成功時は "全 Phase 完了" と実行時間（秒）を出力
- --dry-run <outdir> の場合、各 Phase に --dry-run フラグを渡す（パイプラインで outdir を引き継ぐ）
- --gsc-csv <path> は Phase 2 にのみ渡す

### ファイル構成
```
skills/booth-kw-research/
  run.mjs          ← 新規: マスターオーケストレータ
  SKILL.md         ← 変更: 使用方法を run.mjs 基準に更新
  process/
    phase1-crawl.mjs  ← 変更
    phase2-collect.mjs ← 変更
    phase3-score.mjs ← 変更
    phase4-propose.mjs ← 変更
  data/
    competitors.json     ← 変更: 実際の競合URLを追加 (後述)
    business-value.json  ← 変更なし
    adjustment-params.json ← 変更なし
  test/
    dryrun.test.mjs    ← 変更: run.mjs の dry-run テストを追加
    fixtures/          ← 変更なし
  output/
    (実行時に生成)
```

## テスト

既存の `dryrun.test.mjs` はそのまま動作すること。加えて:

run.mjs が --dry-run モードで全 Phase を成功させることを確認するテストを dryrun.test.mjs に追加:
```js
it('run.mjs --dry-run should execute all 4 phases', () => {
  const outdir = mkdtempSync(path.join(os.tmpdir(), 'kw-run-test-'));
  try {
    const stdout = execSync(`node "${path.join(ROOT, 'run.mjs')}" --dry-run "${outdir}"`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60000,
    });
    assert.ok(stdout.includes('Phase 1'), 'should include Phase 1 output');
    assert.ok(stdout.includes('Phase 2'), 'should include Phase 2 output');
    assert.ok(stdout.includes('Phase 3'), 'should include Phase 3 output');
    assert.ok(stdout.includes('Phase 4'), 'should include Phase 4 output');
    assert.ok(stdout.includes('全 Phase 完了'), 'should confirm completion');
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
});
```

## 注意事項
- このファイル (IMPLEMENT.md) は編集しないでください。
- テストファイル (test/dryrun.test.mjs) は必要なテストケースのみ追加し、既存のテストケースは削除・変更しない。
- 各スクリプトは Node.js `node --test` でテスト可能であること。
- competitors.json の competitors 配列は空のままでよい。実際の運用時に追加する。
- `--dry-run` の outdir 内ファイル名は Phase 固定: `crawl-results.json`, `raw-keywords.json`, `keywords-priority.csv`, `content-gaps.md`