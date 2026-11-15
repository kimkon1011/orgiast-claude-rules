---
name: video-editing-delegation
description: AIニュース提案 [X-0066] 記録・解説動画編集をClaude Code/Codexへ委譲。FFmpeg + Whisper + Python でジャンプカット・字幕・効果音・BGM・アニメーションを自動化。外注編集費の大幅削減、500ファイル超のVlog編集にも対応。
metadata:
  version: 1.0.0
  author: orgiast
  source: AI News X-0066
  xref: X-0066
---

# 動画編集を Claude Code/Codex に委譲する

AIニュース提案 **X-0066** で紹介されたワークフロー。Claude Code または Codex に動画編集（ジャンプカット・字幕・効果音・BGM・アニメーション）を任せることで、毎月100万円弱の外注編集費を削減する。素材500ファイル超の海外Vlog編集にも対応可能。

## 原理

Claude Code が以下のツール群を操作して動画編集を自動化する:

| 工程 | ツール | 処理 |
|------|--------|------|
| カット編集 | FFmpeg | 無音区間検出→ジャンプカット、結合 |
| 字幕生成 | Whisper (OpenAI) | 音声認識→SRT/VTT生成→焼き込み |
| 効果音 | FFmpeg + 素材ライブラリ | 無料SEライブラリから抽出→タイムライン配置 |
| BGM | FFmpeg | 音量調整（デュック）、ループ・フェード |
| アニメーション | FFmpeg drawtext/filter | テロップ、トランジション、図形オーバーレイ |

## ワークフロー

```
素材動画（複数ファイル）
       ↓
Step 1: 無音区間検出 → ジャンプカット（FFmpeg silenceremove）
       ↓
Step 2: 音声認識 → 字幕生成（Whisper + FFmpeg subtitles）
       ↓
Step 3: BGM追加（FFmpeg amix + afade）
       ↓
Step 4: 効果音配置（FFmpeg Movie filter / concat）
       ↓
Step 5: テロップ・アニメーション（FFmpeg drawtext / overlay）
       ↓
完成動画（MP4/1080p）
```

## 前提条件

- FFmpeg（システムインストール済み）
- Python 3.8+（Whisper 実行用）
- OpenAI Whisper（`pip install openai-whisper`）または API 経由
- Claude Code または Codex の実行環境

## 各工程の実装詳細

### Step 1: ジャンプカット（無音除去）

```bash
# 無音区間を検出してカット
ffmpeg -i input.mp4 -af silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-30dB -c:v copy output-cut.mp4
```

Claude Code はこの FFmpeg コマンドを実行し、出力結果を確認する。パラメータ（無音閾値・最小無音長）は動画の種類に応じて調整する（インタビュー: -35dB、会議: -30dB、BGMあり: -25dB）。

**より精密なカット**: Python + pydub で音声波形からカットポイントを特定し、FFmpeg concat demuxer で結合する方式も選択可能:

```python
from pydub import AudioSegment, silence
import subprocess, json

audio = AudioSegment.from_file("input.mp4")
segments = silence.detect_nonsilent(audio, min_silence_len=800, silence_thresh=-30)
# segments からカットポイントを計算 → ffmpeg concat 用テキストファイル生成
```

### Step 2: 字幕生成

```bash
# Whisper で音声認識（ローカル実行）
whisper input.mp4 --model small --language ja --output_format srt

# 字幕を動画に焼き込み
ffmpeg -i input.mp4 -vf "subtitles=input.srt:force_style='FontName=Noto Sans CJK JP,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1'" -c:a copy output-sub.mp4
```

**より高精度**: 外部API経由（OpenAI Whisper API / Deepgram / Azure Speech）を使う場合:

```bash
# Claude Code が API を呼び出し、結果を SRT に変換
curl https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file=@input.mp3 -F model=whisper-1 -F response_format=srt > output.srt
```

