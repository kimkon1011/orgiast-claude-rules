# X-0043: 3DCGのSSD書き込みをクラウドCLIで回避 — BlenderレンダリングをRunPodで実行

## 概要

展示会ブース3Dモデルやイベント映像制作でBlenderを使用する際のローカルSSDへの書き込み問題を、クラウドGPU（RunPod / Vast.ai / JANCTION）でのCLI実行に移行して解決する提案書。テキスト編集はローカルで行い、レンダリング・動画生成等の計算負荷タスクだけをクラウドCLIにオフロードするハイブリッドワークフロー。

## 変更内容

- `docs/ai-news-x0043-ssd-cloud-blender.md` を新規作成
  - 実測ベースの月間SSD書き込み量分析（810GB/月）
  - 4つのGPUクラウドサービスの比較（RunPod / Vast.ai / JANCTION / AWS）
  - Blender CLI実行方法（`blender --background --render-frame 1..N --cycles-device CUDA`）
  - ファイル転送フロー（blendアップロード→レンダリング→結果ダウンロード）
  - 実測ベースのコスト分析（1フレーム$0.01〜$0.23、月額$5.5〜$8.5）
  - 4つの適用シナリオ（ブースレンダリング・映像制作・緊急高品質・チーム共有）
  - 3フェーズの実装計画（PoC→本番スクリプト→統合運用）

## 期待効果

- ローカルSSD書き込みゼロ（約800GB/月の削減）
- レンダリング速度3〜5倍（RTX 3060→RTX 4090比）
- PC解放時間25時間/月（レンダリング待機解消）
- 月額ランニングコスト $5.5〜$8.5（Vast.ai RTX 4090の場合）

🤖 Generated with [Claude Code](https://claude.com/claude-code)