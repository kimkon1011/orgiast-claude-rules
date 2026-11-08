# Decision Record

## decision_id
DEC-0002

## date
2026-10-15

## status(ACTIVE|SUPERSEDED)
ACTIVE

## project
社員用リモート環境の Linux サーバー集約（R640）

## QUESTION
事務所のデスクトップ20台（Chromeリモートデスクトップ運用）を、どの方式で1台のサーバーに集約するか。

## CONTEXT
- Dell PowerEdge R640（Xeon Gold 6140×2）を 56,320 円で落札済み。メモリ/SSD は調達中（SSD は社内PCから流用）。
- Chromeリモートデスクトップは 1 ホスト 1 Google アカウントの制約があり、1台のサーバーを複数社員で共有できない。
- 社員の初回操作は 0 回にしたい（手作業最小化）。
- Windows 依存の棚卸し: ps1 78本、pwsh 前提 hook 19/71、C:\Users 直書き 55 ファイル、schtasks 48 ファイル。外部連携は API/MCP で Linux 可。

## OPTIONS
- (a) 現状維持: Windows デスクトップ20台 + Chromeリモートデスクトップ
- (b) Linux サーバー1台 + Chromeリモートデスクトップ
- (c) Linux サーバー1台 + Apache Guacamole（主）+ xrdp（副）

## DECISION
(c) を採用する。

## WHY
Guacamole はブラウザだけで複数ユーザーが同一サーバーの別セッションに入れ、社員側のインストール・初回操作が 0 回で済む。xrdp は予備経路として併設できる。

## TRADE-OFF
Chromeリモートデスクトップの手軽さと Google アカウント連携を捨てる。Windows 依存スクリプトの Linux 移植コストと、Guacamole 認証（ID+PW か Google OIDC）の運用を受け入れる。

## ASSUMPTIONS
- Chromeリモートデスクトップの 1 ホスト 1 アカウント制約が今後も変わらない。
- R640 のメモリ 128GB 以上が確保できる（落札結果で確定）。
- 構築は Codex に委譲でき、移植は Claude が検証できる。

## REVERSIBILITY(REVERSIBLE|PARTIALLY_REVERSIBLE|IRREVERSIBLE)
PARTIALLY_REVERSIBLE

## REVISIT_TRIGGER
- Chromeリモートデスクトップが複数アカウント同時利用に対応した。
- Guacamole の同時接続で実測の遅延や不安定が社員業務を妨げた。
- メモリ調達が 128GB に届かない。

## RELATED
- handoff: auto-session/handoffs/r640-linux-build.md
- 未確定: 初期パスワード配布経路／社員一覧 CSV の出所／固定 IP とバックアップ先／認証方式／メモリ容量
