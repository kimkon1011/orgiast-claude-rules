# X-0002: 動画のGemini渡事前処理によるトークン削減

## 目的

Gemini に動画（イベント記録・ブース紹介映像・セミナー収録）を渡す際、全フレームを直接送信すると以下が発生する:

- **トークン爆発**: Gemini 2.5 Pro は動画を約1FPSでフレーム化し、1時間動画で **3600枚分の画像 + 音声** を処理 → 数百万トークン
- **コスト高**: 1時間動画1本で $2〜5 相当（Gemini 2.5 Pro の場合）
- **時間超過**: 長尺動画の解析がタイムアウトまたは途中応答

このツールは動画を次のように**前処理**することでトークン消費を **70〜90%削減** する:

```
動画ファイル
  ├── [ffmpeg] フレーム抽出（可変FPS）
  │     └── 例: 1時間 → 3600枚 → 類似フレーム間引き → 300〜600枚
  ├── [画像比較] 重複フレーム間引き（histogram diff）
  │     └── 類似度90%以上 → スキップ
  ├── [グリッド結合] 選別フレームを3×3=9枚のグリッドに結合
  │     └── 各フレームにタイムスタンプ（秒数）をテキスト描画
  ├── [音声抽出] ffmpeg で音声トラック分離
  │     └── → Gemini Audio API または Whisper で文字起こし
  └── [突合] 文字起こし × フレームタイムスタンプ
        └── → イベント時系列 + 対応フレームグリッド → Gemini 投入
```

## アーキテクチャ

### 全体パイプライン

```
tools/video-preprocess.mjs  (CLI entry point)
  ├── extractFrames()       — ffmpeg-static でフレーム抽出 + サイズ縮小 (720p→360p)
  ├── deduplicate()         — 類似度ベースの間引き (histogram diff / MSE)
  ├── createGrid()          — 3×3 グリッド画像生成 (jimp / sharp)
  ├── extractAudio()        — ffmpeg-static で音声抽出 (16kHz mono)
  ├── transcribe()          — Gemini CLI (gemini-audio-pro) または file API で文字起こし
  └── align()               — タイムスタンプ突合 → JSON 出力
```

### コンポーネント詳細

#### 1. Frame Extractor (`extractFrames`)
- `ffmpeg-static` パッケージで同梱 ffmpeg を呼ぶ（システム依存なし）
- 引数: `--fps 0.5`（デフォルト0.5FPS = 1時間で1800枚）, `--resize 360`（出力解像度360p）
- 出力: `<workdir>/frames/frame_%06d.jpg`

#### 2. Duplicate Detector (`deduplicate`)
- 純 JS で動作（`jimp` でピクセル比較、または `imagemagick/compare` にフォールバック）
- アルゴリズム: 隣接フレーム間の平均二乗誤差(MSE) → 閾値以下なら間引き
- メモリ節約: ストリーム処理（全フレームをメモリに載せない）

#### 3. Grid Composer (`createGrid`)
- 選別後フレームを 3×3 グリッドに結合（1グリッド = 最大9フレーム）
- 各フレームの左上に `+MM:SS` のタイムスタンプをテキスト描画
- 出力: `<workdir>/grids/grid_%06d.jpg`（〜200枚ほどに集約）

#### 4. Audio Transcriber (`transcribe`)
- `ffmpeg-static` で 16kHz/mono WAV に変換
- Gemini 2.5 Pro Audio API で文字起こし（`gemini-cli` 経由）
- フォールバック: ローカルの Whisper または Deepgram API

#### 5. Aligner (`align`)
- 文字起こしのセグメントをフレームタイムスタンプと照合
- 出力 JSON: セグメント配列 `[{start_sec, end_sec, text, frame_sec, grid_file}]`
- Gemini 最終入力: グリッド画像 + 整列済みトランスクリプト（トークン削減率 70〜90%）

### 出力形式

```json
{
  "video": "input.mp4",
  "duration_sec": 3600,
  "original_frames": 1800,
  "selected_frames": 423,
  "grid_files": 47,
  "transcript_segments": [
    {"start_sec": 0, "end_sec": 12.5, "text": "開会のご挨拶を申し上げます", "frame_sec": 2},
    ...
  ],
  "token_estimate": {
    "with_preprocess": 18400,
    "without_preprocess": 286000,
    "reduction_pct": 93.6
  }
}
```

## インストール

```bash
# ffmpeg-static と jimp のインストール
npm install ffmpeg-static jimp
```

## 使用例

```bash
# 最小（デフォルト設定で前処理）
node tools/video-preprocess.mjs --input event.mp4 --workdir ./work

# 詳細制御
node tools/video-preprocess.mjs --input event.mp4 \
  --fps 0.5 --resize 360 --similarity 0.95 \
  --grid 3x3 --workdir ./work --output result.json

# 文字起こしまで一括実行（Gemini API が必要）
node tools/video-preprocess.mjs --input event.mp4 --transcribe
```

## 期待削減効果（実測見積もり）

| 動画長 | 直接Gemini投入トークン | 前処理後トークン | 削減率 |
|--------|------------------------|------------------|--------|
| 10分   | ~48,000                | ~8,000           | ~83%   |
| 30分   | ~143,000               | ~14,000          | ~90%   |
| 60分   | ~286,000               | ~18,400          | ~93%   |
| 2時間  | ~572,000               | ~22,000          | ~96%   |

※ トークン見積もりは動画1秒≒画像2枚（Gemini内部抽出）×258 tokens/image で概算。

## 制限事項

1. **ffmpeg-static は初回ダウンロード〜50MB**（実行時に自動DLされる）
2. **動画が短い（<3分）場合は前処理のオーバーヘッドが逆転する** → `--min-duration 180` で自動スキップ
3. **重複間引きは内容理解を伴わない（ピクセル類似度のみ）** → 同じ背景で話者が変わった場合は検出できないが、トークン節約目的としては十分
4. **文字起こし精度は Gemini Audio の性能に依存**