---
name: video-credit-saver
description: AIニュース提案 [X-0067]「動画は480p生成後に1080pへ上げてクレジット半減」のClaude Code Skill。Seedance 2.5 Draft Mode（480p）で生成し、Kling 4.0 で1080pにアップスケールすることで、直接1080p生成の半分以下のクレジットで高品質動画を得る。ブース紹介・イベント告知動画の制作で効果検証可能。
metadata:
  version: 1.0.0
  author: orgiast
  source: AI News X-0067
  xref: X-0067
---

# Video Credit Saver（480p Draft → 1080p Upscale）

AIニュース提案 **X-0067** で紹介されたテクニック。Seedance 2.5 の **Draft Mode（480p）** で安く動画を生成し、Kling 4.0 で **1080p にアップスケール** することで、直接1080p生成の **半分以下のクレジット** で同等品質を得る。

## 原理

| 方法 | 5秒あたりの費用 | 備考 |
|------|----------------|------|
| Seedance 2.5 直接 1080p | ~$3.02 | 最も高額 |
| **480p Draft → Kling 4.0 Upscale** | **~$1.37** | **約55%削減** |
| Seedance 2.5 Upscaled Mode | ~$1.30 | 57%削減（Seedance内で完結） |

**出典:** 公開API価格の実測比較（2026年11月時点）。クレジット単価はプロバイダにより変動。

## ワークフロー

```
Step 1: Seedance 2.5 で 480p Draft 生成（安い）
  └─ 30秒あたり約16.8クレジット
Step 2: Kling 4.0 で 1080p にアップスケール
  └─ 30秒あたり約88.8クレジット（追加）
Step 3: 品質確認とクレジット比較
  └─ 同プロンプトで直接1080p生成した場合と比較
```

## 前提条件

- Seedance 2.5 API キー（または Web アクセス）
- Kling 4.0 API キー（または Web アクセス）
- 以下のいずれかの経路で API 利用可能な環境

### 利用可能なプロバイダ（価格順・安い順）

**Seedance 2.5 (480p):**
| プロバイダ | 価格/秒 | 備考 |
|-----------|---------|------|
| Revana | $0.09 | 最安、9 credits/s |
| BeatAPI | $0.096 | — |
| OpenRouter | $0.103 | 既存残高で利用可 |
| fal | $0.215 | — |

**Kling 4.0 (1080p Upscale):**
| プロバイダ | 価格/秒 | 備考 |
|-----------|---------|------|
| Kling.ai 公式 | $0.235 | 入力動画ありは $0.141 |
| Krea.ai | $0.235 | — |
| fal.ai | $0.235 | プリペイド$1〜 |

## オージャストでの試し方（ブース紹介動画）

### 検証シナリオ

ブース紹介またはイベント告知動画 **1本** を以下の手順で作り、クレジットを直接1080p生成と比較する。

### Step 1: Seedance 2.5 で 480p Draft を生成

**API 経由（OpenRouter 等）:**
```bash
curl -X POST https://api.openrouter.ai/v1/seedance/generate \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "ブース外観、来場者の様子、製品デモのカットを30秒で構成",
    "resolution": "480p",
    "duration": 10,
    "mode": "draft"
  }'
```

**ブラウザ経由（Seedance公式）:**
1. https://seedance.ai にアクセス
2. Draft Mode を選択
3. 解像度 480p、秒数を指定
4. プロンプトを入力して生成
5. 出力動画のURLを記録

### Step 2: Kling 4.0 で 1080p にアップスケール

**API 経由:**
```bash
curl -X POST https://api.kling.ai/v1/video/enhance \
  -H "Authorization: Bearer $KLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "<Step1の出力URL>",
    "target_resolution": "1080p",
    "enhance_mode": "standard"
  }'
```

**ブラウザ経由（Kling公式）:**
1. https://kling.ai にアクセス
2. 「Video Enhance」または「Upscale」を選択
3. Step1の動画をアップロード
4. ターゲット解像度 1080p を指定
5. 処理完了を待つ

### Step 3: クレジット比較

同じプロンプトで直接1080p生成した場合の費用と比較:

```
直接1080p:  $X.XX
480p→1080p: $Y.YY  ← 半分以下になっているか確認
削減率:     ((X - Y) / X) × 100%
```

## 注意事項

- **Draft Mode の有効期限:** Seedance 2.5 の Draft から正式版へのアップグレードは生成から7日以内。期限切れになると再生成が必要。
- **画質トレードオフ:** アップスケール時に細部の質感が一部変わる可能性あり。重要な顧客向け動画では本番前に確認。
- **プロバイダの価格変動:** API 価格は頻繁に変わる。着手前に各プロバイダの最新価格を確認すること。
- **自社の絶対額:** このテクニックの「半分以下」は公開比較データに基づく比率。自社の実際の支出額は利用するプロバイダのプランに依存する。

## 検証完了条件

- [ ] Seedance 2.5 480p Draft が正常に生成できる
- [ ] Kling 4.0 で 1080p アップスケールが完了する
- [ ] 出力動画の品質が実用に耐える（ブース紹介・イベント告知として使える）
- [ ] クレジット消費量が直接1080p生成の半分以下であることを実測で確認
- [ ] 費用を記録して次回の参考値として保存

## 参考リンク

- Seedance 2.5 API: https://seedance.ai/docs
- Kling 4.0 API: https://kling.ai/document-api
- OpenRouter（Seedance提供）: https://openrouter.ai
- fal.ai（Seedance + Kling提供）: https://fal.ai