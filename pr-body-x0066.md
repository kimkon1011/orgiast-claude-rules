## 概要

**X-0066: Claude Code + Blender 3DCG の SSD キャッシュ負荷削減提案**

Claude CodeにBlenderで3DCGを指示すると、フレーム画像保存・テクスチャベイク・シミュレーションキャッシュ・修正動画生成・差分解析・再レンダリングの繰り返しで累計**50GB超の書き込み**（完成品100MB以下）が発生。1日10本ペースで500GB SSD（100TBW）なら約半年で耐久到達する問題の解決策を提示する。

## 変更内容

- `research/ai-news-x0066-blender-ssd-cache-cloud-delegation.md` — 詳細研究ドキュメント
  - 工程別52.2GB書き込み内訳（STL取込〜再レンダリング）
  - SSD耐久試算（500GB/100TBW → 192日）
  - 解決策：テキストはローカル、3D/動画はクラウドCLI委譲（RunPod/Vast.ai）
  - ▲99.8%書き込み削減の工程別試算
  - クラウドGPU費用対効果（月間$15〜$37 vs 現行SSD消耗$16+交換リスク）
  - オージャスト展示ブース3D試作での実測計画（Phase 0〜5）
  - リスクと対策（料金変動・転送遅延・機密・オフライン縮退）

- `docs/ai-news-x0066-blender-ssd-cache-cloud-delegation.md` — 記事版（AIニュース提案）
  - 定量データ、クラウド委譲方式、コスト試算、実測計画をコンパクトに

## 検証

- 書き込み量の試算は booth-3d ツール群（build-booth.mjs/render-gridbeyond-final.py等）の実動作から算出
- SSD耐久は Crucial/Kingston 等の標準 TBW 定格に基づく
- クラウドGPU価格は RunPod/Vast.ai/Lambda GPU/Colab Pro の2026年11月時点の公開料金

Co-Authored-By: Claude Code <noreply@anthropic.com>

🤖 Generated with [Claude Code](https://claude.com/claude-code)