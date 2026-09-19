# Astra × After Effects 連携の事前検証（P-0119）

**Astra × After Effects は OpenAI 純正連携ではなく、Higgsfield の AI Motion Designer 経由で利用する。**  
**本PCは After Effects 未導入のため end-to-end 検証は不可であり、本ドキュメントの検証範囲は readiness 判定までである。**

## 連携の実体

利用導線は次の2つである。

1. ChatGPT で Higgsfield プラグインを開き、`@Higgsfield /use-after-effects` を使う。
2. After Effects 内の Higgsfield ネイティブパネルを使う。

Astra は計画、コード生成、computer-use を担当し、Higgsfield は画像・動画などのメディア生成ツールと After Effects への橋渡しを担う。利用には **Higgsfield、ChatGPT、Adobe After Effects の3サブスクリプション**が必要である。

## readiness チェッカー

依存パッケージを使わない Node.js CLI として `tools/astra-ae-integration-check.mjs` を用意した。

```console
node tools/astra-ae-integration-check.mjs
node tools/astra-ae-integration-check.mjs --json
node tools/astra-ae-integration-check.mjs --strict
```

既定実行は診断結果にかかわらず exit 0、`--strict` は `blocked` のとき exit 1 になる。Higgsfield のローカル痕跡が見つからない場合、ChatGPT アカウント側の状態をファイルシステムから断定できないため `fail` ではなく `unknown` とする。

## ワークフロー効率の測定設計

同一のモーショングラフィックス課題、素材、完成条件を固定し、AI利用時と手作業時を比較する。単なる生成速度ではなく、後工程で再編集できる成果物かも判定に含める。

| 計測点 | 取得方法 | 現時点の取得可否 |
|---|---|---|
| (a) プロンプト入力から、レイヤーとキーフレームが生きた編集可能コンポが開くまでの wall time | readiness が `ready` であることをチェッカーで確認後、プロンプト送信直前からコンポ表示・レイヤー確認完了までを手動ストップウォッチで計測する | **取得不能**。本PCに AE がなく、Higgsfield のアカウント側導入状態も未確定 |
| (b) 同一タスクを手で作る手作業ベースライン | 同じ素材・完成条件を使い、AEで制作開始から同等成果物の完成までを手動ストップウォッチで計測する。AI利用時との短縮率 `(手作業時間 - AI時間) / 手作業時間` も算出する | **取得不能**。本PCに AE がない |
| (c) 初回出力の修正往復回数 | 初回生成後、完成条件を満たすまでの追加プロンプト送信または手修正の各サイクルを1回として記録する | **取得不能**。end-to-end 実行ができない |
| (d) 生成物が編集可能なレイヤー構成か、フラットか | AEのタイムラインでレイヤー数、レイヤー種別、キーフレーム、式、プリコンポを目視確認し、編集可能／一部フラット／全面フラットに分類する | **取得不能**。生成物をAEで開けない |

チェッカーが自動取得するのは環境の readiness であり、制作時間や品質そのものではない。効率を主張するには、AE導入後に上記4点を同一課題で実測する必要がある。

## このPCでの実行結果

2026-09-20 に `node tools/astra-ae-integration-check.mjs` を実行した実出力は次のとおり。

```text
Astra × After Effects readiness: blocked
❌ Adobe After Effects: C:\Program Files\Adobe に Adobe After Effects ディレクトリなし
   直し方: Adobe Creative Cloud から After Effects をインストールしてください。
❓ Higgsfield AI Motion Designer: Higgsfield のローカル痕跡なし（探索先: C:\Users\uers\AppData\Roaming\Adobe\CEP\extensions, C:\Users\uers\AppData\Roaming\ChatGPT）。ChatGPT アカウント側の導入状態はローカルFSからは判定不能
   直し方: ChatGPT の @Higgsfield /use-after-effects、または After Effects パネルを導入してアカウント側でも有効化してください。
✅ Astra レーン: Astra 対象の有効な cooldown なし; C:\Users\uers\.claude\provider-cooldown.json
✅ Node.js 実行環境: v24.14.1; process.platform=win32
```

`--strict` は `blocked` のため exit 1 を返す（既定実行は exit 0）。

したがって、現時点では必要環境が揃っておらず end-to-end テストへ進めない。Higgsfield については「未導入」と断定せず、ローカルFSで確認できない状態として扱う。

## 未検証リスト

- After Effects 上での実描画
- 生成されたモーションの品質
- レンダリング時間
- Higgsfield プラグインと After Effects のバージョン互換性

これらは実測しておらず、結果を推定または捏造しない。

## 出典

- [Higgsfield Astra After Effects Motion Design](https://www.ai-primer.com/creative/stories/higgsfield-astra-after-effects-motion-design)
- [GPT Astra driving After Effects & Premiere Pro](http://jnack.com/blog/2026/09/08/gpt-astra-driving-ae-premiere-pro/)
- [Higgsfield ChatGPT After Effects AI Motion Designer Astra](https://runtimewire.com/article/higgsfield-chatgpt-after-effects-ai-motion-designer-astra)
- [Higgsfield Astra VFX workflow](https://www.ai-primer.com/creative/stories/higgsfield-astra-vfx-workflow)
