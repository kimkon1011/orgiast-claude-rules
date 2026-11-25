# P-0306: Muse 認証情報共有プロセスのセキュリティ検証

- 出典: AIニュース提案（2026-10-30 digest「Museへ認証情報を安全に渡すとほぼ全機能が利用可能になるが、情報漏洩リスクの検証が必要」）
- 着手: 2026-10-30 / auto-session 2026-10-30-2

## 課題

eval-harness 等がプロバイダ鍵（openrouter / groq / gemini / mistral / anthropic）を
`~/.claude/<name>.env`（平文）で持ち、外部 AI（Muse Wonder 等）へ共有する経路が平文のままで、
「誰に・どの目的で・いつまで」の束縛や監査が存在しない。

## 対策: `tools/muse-handoff.mjs`

認証情報を暗号化し最小権限で外部 AI へ渡すパイプライン。

| 要件 | 実装 |
|---|---|
| 暗号化 | AES-256-GCM。マスターキー（`MUSE_HANDOFF_MASTER_KEY` か `~/.claude/muse-handoff.key`）から HKDF-SHA256 で recipient に束縛して鍵導出 |
| 改ざん耐性 | ヘッダ（name/scope/purpose/recipient/ttl/notBefore/issuer）を AAD として認証。bit flip・scope 挿入は復号失敗 |
| 最小権限 | unwrap の要求 scope/purpose/recipient は認証済みヘッダの付与範囲の部分集合のみ許可。昇格要求は fail closed |
| 有効期限 | notBefore + TTL。期限切れ・未来発行は拒否（リプレイ抑止） |
| 監査 | 発行/解錠/失敗を `~/.claude/logs/muse-handoff.log` に記録（秘密は一切書かない） |
| 平文非漏出 | バンドル・stdout（--allow-print なし）・ログに秘密は現れない |

### 使い方

```bash
export MUSE_HANDOFF_MASTER_KEY="<32byte以上>"
# 発行（openrouter 鍵を eval 目的で 24h 有効にして muse-wonder 宛に）
node tools/muse-handoff.mjs wrap --name openrouter --scope eval --purpose daily-eval --ttl 86400
# 解錠（最小権限: --scope は付与済みの部分集合のみ）
node tools/muse-handoff.mjs open <bundle> --scope eval
# 書込先だけ変える場合は --allow-print を明示（既定は [ok] 要約のみ出力）
node tools/muse-handoff.mjs open <bundle> --allow-print
# 検証
node tools/muse-handoff.mjs verify
```

## ペネトレーションテスト: `tools/muse-handoff-pentest.mjs`

実 CLI をブラックボックス攻撃する suite。全成功で exit 0。

| ID | 攻撃 | 期待 |
|---|---|---|
| P1 | 暗号文ビット反転 | 復号失敗 |
| P2 | ヘッダ改ざん（scope 昇格挿入） | 復号失敗 |
| P3 | リプレイ（TTL 経過後の再使用） | 拒否 |
| P4 | 有効開始前の使用 | 拒否 |
| P5 | 未付与 scope の要求（昇格） | 拒否 |
| P6 | recipient 別名要求 | 拒否 |
| P7 | マスターキー欠如 | fail closed |
| P8 | 平文リーク（stdout/stderr） | 出ない |
| P9 | 別マスターキー | 復号失敗 |

## 検証

- `node --test tools/muse-handoff.test.mjs` … 単体テスト（roundtrip / 最小権限 / TTL / tamper / 束縛 / ログ redact / CLI 非漏出）
- `node tools/muse-handoff-pentest.mjs` … 上記ペネトレーションテスト実行

## 今後の接続先（未実装）

- `delegation` 経路（Codex/cheap-code へ鍵を渡す場合）で本ツールを挟むかは、使用中のバックエンドが決まったら接続する。
- 鍵ファイル `~/.claude/*.env` 自体の暗号化（storage 暗号化）は別提案（P-0314 相当）として切り出し可能。