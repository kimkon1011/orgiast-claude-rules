# 長時間ジョブの通知欠落: 実測と修正（2026-11-06）

## 実測

対象: session `3088a590-375b-4bb6-ba26-2690e25f812d`。
Windows の実データは読み取りのみ。表示・補正の再現は `/tmp/progress-evidence` に複製した inbox 4,032件で実施した。
`nightly-repo`、Discord allowlist、既存データ、Windows タスクの設定は変更していない。

- 実行ログ: `start 2026-10-29T15:00:25.1171339+09:00`、`end 2026-10-29T20:50:25.6775409+09:00 exit=0 rounds=1`。CRLF 37個、notify-kim の出力なし。
- 元の JavaScript `/^end .* exit=0$/m` は CRLF 単独には一致する。実際の不一致は追加の ` rounds=1`。grep 等の `$` と CRLF の問題も登録時に警告する。
- 巡回 summary の件数: 10/30=24、10/31=24、11/01=24、11/02=22、11/03=24、11/04=24。巡回停止が5日遅延の主因ではない。
- 同期間の主な例外は sheet ロック待ち73回。対象 session の done-DM 証跡は0件。
- 調査時の OrgiastAutoProgressWatch: Running、最終実行 2026-11-06 09:00:01 JST、次回10:00、PT1H、実行先 nightly-repo。LastTaskResult 267009 は実行中。TaskScheduler Operational は無効で、過去のイベント履歴は取得できない。
- 台帳: doneAt `2026-10-30T01:15:25.892Z`、inbox 作成 `2026-11-04T13:16:47.727Z`。`ki-20261104131647-f670` は open info、shownCount=0、「kim がすること: なし」。現在の台帳は更新済みのため、過去の pending の各時点は復元できない。
- 旧実装（#1510 直前）は `checkNotifiedResult=done` を再送対象から除外し、汎用 done sweep も `checkResult=done` を除外していた。inbox 受領証ではなく判定フラグを通知済み扱いしていた。#1510（11/04 20:14 JST）の inbox 読み戻し導入後に実際の保存が行われた時系列と整合する。
- 11/06 の実 hook-metrics: kim-inbox 10回すべて未実行。3回 load-shed、7回 timedOut、処理時間0ms。例: 00:07:51Z は queueMs=7770。5秒の制限をキュー待ちだけで超過していた。
- inbox 複製に同じ session_id で `node tools/kim-inbox.mjs --context` を実行: pristine main の出力に対象IDなし。修正後は対象IDあり。own/high の選択に加え、表示予算が対象を追い出していた。
- notifyKim の classifyKimDm 禁止分岐は persistKim より前に `delivered=blocked` を返していた。CLI は exit 3 だが、API 呼出側が返値を無視すると本文を保存せず消失する。

## 修正

- dispatcher で kim-inbox を省略対象から外し、先頭で実行。待機時間を実行予算から差し引かない。旧 runtime manifest でも有効。
- inbox は未表示のジョブ完了・定期進捗と未回答の完了承認依頼を独立した表示枠へ。info は短く一覧化し、ask の承認項目は維持。表示の出力後に shownCount を更新し、更新中の worker timeout でも完成した context を破棄しない。
- check 達成時に同じ巡回で inbox に保存・読み戻し。失敗時は pending を残し、成功時だけ receipt を記録。
- `--done-file`、既存 artifact、チェック対象 `scheduled-<job>-YYYY-MM-DD.log` の兄弟 `<job>-DONE.md` から承認一覧を決定論的に抽出。LLM 追加なし。成果物が読めない場合は「未確認」であり「なし」にしない。
- 既に保存された誤った info も、次の巡回で同じIDの ask へ補正。回答済みの ask は再開しない。
- open/check と scheduled/start-when の未達・エラーは6時間ごとに high info を更新。最終確認、判定、ログ末尾を保存。同じ内容は「変化なし」。ジョブごとの固定キーで項目を増やさず、読み戻し失敗なら通知時刻を進めない。
- Discord 禁止分岐は原文を inbox に保存し、保存も失敗した場合は既存 spool 経路へ。両方失敗すれば delivered=none / CLI非ゼロ。
- 別PCからの転送にも producer source/key を引き継ぎ、更新時に再転送する。heartbeat のキーは秘密値マスクに潰されない形式とし、異なるジョブを混同しない。
- 通常の setup --converge で配布。個別PCへの配布・Discord解禁はしていない。

## 実 DONE から生成した承認依頼

生成結果 `kind=ask`、承認待ち8件:

1. keyserve PR のマージ（＝Vercel 本番デプロイ）
2. 本番の鍵と設定の投入
3. パスキー登録（kim のスマホで1回だけ）
4. rules PR のマージと全 PC への配布
5. 既存の平文引き継ぎ書の扱い
6. Drive ハブ `claude-common-rules` の外部共有
7. Workspace の DWD スコープ追加
8. 退職者のアカウント停止そのもの

これは10/29成果物の要約であり、承認や本番操作の実行ではない。
元の通知IDを保持した info→ask 補正後、無関係の session_id の `--context` 出力でも対象IDと8番目の項目まで確認した。

## 検証方法

- 関連: `node --test tools/progress-delivery.test.mjs tools/auto-progress*.test.mjs tools/kim-inbox*.test.mjs tools/notify-kim*.test.mjs tools/hook-dispatch.test.mjs`
- 全体: `tools/*.test.mjs tools/lib/*.test.mjs` の572ファイルを Node test runner で実行。初回90秒の上限を超えた6ファイルは実行時間を延長して再実行。
- pristine main `1befde7` の独立 worktree でも同条件の失敗・遅延を比較。削除承認の7件は `/tmp` worktree と os.tmpdir の重複が原因で、`TMPDIR=/tmp/progress-test-temp` に分離すると15/15合格。コードの変更・テスト除外は不要だった。
- WSL の Windows PATH を含む状態では CLI 探索が極端に遅い。Linux CI と同じ Linux のみの PATH で長時間ファイルを再実行した。fleet-mail-v2 は今回の基準点では合格（過去の既知赤を無条件には適用しない）。
- 関連テスト328/328合格。

- `node tools/selftest-guards.mjs`: 69項目すべて合格。
