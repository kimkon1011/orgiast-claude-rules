# event-shop.jp PR#5 本番反映検証レポート (2026-10-28)

## 概要
- **対象**: `seisaku-team-org/event-shop` PR#5 (commit: `e67d621`, Next.js 16.2.10 → 16.4.1 脆弱性対応アップデート)
- **確認対象**: 本番サイト `https://event-shop.jp/`
- **結論**: **反映完了 (FINAL / done)** — 2026-10-28 11:09Z 再観測でも全基準を直接照会で再確認済み

---

## 検証結果と直接証拠

| 基準 | 判定 | 実測値・証拠 |
| :--- | :--- | :--- |
| **C1: nishi-PC 連絡状態** | **証明済** | `node tools/fleet-mail.mjs --sent-status mail-1793013144457-df34035a`（2026-10-28 11:10Z 再照会）<br>・`status: done`<br>・`deliveredAt: 2026-10-26T11:12:51.157Z`<br>・`seenAt: 2026-10-26T11:13:01.770Z`<br>・`resultAt: 2026-10-26T11:16:46.796Z`<br>（依頼受信・完了確認済み） |
| **C2: HTTP 疎通** | **証明済** | `https://event-shop.jp/` への GET リクエスト（2026-10-28 11:09:12 GMT 再観測）<br>・Status: `HTTP/1.1 200 OK`<br>・Date: `Wed, 28 Oct 2026 11:09:12 GMT`<br>・Server: `Vercel`<br>・X-Vercel-Id: `kix1::ppbd5-1793185752682-52d6ac874f82` |
| **C3: 新版反映の直接証拠** | **証明済** | (1) **Etag 変化**: 反映前 `0c4308771837600f98de8e4860b08878` → 現行 `"1df5bdffd6b83234aca3da899bc4a7d5"`<br>(2) **Content-Length 変化**: 108,308 bytes → 現行 109,642 bytes<br>(3) **Age**: 90,478秒（約25時間前の再デプロイ以降・反映前の 480,102秒＝約5.5日からリセット）<br>(4) **反映前チャンクの消滅**: 旧チャンク (`07694pm6o3mg7.js`, `0cz1d0mv5g_q7.js`, `0ha4m18glnjqn.js`, `1a7xoig0bpx25.css`) は現行 HTML に 0 件、旧チャンク URL `/_next/static/immutable/chunks/07694pm6o3mg7.js` は **HTTP 404**<br>(5) **Next.js 16.4.1 実稼働の確定**: 現行 HTML が参照する新チャンク `_next/static/immutable/chunks/0aj6ghfe1g-m8.js`（HTTP 200・230,058 bytes）内に `window.next={version:"16.4.1",appDir:!0}` を直接検出。Turbopack ビルド（`turbopack-1cvbnb3nlabgn.js`）も稼働中＝Next.js 16系のビルドシステムと一致 |
| **C4: リポジトリ健全性** | **証明済** | 関連テスト `node --test tools/delegation-health-check.test.mjs tools/delegation-health-billing.test.mjs`（2026-10-28 再実行）＝**123 pass / 0 fail**、回帰なし。 |

---

## 判定詳細
- 反映前値（2026-10-27 観測）から Etag, Age, 静的チャンクが完全に切り替わっており、デプロイされたアセットから Next.js バージョンが `16.4.1` であることが直接確認されました。
- これにより、PR#5（Next.js 16.4.1 更新）が本番環境へ正常にデプロイ・反映されたことが確認されました。
