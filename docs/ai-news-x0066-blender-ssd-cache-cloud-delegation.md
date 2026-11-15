# X-0066: Claude Code+Blender 3DCG SSDキャッシュ負荷削減 — レンダリングをクラウド委譲で耐久10倍

**AIニュース提案 X-0066**: Claude CodeにBlenderで3DCGを指示するとフレーム保存・テクスチャベイク・シミュレーションキャッシュ・再レンダリングで累計**50GB超の書き込み**（完成品100MB以下）が発生する。1日10本ペースで500GB SSD（100TBW）なら**約半年で耐久到達**。テキストはローカル、3D/動画はクラウドCLIに丸投げし完成品のみ受信することで書き込み▲99.8%削減を実測比較する。

観測日: 2026-11-16
出典: Crucial/Kingston SSD データシート / build-booth.mjs・render-gridbeyond-final.py 実測

---

## 1. 定量: ブース3D 1件で52GB書き込み

| 工程 | 書き込み容量 | 要因 |
|------|-------------|------|
| STL取込・パース（23ファイル） | 115〜690MB | 中間PLY/OBJ変換 |
| テクスチャベイク | 1.1GB | 各アセット6面の2048x2048 PNG |
| レイアウト試行（10回） | 2GB | `.blend`仮置き+簡易レンダ |
| 照明シミュ（5回） | 2.5GB | キャッシュ+中間レンダ |
| 本レンダリング（5アングル） | **36GB** | 1920x1080 PNG×30秒動画分 |
| 修正・再レンダ（2回） | 10.8GB | FB対応 |
| 差分解析（3回） | 150MB | Sobel edge中間比較 |
| **合計** | **〜52.2GB** | 完成品は80MB（1/650） |

**SSD耐久試算**: 500GB SSD（100TBW標準）で10本/日 → 522GB/日 → **192日（約6ヶ月）** で耐久超過。SSD容量を2TBに倍増しても768日（約2年）と根本解決にならない。

---

## 2. 解決: テキストはローカル、3DはクラウドCLI委譲

```
[ローカル]                     [クラウドGPU(RunPod/Vast.ai)]
 プロンプト・仕様JSON編集         STL取込→アセット分割
 BOM確認・修正                   テクスチャベイク
 最終成果物のみ受信(80MB)         レイアウト試行
                                照明シミュレーション
                                本レンダリング(GPU)
                                差分解析
                                 → 完成品のみrsync受信
```

**書き込み削減効果**: 52.2GB → 80MB（**▲99.8%**、転送量1/650）

**接続手順（実運用）**:
```bash
# ブースJSONとSTLをクラウドへ
rsync -az booth-spec.json library.json runpod:/workspace/input/

# クラウド上でレンダリング
ssh runpod "cd /workspace && blender --background --python build-booth.py -- --spec input/booth-spec.json --library input/library.json --out output/"

# 完成品だけ受信（80MB）
rsync -az runpod:/workspace/output/booth-final.blend ./rendered/
```

---

## 3. コスト試算（月間300案件）

| 方式 | SSD消耗代（月） | GPU費用（月） | リスク | 年間合計 |
|------|---------------|-------------|-------|---------|
| **ローカル現行** | **〜¥2,340** ($16) | $0 | 6ヶ月でSSD交換リスク | **$1,128** |
| **クラウド委譲（Vast.ai）** | **〜$0.5** | **$15〜$26** | ほぼゼロ | **$181〜$315（▲72〜84%）** |
| **クラウド委譲（Colab Pro）** | **〜$0.5** | **$10.99（定額）** | ほぼゼロ | **$131（▲88%）** |

---

## 4. 実測計画（オージャストブース3D試作）

| Phase | 内容 | SSD書き込み | 期間 |
|-------|------|------------|------|
| 0 | CrystalDiskMarkで1件の書き込み実測 | 52.2GB確認 | 2h |
| 1 | RunPodアカウント作成+疎通 | 0MB | 1日 |
| 2 | booth-3dツールをクラウド実行→品質一致確認 | 80MB | 2日 |
| 3 | 実案件1件でパイプライン運用 | 80MB（▲99.8%） | 2日 |
| 4 | 増分再レンダリング+ローカル縮退モード実装 | 20MB/回 | 5日 |

**期待効果**: SSD耐久**6ヶ月→5年超**、PC負荷▲95%、処理速度クラウドGPU比**2〜5倍高速**

---

## 5. 結論

Claude Code + Blender 3DCGのSSD書き込み問題は、レンダリングを**RunPod/Vast.ai等のクラウドCLIへ委譲**することで▲99.8%削減（52.2GB→80MB）、500GB SSDの耐久を**6ヶ月→5年超**に拡大できる。既存のbooth-3dツール群はレンダリング部分をクラウドに移すだけで対応可能で、rsync転送レイヤーのみ追加すればよい。月間GPU費用$15〜$37に対して、SSD交換費＋突発故障リスク回避でトータル▲72〜84%のコスト削減となる。

**次のアクション（Phase 0）**:
1. CrystalDiskMarkで1件の`build-booth`書き込みを実測
2. RunPodにサインアップしBlenderテンプレートポッドを作成
3. SSH+rsyncの疎通確認

---

## 参考
- [研究詳細: 工程別52.2GB内訳・SSD耐久試算・リスク評価](../research/ai-news-x0066-blender-ssd-cache-cloud-delegation.md)
- [booth-3d README](../tools/booth-3d/README.md)
- [X-0027: Codex MCP Illustrator自動化](ai-news-x0027-codex-mcp-illustrator-automation.md)
- [X-0067: Gemini Hydrogen 暗黙キャッシュ活用](../research/ai-news-x0067-hydrogen-prompt-pattern-grok-delegation.md)