# X-0048 Ninja: コーディングエージェントキャッシュ読取コスト削減

状態: 設計 v1（2026-11-15）。出典: SWE-bench 0.80→0.92 の研究提案。

## 0. 位置づけ

- 展示会ブース過去設計データ・イベント企画ログを扱うLLMエージェント向け
- 実装優先順位: ①SQLiteメタデータ → ②ツール呼出バッチ化 → ③GC → ④圧縮
- 本設計の効果は `tools/context-retention-bench.mjs` の拡張で測定する

## 1. ファイル検索用SQLiteメタデータテーブル（優先度1）

### 1.1 既存アセット
- `tools/memory-to-sqlite.mjs` — FTS5全文検索の基盤。これを拡張
- `tools/session-fold.mjs` — セグメントの search() は語彙重なり単純スコア
- `tools/llm-cache-store.mjs` — N-gram類似度検索

### 1.2 新規: `tools/file-metadata-store.mjs`

```
SQLiteスキーマ:
  file_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,          // 絶対パス
    name TEXT NOT NULL,                 // ファイル名（basename）
    ext TEXT,                           // 拡張子（.mjs, .md, …）
    size INTEGER,                       // バイト数
    modified_at TEXT,                   // ISO8601
    content_hash TEXT,                  // sha256（先頭16桁）
    token_estimate INTEGER,             // ceil(bytes/3)
    kind TEXT                           // 'code'|'doc'|'data'|'config'|'other'
  )
  file_fts USING fts5(path, name, content='file_metadata', content_rowid='id')
  -- 全文検索用。path + name に加えテキストファイルの中身も索引可能に

操作:
  indexDirectory(dir, {recursive=true, globPatterns=['**/*']})
    → ディレクトリをスキャンし、file_metadata を upsert
    → テキストファイルは内容を file_content_fts に登録（省略可）
  
  searchFiles(query, {kind?, ext?, limit=20})
    → FTS5 MATCH または LIKE 検索。結果は {path, name, size, modified_at, score}
  
  recentFiles({days=7, limit=20})
    → 直近更新ファイルの一覧
  
  staleFiles({olderThanDays=90, limit=20})
    → 長期間未更新ファイル（GC候補）
  
  stats()
    → 総ファイル数・種別内訳・総トークン概算
```

CLI: `node tools/file-metadata-store.mjs <command> [options]`

### 1.3 テスト設計
- C2: 空DB→indexDirectory→searchFiles の往復。既知ファイル名のFTS5一致
- C4: 実際のtools/ディレクトリで index → search → stats を実行し集計
- エッジケース: 非テキストファイルのスキップ、パスの重複upsert、unicodeファイル名

## 2. ツール呼出バッチ化促進（優先度2）

### 2.1 現状分析
Claude Code は独立したツール呼出を並列実行できるが、ユーザーやモデルは逐次呼出しがち。
- `Glob` を連続6回より `**/*.mjs` 1回で済む
- `Read` をファイル単位でなく一括取得する

### 2.2 新規: `tools/batch-call-prompt.mjs`

以下を出力するCLI:
- システムプロンプト追加文（CLAUDE.md 冒頭へ挿入する定型）
- フック用ゲート設定（settings.json の hooks に追加）

**システムプロンプト追加文案:**
```
## コスト効率: ツール呼出のバッチ化
- 複数の Read は 1 回の Read または Glog Glob にまとめられないか検討する
- 同種の Grep は 1 回のパターン結合で済ませる
- ファイル列挙は Glob 1 回で取得し、あとで絞り込む
```

**ゲート（optional）:**
- tools/batch-call-gate.mjs — セッション中のツール呼出パターンを分析
  - 連続する同種Read/Glob/Grepを検出し「N回のReadを1回のGlobにまとめられます」と指摘
  - ただし最初は提案のみ、強制ブロックはしない

### 2.3 テスト設計
- プロンプト文案が期待される動作を記述しているか（人間レビュー）
- ゲート: 架空の連続Readログ→バッチ化提案が出力される

## 3. 古いコンテキストのガベージコレクション（優先度3）

### 3.1 既存
- `context-trim.mjs#trimBulk` / `trimProgressive` — 文字数ベースの中間切り詰め
- `session-fold.mjs#fold` — セグメント単位の折畳み

### 3.2 方針
- context-trim.mjs に `gcTrim(messages, {windowTokens, maxChars})` を追加
- 単なる文字数トリムに加え、「エラーを含まないtool_resultのうち、後続で参照されていない大きいもの」を優先トリム
- 意味的GCの第一歩として「参照の軽い順」でトリム

## 4. ツール出力のほぼロスレス圧縮（優先度4）

### 4.1 方針
- session-fold.mjs に圧縮オプションを追加:
  - セグメントstoreをgzip/deflateで保存可能に
  - 圧縮率と復元速度のベンチマークを追加
  - 元のSHA-256は不変（圧縮前の解凍後ハッシュ検証）
- 圧縮はfold時のみ（復元はunfold時）

## 5. ベンチマーク拡張

`tools/context-retention-bench.mjs` に以下を追加:
- SQLiteメタデータ経由でのファイル検索速度・精度比較（FTS5 vs 単純語彙一致）
- バッチ化促進によるツール呼出回数削減率の実測
- GC有無でのトークン削減率比較
- 圧縮有無でのストアサイズ・復元速度比較