**スタイル調整**: 字幕のサイズ・色・位置・フォントは Claude Code が VideoObject の仕様に合わせて調整。`force_style` のパラメータを自然言語で指示可能（「白文字に黒縁・下部配置・20pt」→ Claude Code が SRT 適用時に反映。

### Step 3: BGM追加

```bash
# BGMループ＋フェードイン・フェードアウト
ffmpeg -i output-sub.mp4 -stream_loop -1 -i bgm.mp3 \
  -filter_complex "[1:a]volume=0.15,afade=t=in:d=3,afade=t=out:d=3,adelay=500|500[bgm];[0:a][bgm]amix=inputs=2:duration=first" \
  -c:v copy output-bgm.mp4
```

Claude Code は以下の自動調整を行う:
- 動画の音声が無音の区間では BGM 音量 0.2、発話中は 0.1 に動的変更（sidechain compression）
- 動画長に合わせて BGM をループまたはトリミング
- エンディングは自動フェードアウト

```bash
# 動的な音量調整（sidechain compress）
ffmpeg -i output-sub.mp4 -i bgm.mp3 \
  -filter_complex "[1:a]volume=0.15[bgm];[0:a][bgm]amix=inputs=2:duration=first:weights=1 0.5" \
  -c:v copy output-mixed.mp4
```

### Step 4: 効果音配置

```bash
# 効果音を動画の特定位置に追加（5秒目から効果音を再生）
ffmpeg -i output-bgm.mp4 -i se.mp3 \
  -filter_complex "[1:a]adelay=5000|5000[se];[0:a][se]amix=inputs=2:duration=first[out]" \
  -map 0:v -map "[out]" -c:v copy output-se.mp4
```

**自動検出パターン**: Claude Code が動画のシーン変化（scene detect）を検出し、切り替わりに効果音を自動配置:

```bash
# シーン検出
ffmpeg -i input.mp4 -filter:v "select='gt(scene,0.4)',showinfo" -f null - 2> scene.log
# → Claude Code がログからシーン切替タイムスタンプを抽出
# → 各切替位置にクリック/スウープ音を配置
```

### Step 5: テロップ・アニメーション

**テロップ表示**（テキストオーバーレイ）:

```bash
# タイトルテロップ（5秒目から3秒間表示）
ffmpeg -i output.mp4 \
  -vf "drawtext=text='展示会ダイジェスト':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,5,8)',fade=t=in:st=5:d=0.5,fade=t=out:st=7.5:d=0.5" \
  -c:a copy output-title.mp4
```

**画像オーバーレイ**（ロゴ・グラフ等）:

```bash
# ロゴを右下に10秒目から表示
ffmpeg -i output.mp4 -i logo.png \
  -filter_complex "[0:v][1:v]overlay=W-w-10:H-h-10:enable='between(t,10,20)'" \
  -c:a copy output-logo.mp4
```

**トランジション効果**:

```bash
# クロスフェード
ffmpeg -i clip1.mp4 -i clip2.mp4 \
  -filter_complex "[0][1]xfade=transition=fade:duration=1:offset=29[out]" \
  -map "[out]" output-transition.mp4
```

### 完全自動化スクリプト（例）

オージャストの施工事例動画を想定したワンライナー実行例:

```bash
# Claude Code がこのスクリプトを生成し、codex-do 経由で実行
# 1. 全素材を結合
# 2. 無音カット
# 3. 字幕生成
# 4. BGM追加
# 5. 各事例の切替にテロップ
# 6. エンドロール
# 7. 完了通知
```

Claude Code は各工程のエラーを検出し、リトライまたは代替手段で続行する。失敗した工程だけを報告する。

## 費用対効果

| 項目 | 従来（外注） | X-0066（Claude Code/Codex） | 削減率 |
|------|------------|--------------------------|-------|
| 30秒の展示会ダイジェスト編集 | 5,000〜15,000円/本 | $0.05〜0.20/本（FFmpeg実行） | 99%+ |
| 5分の取材レポート編集 | 30,000〜80,000円/本 | $0.10〜0.50/本 | 99%+ |
| 500ファイルのVlog一括編集 | 300,000〜500,000円 | $3〜10（バッチ処理） | 99%+ |
| 毎月の動画編集外注費 | 約100万円/月 | 数千〜1万円/月（API利用料） | 約99% |

