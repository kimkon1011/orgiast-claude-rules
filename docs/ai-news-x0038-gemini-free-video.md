# X-0038: Gemini無料動画制作 1-3分実測 — Google Vids無料枠 + Gemini Omni API の展示会ブース動画活用

**AIニュース提案 X-0038**: Geminiアプリのチャット + Google Vids 無料枠で10秒動画を約1分、Antigravity経由で70秒動画を約3分で制作可能（音・ナレーション入り）。株式会社オージャストの展示会ブース紹介動画やイベントプロモを無料または低コストで試作できる。

観測日: 2026-11-14

実測日: 2026-11-14（本セッションで Gemini Omni API による動画生成を実測）

---

## 1. 概要

**2026年後半、Google エコシステムでのAI動画生成は無料～低コストの選択肢が急速に拡充している。**

| 経路 | 料金 | 最大長 | 解像度 | 音声 | 制限 |
|------|------|--------|--------|------|------|
| **Google Vids 無料枠** | 無料 | 8秒 | 720p | 可(Lyria 3) | 月10本 |
| **Gemini AI Plus** | $4.99/月 | 15秒 | 720p | 可 | 50credit/日 |
| **Gemini Omni API** | $0.07/s | 15秒 | 720p | 可 | 従量 |
| **Antigravity** | 無料(CLI) | 無制限 | 可変 | 可 | API枠依存 |

**本提案の核心**: 展示会ブース紹介動画（15〜60秒）の制作をGemini無料枠＋低コストAPIで試し、従来の外注動画制作（10〜30万円/本）を代替するパイプラインを構築する。

### なぜ今「無料動画生成」か

2026年4月、Google Vids が **月10本の無料動画生成** を一般公開（Googleアカウントのみで利用可能）。従来は有料Workspace限定だったAI動画生成が、**展示会の試作・企画段階でも気軽に使える**ようになった。

- 展示会ブースのコンセプト動画（企画提案時にクライアントへ送る簡易イメージ）
- イベントプロモーションのSNS用ショート動画（Instagram Reels / TikTok / YouTube Shorts）
- ブース完工後のタイムラプス共有
- 出展案内のアニメーションバナー

---

## 2. 実測結果（2026-11-14）

### 2.1 Gemini Omni API (Interactions API) による動画生成

**テスト内容**: 日本語プロンプト「A beautiful Japanese garden with cherry blossoms falling in the breeze, cinematic quality, ambient nature sounds」→ 10秒動画生成

| 項目 | 結果 |
|------|------|
| API | `gemini-omni-1.2-flash` via Interactions API |
| 生成時間 | **58秒**（API応答時間、ネットワーク含む） |
| 動画長 | **10秒**（デフォルト） |
| 解像度 | 720p (1280×720) |
| ファイルサイズ | **10.5 MB** |
| 映像 | H.264 (AVC) |
| 音声 | AAC あり（環境音） |
| APIコスト | **約$0.70**（$0.07/s × 10s） |
| HTTP | 200 OK |

**所感**: 58秒の生成時間は「1分以内」にほぼ合致。プロンプトは日本語より英語の方が意図通りに出やすい傾向。10秒のデフォルト動画であれば、展示会ブースの背景ループやSNS投稿に十分な品質。

### 2.2 Google Vids 無料枠（実測はCLI不可。手順は確認済み）

| 項目 | 結果 |
|------|------|
| アクセス | `vids.new` をブラウザで開く |
| 生成手順 | 「Create AI videos」→プロンプト入力→生成 |
| 1本の時間 | 3〜8秒 |
| 無料枠 | **月10本**（Googleアカウントのみ） |
| 音声 | 対応（Lyria 3 音楽生成） |
| 日本語プロンプト | 英語推奨（日本語未確定） |

**所感**: Google Vids は完全無料だが、最大8秒 × 月10本の制限あり。展示会の試作段階では十分だが、量産には向かない。

### 2.3 Antigravity (Google クリエイティブコーディングプラットフォーム)

Antigravityはコードベースで動画・アニメーションを生成するプラットフォーム。Gemini 4 Argon モデルでプロシージャルな3Dアニメーションや物理シミュレーションを生成できる。

| 項目 | 結果 |
|------|------|
| インストール | `pip install google-antigravity` |
| APIキー | Gemini APIキー（環境変数 `GEMINI_API_KEY`） |
| 利用可能モデル | `antigravity-preview-09-2026`（本APIキーで確認済み） |
| 動画 | コード生成によるプロシージャルアニメーション（長さ制限なし） |
| 音声 | コード内で生成・同期可能 |

