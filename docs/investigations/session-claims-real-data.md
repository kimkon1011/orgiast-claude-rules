# session-claims 実データ調査（2026-09-24）

> 以下は修正依頼5より前の調査記録。旧「38件成功」は件数・保存のみの検証で、目的の意味を検証できていなかった。目的取得の修正と最新の受け入れ結果は末尾を参照。

## 確認した事実

- 入力は `/mnt/c/Users/uers/.claude` の実ファイル。session-purpose は2,060件、非空の purpose は1,298件。空のJSONが3件あり、debugで個別の SyntaxError を確認した。
- 実キーは `sessionId`, `startedAt`, `promptCount`, `purpose`, `purposeTokens`, `lastNudgeAt`, `nudgeCount`, `nudgedAtCount`。
- transcript の実構造は `type: "assistant"`, `message.content: [{type: "text", text: "..."}]`。既存実装はこの形を既に読める。実レコードと対応する gate を匿名化した fixture を追加した。
- project 直下の transcript は264件、8時間以内29件。既存実装の再帰走査では subagents も含め2,282件、8時間以内60件となる。件数の差はパスの違い。
- Windows Node v24.14.1 で homedir は `C:\Users\uers`。CLI入口は実行されることを、書き込みを止める preload で確認した。WSL Node v24.19.0 の通常 homedir は `/home/kim`。
- WSLから実ホームへの台帳保存は sandbox の EROFS で失敗する。debugで可視化した。実データの読取りでは生存claimが38件になり、入力ゼロは再現していない。

## 変更

- `--debug` の場合だけ stderr にホーム・入力パス・走査件数・目的取得件数・生存件数・捕捉した例外を出す。通常の無音／exit 0 は維持。
- 保存先ディレクトリの作成失敗が read-only の list/filter まで止めないようにする。
- 8時間超の transcript は mtime のみ利用し、本文読取りを省く。gate/log の期限切れ判定は維持。
- 成功した `--sync` で同じデータをもう一度走査しない。

## 実データによる保存・一覧の検証方法

`/tmp/session-claims-real-home/.claude/` に `session-purpose` と `projects` の実ディレクトリへのsymlinkを作成。入力本文・mtimeは実ファイルのまま、台帳のみ書き込み可能な `/tmp` に保存する。実入力のコピー・合成・mtime変更は行わない。

```sh
HOME=/tmp/session-claims-real-home USERPROFILE=/tmp/session-claims-real-home node tools/session-claims.mjs --sync --debug
HOME=/tmp/session-claims-real-home USERPROFILE=/tmp/session-claims-real-home node tools/session-claims.mjs --list
node --test tools/session-claims.test.js tools/session-claim-collision.test.js
```

## 未確定事項

依頼時の Windows 実環境で「一覧0行、台帳未生成」になった根本原因は未確定。構造不一致や Windows パス不具合を原因と断定する証拠は得られなかった。WSLの書込み制限を、依頼時の Windows 障害の原因と同一視しない。本番ホームへの台帳保存は権限制限により未検証。settings.json は変更していない。

なお `--sync` はキャッシュ `session-claims.json` を生成する。追記ログ `session-claims.jsonl` は `--claim` / `--release` で初めて生成されるので、syncだけで追記ログが存在しないのは正常。

## 最終確認結果

修正後の `--sync --debug` は stdout 0 byte、stderr に以下を出力し、保存したキャッシュを読み直して生存38件を確認した。

```text
session-purpose 走査 = 2060 / purpose 取得 = 1298; transcript 走査 = 2282 / transcript 8時間以内 = 60 / assistant 宣言取得 = 31; 生存 claim = 38
```

実入力に対する一覧は38行。既存24本 + collision 5本 + 追加2本 = 31本が pass、fail 0。追加テストでは HOME/USERPROFILE のみの差し替え、実構造の gate と transcript 両方の抽出、debugのstderr分離、解析・キャッシュ・最上位例外、ディレクトリ作成失敗時の一覧継続を確認した。

## 修正依頼5: 目的の正本を修正

原因は gate の `purpose`（最初の user プロンプト）を transcript より優先していたこと。旧テストもこの優先順位を期待していたため、本文の汚染を検出できなかった。

- 自動取得では transcript の `type === 'assistant'` のテキストにある最後の宣言を優先し、同じ行の目的だけを採用する。user、system、thinking、tool_use は対象外。
- gate は文字列全体が宣言1行の形式に一致するときだけフォールバックに使う。通常の初回プロンプトや、説明文に埋め込まれた宣言は採用しない。
- 宣言がない場合は自動 claim を作らず、旧自動取得結果も引き継がない。明示的な `--claim` / `--release` のログ操作・排他制御は維持する。
- debug にセッションID単位の宣言あり／なし件数を追加した。8時間超の transcript は従来どおり本文を読まないため、「宣言なし」は今回の走査で採用可能な宣言が得られなかった件数（期限外も含む）。ファイル単位の取得数とセッション数は重複IDがあると異なる。

再発防止のテストはノイズ4種類、宣言形式の gate、複数 assistant 宣言の最後の採用、短い目的、旧自動取得 claim の除去を追加。既存の user 行除外・並行追記・release のテストも維持した。

```sh
node --test tools/session-claims.test.js tools/session-claim-collision.test.js
```

結果: session-claims 33件 + collision 5件 = 38件 pass、fail 0。

### 修正後の実データ受け入れ結果

`/mnt/c/Users/uers/.claude` の実入力を symlink で参照し、`ORGIAST_HOME=/tmp/session-claims-purpose-real-3ypa284p` を指定して `--sync --debug` → `--list --json` → `--list` を実行。本文・mtimeの加工はしていない。本番ホームの書き込み制限を守り、台帳は検証ホームにのみ保存した。

```text
session-purpose 走査 = 2060 / purpose 取得 = 1298
transcript 走査 = 2282 / transcript 8時間以内 = 60 / assistant 宣言取得 = 31
宣言を持つセッション数 = 30 / 宣言が無くスキップした数 = 2492
生存 claim = 30
```

- 旧実測38件から30件に減少。通常一覧30行、JSON一覧30件、sync後キャッシュの生存30件が一致。
- 別の Python 検証で各セッションの最新 transcript を読み直し、30件すべてが最後の assistant 宣言の同一行目的と完全一致することを確認。全件の source は transcript。
- `<agent-message`、`<ide_opened_file`、URL単体、「あなたは…秘書」の混入は0件。複数行の目的も0件。
- settings.json は変更していない。実データ検証の前後で SHA-256 が一致。
- 検証ホームには `sync.debug`、`list.json`、`list.txt`、各行の元 transcript と目的を記録した `audit.json` を保存。検証スクリプトは `/tmp/verify-session-claims-purpose.py`。

本番ホームの台帳保存・hook登録は行っていない。この結果は実入力と検証用台帳による受け入れ確認であり、本番台帳を更新したという意味ではない。