**投稿の数値**: 「毎月100万円弱の外注費削減、素材500ファイル超の海外Vlog編集も対象」— 本稿はこの数値をそのまま引用する（自社独自の換算は行わない）。

**API費用の内訳**:
- Whisper API（OpenAI）: $0.006/分（音声認識、日本語）
- Claude Code 利用料: $0.03〜0.10/回（FFmpeg指示）
- Codex 利用料: $0（定額枠内）
- BGM/SE素材: フリー素材ライブラリ使用（追加費用0）

## オージャストでの試し方

**展示会の施工事例やイベントダイジェストなど、凝らない記録動画1本**を同じ工程で試す:

### 用意するもの
1. 施工写真やスマホ撮影の動画素材 3〜5本（各10〜30秒）
2. BGM素材（フリー音源: 甘茶の音楽工房、DOVA-SYNDROME 等）
3. FFmpeg がインストールされた環境（WSL / macOS / Linux）

### 試行手順

```
Step 1: Claude Code に以下をプロンプト
  "このフォルダの動画を結合し、無音をカットして、字幕を付けて、
   BGMを追加して、各クリップの先頭にタイトルテロップを入れて。
   最終的な FFmpeg コマンドを生成して実行して。"

Step 2: Claude Code が FFmpeg コマンドを生成・実行
Step 3: 出力動画を確認 → 満足なら工程をスキル化
Step 4: 2回目以降は同じスキルで素材差し替えのみで完了
```

### 品質評価基準

| 項目 | 合格条件 | チェック方法 |
|------|---------|------------|
| カット精度 | 不自然な切れ目がない・発言の途中で切れていない | 目視確認 |
| 字幕精度 | 誤字率5%未満・タイミングが±1秒以内 | サンプル確認 |
| BGM音量 | 発話と被らない・発話中も聞こえる程度 | 聴感確認 |
| 全体の流れ | 演出として自然・情報が伝わる | 社内レビュー |

### 段階的な導入

**Phase 1（1週目）**: 最短工程から。ジャンプカット＋字幕のみの施工事例1本。結果を確認して社内共有。

**Phase 2（2週目）**: BGM＋開始テロップを追加。テンプレート化。同じフォーマットで次の事例を処理。

**Phase 3（3週目）**: 効果音・トランジション・エンドロールを追加。スキルファイルとして完成。パラメータ（BGM曲・テロップ文字・カット閾値）だけ変えれば誰でも実行可能に。

## 制約と対策

| 制約 | 影響と対策 |
|------|----------|
| FFmpeg のフィルター組み合わせは環境依存 | WSL/macOS/Linux それぞれで動作確認。Docker で統一環境を作る選択肢 |
| Whisper の日本語精度が専門用語で低下 | カスタム語彙リストを追加。API 版の whisper-1 は汎用で高精度 |
| 長時間動画（30分超）の処理時間 | 分割処理＋並列実行。Claude Code/Codex に各パートを委譲 |
| 著作権フリーBGMの選定 | 事前にフリー音源サイトをリスト化。CC0 または CC BY を厳守 |
| 字幕の字体・位置の審美性 | テンプレート化した force_style 値を調整。デザイナー監修の初期設定を1回行う |

## 参考リンク

- AIニュース提案 X-0066（本件）
- [FFmpeg Filter Documentation](https://ffmpeg.org/ffmpeg-filters.html)
- [OpenAI Whisper](https://github.com/openai/whisper)
- [Whisper API](https://platform.openai.com/docs/guides/speech-to-text)
- X-0027: Codex + MCP Illustrator（兄弟提案・制作自動化）
- X-0060: Claude + Adobe MCP（イベント告知自動化）