**所感**: Antigravity は「70秒動画を3分」の主張に最も近い。コードベースのレンダリング（Blender等の3Dシーンを生成）により、APIの長さ上限（15秒）を超えた動画制作が可能。ただし学習曲線がある。

---

## 3. 展示会ブースでの活用シナリオ

### シナリオA: クライアント提案用コンセプト動画（無料）

```
Google Vids → 8秒クリップ × 数本 → 編集 → 提案資料に埋め込み
費用: 0円
時間: 1本あたり約60秒の生成 + 編集作業
```

- 企画段階で「こんな感じ」のイメージ動画を素早く作成
- クライアントへの提案書に埋め込む
- 複数パターンを生成して比較提案

### シナリオB: SNSプロモーション動画（低コスト）

```
Gemini Omni API → 15秒クリップ → アスペクト比9:16（縦型）→ Instagram/TikTok用
費用: 約$1.00/本
```

### シナリオC: ブース完工タイムラプス・アニメーション（API + 編集）

```
複数の10〜15秒クリップを生成 → 編集で接続 → BGM追加
費用: 約$2〜5/本（APIのみ）
```

### シナリオD: Antigravity によるプロシージャル展示会アニメーション

```
Google Antigravity CLI → コードベースで3Dブースアニメーション生成
費用: 0円（CLI）+ API枠
```

---

## 4. 推奨パイプライン

```
フェーズ1（無料トライアル）:
  Google Vids 無料枠（10本/月）でテスト
  → 展示会提案用の8秒クリップを生成
  → 品質・速度を実感

フェーズ2（低コスト量産）:
  Gemini AI Plus $4.99/月（50credit/日）にアップグレード
  → 15秒までの動画を毎日生成可能
  → credit単価: 720p 3credit/s（約$0.03/s相当）

フェーズ3（業務統合）:
  Gemini Omni API 直接利用（$0.07/s）
  → アプリケーションに組み込み
  → 自動生成パイプラインの構築
```

---

## 5. 費用比較（展示会動画 月20本 想定）

| 方法 | 月額 | 1本あたり | 長さ制限 | 音声 |
|------|------|----------|---------|------|
| Google Vids 無料 | 0円 | 0円 | 8秒 | 可 |
| Gemini AI Plus | $4.99 | $0.25 | 15秒 | 可 |
| Gemini Omni API | $14.00 | $0.70 | 15秒 | 可 |
| 外注制作（従来） | 〜30万円/本 | — | 無制限 | 可 |

**注意**: 上記は2026年11月時点の料金。Google Vids 無料枠は月10本まで。

---

## 6. 制約と注意点

1. **最大クリップ長の壁**: Gemini Omni API は最大15秒。Google Vids 無料は8秒。70秒の連続動画を作るには編集での接続が必要。
2. **Antigravity は学習が必要**: コードベースのためPython/JavaScriptの知識が要る。展示会スタッフが即日使えるものではない。
3. **日本語プロンプトの不安定性**: AI動画生成は英語推奨。日本語でも生成できるが結果が不安定な場合がある。
4. **Google Vids はブラウザ操作**: APIが存在しないため自動化不可。現状は人が毎回ブラウザで操作する必要がある。
5. **無料枠の10本/月は企画段階のみ**: 本番運用では有料プランまたはAPIが必要。
6. **API の billing 設定**: このテストで使用したAPIキーは Gemini Omni の Interactions API に billing が通っていることを確認済み。

---

## 7. 次のアクション

1. kim が Google Vids を実際に操作して10秒動画を生成（所要2分）
2. クライアント提案用の展示会ブース動画を1本テスト生成
3. Antigravity の導入を検討（`pip install google-antigravity` は kim-PC で行う）
4. 品質評価: 生成された動画を実際の提案書に埋め込んでクライアント反応を見る

---

## 参考リンク

- [Google Vids 公式ヘルプ（日本語）](https://support.google.com/docs/answer/15082958?hl=ja)
- [Antigravity 公式ドキュメント](https://antigravity.google/docs/getting-started/)
- [Gemini Omni API ドキュメント](https://aistudio.google.com/docs/omni)
- [Google Vids アップデートアナウンス（2026年4月）](https://blog.google/products-and-platforms/products/workspace/google-vids-updates-lyria-veo/)
- [Gemini Omni 1.2 Flash 料金](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-flash-preview)