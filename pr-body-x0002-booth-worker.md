## AIニュース提案 [X-0002]: 指揮高モデル×実働安モデル検証（ブース図面生成）

**目的:** まつにぃさんの案「Muse窓口・Claude Pro Opus指揮・DeepSeek Flash実働」の検証第一歩として、イベントブース図面の設計（Opus）→ SVG生成（DeepSeek）を試行。

### 設計（指揮役・Opus製）
- `docs/booth-plan-example.json`: 6×3m 小間ブースの平面仕様JSON
  - 座標系・前面動線ルール・アイテムタイプ列挙
  - 検証ロジックで使用するルール（最小通路幅900mm、カウンター最大比率0.5など）

### 実働（作業役・DeepSeek製）
- `tools/booth-plan-svg.mjs`: 仕様JSON → SVG変換
  - バリデーション（範囲外・重なり・前面開口不足・型検査など13件のテスト通過）
  - SVG描画（グリッド・凡例・決定論的出力）
  - CLI（`--spec` / `--out` / `--check` / stdin対応）
- `tools/booth-plan-svg.test.mjs`: 全13テスト通過

### 検証
- `node --test tools/booth-plan-svg.test.mjs`: 13 pass / 0 fail

Co-Authored-By: Claude Code <noreply@anthropic.com>

🤖 Generated with [Claude Code](https://claude.com/claude-code)