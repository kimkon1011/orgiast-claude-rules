# X-0046: Codex初期設定で不要機能を除外しトークン節約

**AIニュース提案 2026-11-17**: Codex CLI 0.169.0 にはブラウザ操作・画面操作・画像生成など多くの機能が初期有効になっている。オージャストのCodex用途（ブース自動化スクリプト生成・イベント資料制作）では不要な機能を `--disable` で明示的に除外し、システムプロンプトの肥大化を防いでトークンを節約する。

観測日: 2026-11-17（Codex CLI 0.169.0 時点）

---

## 1. 背景: Codexが初期有効にする不要機能

Codex CLI は `codex features list` の stable かつ有効な機能をすべてシステムプロンプトに含める。`codex-do.mjs` 経由の実装呼び出しでは、以下の機能がコード生成に不要にもかかわらず読み込まれていた：

| 機能 | 初期状態 | コード実装での要否 |
|------|---------|-------------------|
| `browser_use` | stable ✅ 有効 | 不要 |
| `browser_use_external` | stable ✅ 有効 | 不要 |
| `browser_use_full_cdp_access` | stable ✅ 有効 | 不要 |
| `computer_use` | stable ✅ 有効 | 不要 |
| `image_generation` | stable ✅ 有効 | 不要 |
| `in_app_browser` | stable ✅ 有効 | 不要（CLIでは無関係） |
| `in_app_dictation` | stable ✅ 有効 | 不要（CLIでは無関係） |
| `in_app_voice` | stable ✅ 有効 | 不要（CLIでは無関係） |
| `sleep_tool` | stable ✅ 有効 | 不要 |
| `view_image` | stable ✅ 有効 | 不要 |

## 2. 削減見積もり

Codex CLI 0.169.0 のシステムプロンプト長は正確には測定不能だが、機能1つあたりの説明・ツール定義・使用例が数百〜千トークンと推定される。10機能を除外することで：

- **推定削減**: システムプロンプト約2,000〜5,000トークン（機能説明・ツール定義・使用例の合計）
- **Codex起動1回あたり**: 上記トークンが毎回節約される（プロンプトキャッシュのプレフィックスも短縮）
- **オージャストのコード生成**: 日次のブース自動化スクリプト・イベント資料生成呼び出しで、累積削減効果が期待できる

## 3. 実装内容

### 3.1 codex-do.mjs の変更

`buildCodexExecArgs()` に `--disable` フラグの配列 `DISABLE_UNUSED_FEATURES` を追加。すべての Codex 呼び出し（新規実装・レビュー）で一律に無効化する。

```javascript
export const DISABLE_UNUSED_FEATURES = [
  '--disable', 'browser_use',
  '--disable', 'browser_use_external',
  '--disable', 'browser_use_full_cdp_access',
  '--disable', 'computer_use',
  '--disable', 'image_generation',
  '--disable', 'in_app_browser',
  '--disable', 'in_app_dictation',
  '--disable', 'in_app_voice',
  '--disable', 'sleep_tool',
  '--disable', 'view_image',
];
```

### 3.2 維持する機能

コード実装に必須の機能は維持する：

| 機能 | 理由 |
|------|------|
| `shell_tool` | npm・git・node の実行に必須 |
| `plugins` | MCPツール・makeloop 連携に必須 |
| `code_mode_host` | コード編集に必須 |
| `incremental_tools` | 効率的なコード変更に必須 |
| `goals` | タスク管理に必要 |
| `hooks` | フック連携に必要 |
| `fast_mode` | パフォーマンス向上 |
| `unified_exec` | コマンド実行に必要 |

## 4. 副作用・影響

| 項目 | 影響 | 対応 |
|------|------|------|
| ブラウザ操作の可否 | `browser_use` 無効でブラウザが使えなくなる | コード実装には不要。必要な場合のみ `--enable browser_use` で一時有効化 |
| 画像生成 | `image_generation` 無効 | コード実装には不要 |
| 画像表示 | `view_image` 無効で参照画像が見られない | コード実装の指示に画像を含める場合のみ一時有効化 |
| 互換性 | Codex CLI 0.169.0 の stable 機能のみ対象 | 将来のバージョンで機能名が変わった場合は更新が必要 |

## 5. 次ステップ

1. ✅ `codex-do.mjs` に `DISABLE_UNUSED_FEATURES` を実装（PR #XXXX）
2. [ ] **永続設定の提案**: `codex features disable` で `~/.codex/config.toml` にも同じ設定を書き込む（対話的 Codex でも節約効果を得るため）
3. [ ] **効果測定**: usage-stats.mjs で変更前後のトークン消費量を比較（1週間後）
4. [ ] **機能追加時の監視**: 新しい Codex バージョンで stable 機能が追加されたら同様に評価・追加

## 参考

- `codex features list` — 全機能の一覧・ステージ・有効状態を表示
- `codex exec --help` — `--disable` / `--enable` フラグの説明
- `codex-do.mjs` の `buildCodexExecArgs` — 実装呼び出しの引数構築