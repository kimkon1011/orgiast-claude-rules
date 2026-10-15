# Decision Record

## decision_id
DEC-0003

## date
2026-10-15

## status(ACTIVE|SUPERSEDED)
ACTIVE

## project
memory 全社配布パイプライン（orgiast-memoryserve）

## QUESTION
memory 配信口を keyserve から分離し、認証を /api/keys へ委譲する。

## CONTEXT
- kim-PC の memory（約870件）を全社PCへ毎日配る配信口が必要。
- 同居案（keyserve に api/memory.js を足す）は実装・テスト済みだったが採用しなかった。
- バンドルは毎晩変わるため、毎晩 `vercel deploy` が発生する。

## OPTIONS
- (a) keyserve 同居（api/memory.js を追加）
- (b) Drive ハブ配布（他PCの Claude に Drive MCP/SA 鍵が無い）
- (c) private GitHub リポ（読み取り PAT の配布が別途必要）
- (d) 専用 Vercel プロジェクトに分離し、認証を keyserve /api/keys へ委譲

## DECISION
(d) 専用 Vercel プロジェクト `orgiast-memoryserve`（GitHub kimkon1011/orgiast-memoryserve private、`https://orgiast-memoryserve.vercel.app/api/memory`）。認証は受信ヘッダ3つ（x-orgiast-ts / x-orgiast-auth / x-orgiast-pc）を keyserve `/api/keys` へ転送して 200 なら許可。秘密値をこのプロジェクトに持たない。

## WHY
バンドルは毎晩変わるので毎晩 `vercel deploy` になる。keyserve 同居だと鍵配布の認証面（keys/enroll）を無人で毎晩上げ直すことになり、過去の全PC締め出し事故（2026-08-21/25、09-14/16）と同型になる。

## TRADE-OFF
- 捨てた利点: デプロイ先が1つで済む運用の単純さ（同居案）。
- 受け入れる不利益: Vercel プロジェクトが1つ増える。認証が /api/keys の可用性に依存する。

## ASSUMPTIONS
- keyserve には git 連携＋ステージング環境が無く、無人デプロイは巻き戻せない。
- 配信は毎晩更新される。

## REVERSIBILITY(REVERSIBLE|PARTIALLY_REVERSIBLE|IRREVERSIBLE)
REVERSIBLE

## REVISIT_TRIGGER
- keyserve に git 連携＋ステージング環境ができ、無人デプロイの巻き戻しリスクが消えた時は同居に戻してよい。

## RELATED
- docs/memory-share.md
- memory project_memory_full_share_pipeline
- 捨てた案: keyserve 同居／Drive ハブ配布／private GitHub リポ
