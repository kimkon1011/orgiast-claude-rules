# P-0299: ローカルCopilot導入効果測定

- 出典: AIニュース提案（2026-10-28 digest「ローカルCopilot導入効果測定」）
- 着手: 2026-10-30 / auto-session 2026-10-30-3

## 課題

クラウド AI 依存が進み、ネットワーク負荷・API コスト・応答待ちが増えている。主要部署
（本 fleet の制作・営業レーン）へローカル版 Copilot（= cheap-code 経由の安価モデル運用）を
試験導入する前に、**ネットワーク負荷とユーザー作業時間の変化を実測する手段がない**。
先行事例（北海道大学・東芝等）ではローカル導入で作業時間 月5-15h 削減・
ネットワークトラフィック 30-50% 減少が報告されており、オージャストでも同等の効果が出るかを
測定して本導入を判断する。

## 対策: `tools/copilot-effect-measure.mjs`

代表タスク（classify / summarize / judge / plan）を 2 バックエンドで実行し、
壁時計時間と推定ネットワークバイトを比較する測定ハーネス。

| 項目 | 実装 |
|---|---|
| タスク定義 | 営業・制作の典型 AI 利用 4 種（`TASKS`）。`--task` で選択 |
| バックエンド | `cloud` = クラウド Claude CLI（既定）/ `local` = cheap-code（OpenRouter 経由の安価モデル）。`--backend cloud\|local\|both` |
| 主要メトリクス | 壁時計時間（ms）。ネットワークバイトは prompt/completion 文字数から概算換算（1 文字 ≒ 0.6 token × 4B + HTTP 固定 2048B）で**推定** |
| 既定動作 | `--dry-run`（計画 JSON を出力。ネットワーク・API 不使用）。実測は `--live` |
| 実測 | `--live` で CLI を spawn し、経過時間と出力文字数を記録。レポートは `~/.claude/logs/copilot-effect-measure.json` に追記 |
| 実行基盤なし | `--live` は fail closed（「実行基盤がありません」で停止し、報告だけ残す） |
| 導入判断 | `judgeAdoption()`: ローカル側の学習済み平均バイト削減が目標（既定 30%）以上なら `expand=true`。先行事例の 30-50% 削減を閾値にしている |

### 使い方

```bash
node tools/copilot-effect-measure.mjs --list              # タスク・バックエンド一覧
node tools/copilot-effect-measure.mjs --dry-run           # 測定計画（既定・ネットワーク不使用）
node tools/copilot-effect-measure.mjs --live --backend both --task summarize \
  --prompt "…" --target-byte-reduction 0.3               # 実測（実行可能な機体のみ）
```

## 検証

- `node --test tools/copilot-effect-measure.test.mjs` … 単体テスト（CLI 解釈 / バイト推定 /
  dry-run 計画 / レポート保存（ORGIAST_HOME 分離）/ 集計 avg-min-max / 導入判断閾値 /
  --live 実測パイプライン（フェイク CLI 注入）/ --live fail closed）

## 位置づけと今後の接続（未実装）

- 実ネットワーク（送受信バイト）の直接計測は、プロキシや OS 側のトラフィック計測と
  組み合わせて別提案として切り出し可能。本ツールはまずタスク実行時の概算バイトと
  時間だけで判断できる最小の測定基盤を提供する。
- 実測を主要部署（kim-PC / 作業用011 / nishi-PC / cafe015-PC / kimko-PC 等）で
  各 1 日回す cron 化は、展開先の PC で `--live` が通ることを確認してから接続する。