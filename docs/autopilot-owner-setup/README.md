# この PC の定時報告設定

実装は `fix/autopilot-digest-owner-toast` の worktree 内にあります。配置は Windows 側の監督セッションで行います。rescue 作業ツリー・本番設定・nf-minpaku-automation はこの作業では変更していません。

## 配置原本

| 原本 | 配置先 |
| --- | --- |
| `autopilot-owner.json` | `C:\Users\kimko\.claude\autopilot-owner.json` |
| `waiting-on-user.json` | `C:\Users\kimko\.claude\waiting-on-user.json`（既存台帳があれば id で追加し、上書きしない） |

check-token の正本は `tools/instagram-check-token.mjs` です。tools/ 内の .mjs は tools 外へ相対 import できない（`no-undistributed-imports` テスト）ため、テストから直接参照する正本は配布対象の tools/ に置き、配置時だけファイル名を `check-token.mjs` に変えてコピーします。
| `../../tools/instagram-check-token.mjs`（正本・配布対象） | `C:\Users\kimko\nf-minpaku-automation\tools\instagram\check-token.mjs`（配置名を変えてコピー。同じフォルダに `tools/is-entry.mjs` もコピーする） |

所有者は nishi@orgiast.jp、Discord ID は未特定のため null です。所有者設定がなければ不明扱いとし、git 設定から推定しません。kim の照合には既存の `KIM_DISCORD_USER_ID` と `kim@orgiast.jp` を使用します。所有者の Discord ID が確定したら `discordUserId` に文字列として記入します。DM と制御返信の宛先に優先適用します。所有者設定が壊れている場合（JSON 不正など）は autopilot を止めず、stderr に理由を出して従来の宛先に戻します。誤配送の検出はできなくなるため、`dm-not-owner` が出ないときは設定を確認してください。

## 挙動

- 定時報告は本文を書き換える通知ゲートを通さず、既存の Discord 配送関数を `plainJa:false` で使用します。Discord の 2,000 文字制限は残り、全文はローカルファイルに残ります。
- `sendNotice` は `~/.claude/autopilot/latest-digest.md` を上書きし、Windows では PowerShell と標準 WinRT API で先頭3行をトーストとして渡します。外部モジュールは不要です。他の autopilot 通知もこの経路を使います。
- 戻り値の `delivered` は従来の DM 配送状態を維持し、kim 宛てかつ所有者が別人なら `dm-not-owner` になります。ローカル結果は `channels.toast` / `channels.file`、DM は `channels.dm` に記録します。
- `toast.status=submitted` は Windows API への表示要求成功です。人の閲覧や集中モードによる抑制がないことまでは保証しません。`file.status=written` も本人の閲覧を意味しません。Discord の実到達確認には別途読み戻しが必要です。
- 台帳は配列のまま保存し、完了項目を同じファイル内の `status:"done"` グループへ移します。`list` は `pending` と `done` に分けます。完了履歴を保持するため重複 id は拒否します。
- 各 check はローカルの信頼できるコマンドを20秒制限で実行します。失敗時は本文に「未確認」と載せ、例外本文やトークンは載せません。待ち日数は JST の暦日差です。台帳 JSON が壊れている場合も定時報告は止めず、`user 作業待ち` の節を省いて `run.log` に `waitingError` を残します。
- Instagram の check は `.env` が無い／`INSTAGRAM_ACCESS_TOKEN` が空なら「token_missing」（未完了）として扱い、「未確認」にはしません。通信失敗や HTTP エラーだけが「未確認」です。
- 完了項目は報告に一度だけ載せます。DM（所有者宛て）・トースト・ファイルのいずれかに出力できたら `reportedAt` を保存します。全経路が失敗したときや dry-run では消費しません。プロセスが出力後・保存前に落ちた場合には次回重複する可能性があります。
- 台帳の更新はロックと一時ファイルの rename で保護します。稼働中の check と CLI が競合すると `waiting_ledger_busy` を返します。

## CLI

```powershell
node tools/waiting-on-user.mjs add --id example --title "人の操作" --since 2026-10-23 --next-step "登録画面で入力する" --cmd 'node "C:\path\check.mjs"' --done-when complete
node tools/waiting-on-user.mjs list
node tools/waiting-on-user.mjs done --id example
```

`--home` でテスト用 home を明示できます。check は任意です。`done` は次の報告で一度だけ完了を表示します。

## 送信しない本文確認

本番の state が存在する Windows 環境では次を実行できます（check は実行しますが、DM・トースト・latest-digest 更新・完了通知の消費は行いません）。

```powershell
node tools/autopilot-tick.mjs digest --dry-run --pretty
```

配置前の原本で再現するサンプルはこちらです。検証用の目的・2026-10-23 の固定日時を使い、作業用 home をこのディレクトリ内に作ります。本番の稼働状態を示すサンプルではありません。

```powershell
node docs/autopilot-owner-setup/preview-digest.mjs
```

生成結果は `verification/digest-sample.md`。WSL では初期 check の Windows パスが実行できないため「未確認」が付きます。Instagram の実トークン確認は配置後に Windows で行います。check-token は `.env` を配置先の相対パスから読み、トークンを Authorization ヘッダーだけに渡します。アカウント名の完全一致を検証します。

## 実機トーストの確認

```powershell
node docs/autopilot-owner-setup/toast-once.mjs
```

このコマンドはトーストだけを1回要求します。DM は送りません。2026-10-23 に Windows の Node から1回実行し、`{"status":"submitted"}` を確認しました（記録: `verification/toast-live.json`）。`submitted` は Windows API への表示要求の成功で、人が見たことまでは保証しません。未達なら `channels.toast.status` は `failed` と理由になります。

## テストと Git

指定の `node --test tools/` は Node 22.23.3 と 24.16.0 の両方で、ディレクトリをモジュールとして解決しようとして `MODULE_NOT_FOUND` になります。代わりに `tools/` 直下のテストファイルを glob で渡します（テストファイルはすべて直下にあります）。

```bash
node --test "tools/*.test.mjs" "tools/*.test.js"
```

2026-10-23 の Windows 実行では 6,5xx 件中、既存の環境依存失敗（PowerShell モック系など）だけが残り、今回追加した 90 件は全て pass しました。生ログは `verification/*.log`（Git 対象外）に残しています。

コミットと push は Windows 側の作業ツリーで実施しました。PR は作成していません（gh 未ログイン）。
