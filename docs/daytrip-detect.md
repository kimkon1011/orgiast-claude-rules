# 日帰り出張候補の確認

`tools/daytrip-detect.mjs` は kim@orgiast.jp の primary カレンダーから日帰り出張の候補を集計し、Claude Code のセッション内で確認する。規程施行日は2026-11-01、日当は代表5,000円。推定だけで出張と確定せず、kimの「はい」を受けて報告書へ追記する。

## 検出

既定はJSTで昨日まで過去7日＋今日から6日先までの今後7日（合計14日、両端を含む）。`--from YYYY-MM-DD --to YYYY-MM-DD` で変更できる。候補の抽出では終日、キャンセル、本人が辞退した予定、場所なし、オンラインURLだけの場所、`【自動】` 付き予定は集計しない。対面予定をJSTの日付でまとめ、同一内容の重複も除く。

勤務地は大阪市東成区深江北2-15-24（34.6760, 135.5530）。その日の各目的地との直線距離を計算し、最大値×1.3を推定片道道路距離、片道移動時間は道路距離100km未満なら÷40km/h、100〜700kmなら÷200km/h＋0.5時間（新幹線想定）、700km超なら2.5時間（飛行機想定）とする。外出時間は最初の予定開始から最後の予定終了＋往復移動時間で、予定終了と推定帰着は当日の24:00、推定出発は当日の00:00で切り、最大24時間とする。表示は距離を整数km、時間を0.5時間単位に丸めるが、4時間の判定には丸め前の値を使う。目的地間の経路や実際の交通ダイヤは計算していない。

推定道路距離50km以上かつ外出4時間以上を候補とし、直線35〜50km帯と距離不明も要確認候補に残す。会食・懇親会・ゴルフ・接待等のみの日は注記する。日跨ぎ予定、宿泊を示唆するタイトル・場所、24時間以上の推定には宿泊可能性を注記する。実際の宿泊有無や出発帰着の確定は本人判断が必要。施行日前もdry-runでは検出するが、本番の質問・追記対象にはしない。

場所をNominatimで検索し、見つからなければ既存`llm-ask.mjs`（Gemini優先、`FALLBACK_CHAIN`）で市区町村を推定して再検索する。LLMの生成座標は使わない。市区町村代表点には概算の注記を付ける。全て失敗しても距離不明として候補に残す。

[Nominatim利用規約](https://operations.osmfoundation.org/policies/nominatim/)に従い、User-Agentを付け、単一PC・直列処理・キャッシュを使う。定期スクリプトは毎分4件までのため公開サービスには15秒以上の間隔を設ける（1秒1件の上限より厳しい）。検索結果の出典は © OpenStreetMap contributors。外部に送るデータは場所の文字列のみで、予定名・参加者はジオコーダーやLLMへ渡さない。

## セッションでの確認と回答

定期実行は候補に永続的な番号を振り、施行日以降・未回答の候補全件を `pending.json` に原子的に保存する。番号は再利用しない。過去の台帳の batch・queued も引き継ぐ。候補の文字数による分割や切り捨ては行わない。

`daytrip-ask-hook.mjs` が SessionStart / UserPromptSubmit でローカルの一覧を読み、Claude Code に「🚗 日帰り出張の確認（カレンダーから自動検出）」として全文を表示するよう指示する。宿泊なし・片道50km以上・外出4時間以上の業務出張かを確認し、会食・接待のみは対象外とする。pending がないPCでは無出力。hook はネットワークを使わず、入力待ちは75msで打ち切り、エラー時は無出力で終了する。

同一セッションでは候補番号の集合が変わらない限り1回だけ通知し、新しいセッションでは未回答の間は毎回通知する。別の話題だった場合は、本題への応答後にもう一度だけ一覧で確認する。

回答例:

```sh
node tools/daytrip-detect.mjs --answer "はい 1,2 いいえ 3"
```

Claude Code が回答をそのまま `--answer` に渡す。曖昧な形式、重複番号、pending に存在しない番号が含まれる場合、回答全体を保存せず stderr に理由を表示して exit 1。受理した回答は decision として台帳に保存し、pending から除く。「いいえ」は対象外として記録する。「はい」は今日（JST）以前なら即時追記、未来なら「YYYY-MM-DD は当日以降の20:00に報告書へ追記予定」と表示する。未来の承認は当日以降の定期実行で追記する。回答済み番号への再回答は受け付けないため、回答後の訂正は台帳・シートを確認して運用者が行う。追記する内容は確認時点の候補スナップショット。

報告書: spreadsheetId `156XZ7L2bA1eMI17kxH3Sb-NQyCUI8DXGMT6HXO3ShBc`。A〜Pの見出しが依頼の16列（または実シートで確認した「出張区分(宿泊/日帰り)」「勤務地からの片道距離(km)」等の補足付き見出し）と列順も含めて一致するタブを一意に特定する。Sheets APIに既存DWDのdriveスコープを使用し、`RAW`・`INSERT_ROWS`で末尾へ追加して読み戻す。1行目の見出しと2行目の記入例は変更しない。氏名=金功勇、役職=代表、区分=日帰り、目的=予定名、面談者=外部ドメイン参加者、日当=5000。行先と所在地は予定の場所。交通手段・添付・承認者は空欄。出発・帰着・所要時間は推定と明示。不明は不明と記載する。

追記ごとに「1件を報告書に追加しました」とA〜Pの内容全文を stdout に出す。`--answer` 実行時は Claude Code がそのまま user に表示する。定期実行で未来分を追記した結果も stdout に出す。

## 状態・復旧

状態ディレクトリは `~/.claude/daytrip-detect/`（`ORGIAST_HOME` があればその配下）。

- `config.json`: 設定。未作成なら既定値を使う。
- `geocache.json`: 場所・市区町村ごとの検索結果、検索時刻。正常な検索の空結果もキャッシュ。通信失敗は永続キャッシュしない。
- `ledger.jsonl`: 追記型の永続台帳。queued、batch（日付キー・番号・質問本文）、decision、append-intent、recordedをfsyncして保存する。削除すると質問の重複防止情報を失う。
- `pending.json`: updatedAt と未回答候補の items（番号・日付・予定名・場所・距離・時間・注記・表示用 line）。tmp に書いて rename する。
- `shown.json`: session_id ごとの候補番号集合の hash と表示時刻 at。30日を過ぎた記録は次回表示時に掃除する。
- `run.lock`: PIDによる排他。生存中のプロセスが持つロックは奪わず、死んだPIDだけ回収する。dry-runも共有キャッシュを保護するため排他する。

追記直前の append-intent があり recorded がない場合、シートの同一16列を読み戻して照合する。見つからなければ結果不明として自動再追記を停止する。運用者が実シートを確認し、バックアップした台帳の該当intentのみを取り除いて再試行する。追記が成功していないことを確認するまでintentを削除しない。同日・同氏名の日帰り行があり内容が違う場合も自動追記を止める。回答保存後の追記失敗でも pending は更新し、承認は台帳に残すため次回定期実行で復旧処理を行う。定期実行と `--answer` は同じロックを使用する。

設定例（`--config path` でも指定可）:

```json
{
  "disabled": false,
  "workplace": { "address": "大阪市東成区深江北2-15-24", "lat": 34.6760, "lon": 135.5530 },
  "nominatimUrl": "https://nominatim.openstreetmap.org/search"
}
```

## 実行と停止

```powershell
node tools/daytrip-detect.mjs --self-test
node tools/daytrip-detect.mjs --dry-run --from 2026-09-01 --to 2026-10-29
powershell -File tools/register-daytrip-detect-task.ps1 -Ensure
```

dry-runは実カレンダーとジオコーダー/LLMを読み、検出結果をJSONで出力する。キャッシュと一時ロックだけを更新し、シート・質問/確認台帳には書き込まない。self-testはフィクスチャのみでネットワーク不要。

Windowsタスク`OrgiastDaytripDetect`を毎日20:00（PCのローカル時刻、kim-PCはJST）に非表示起動する。登録先は同期済みmainのみ。schedule-syncと同じ`Downloads\claude-mobile\app\api\line-ingest\route.ts`の存在判定でkim-PCに限定する。新規install、既存PCの日次fleet-poller、setup-manifest経由の`setup.mjs --converge`から`-Ensure`を呼ぶ。

セッションhookは全PCの `register-hooks.mjs` と setup-manifest（実体＋2イベント）を通じて既存PCにもconvergeで配布する。候補がないPCでは無出力になる。

恒久停止はconfig.jsonの`disabled`をtrueにする。タスクの削除だけではconvergeで復活する。停止設定後、必要なら`powershell -File tools/register-daytrip-detect-task.ps1 -Remove`で削除する。再開はdisabledをfalseにして`-Ensure`。このPRの受け入れ確認では本番登録・シート書き込みは行わない。

## 終日予定による宿泊除外

kim@orgiast.jp の calendarList を全ページ取得し、非表示・共有を含む全カレンダーの終日予定を確認する。祝日カレンダーは対象外。読み取りには calendar.readonly スコープを使い、取得失敗時は質問の追加を中止する。

タイトル・場所に大阪および日帰り圏（京都・兵庫・奈良・滋賀・和歌山）以外の都道府県・県庁所在地・政令市が含まれる日は宿泊とする。判定リストは tools/daytrip-overnight-config.json に置き、config.json の overnight で全体を上書きできる。複数日にまたがる終日予定は地名によらず宿泊扱い。Google の end.date は含めず、前日開始の予定も判定する。キャンセル・本人辞退の予定は対象外。

宿泊日は既存形式の decision に status = `overnight(終日予定: <予定名>)` を保存し、既存 pending・queued からも除外する。回答形式・台帳構造は変更しない。dry-run は candidates と excluded（日付・理由）を出力し、台帳は更新しない。

## 距離による宿泊除外

終日予定がなくても、推定片道道路距離が300km以上の日は宿泊出張として質問対象から除外する。しきい値は `tools/daytrip-overnight-config.json` の `minRoadKm`（正の数）で設定し、状態設定の `overnight.minRoadKm` で上書きできる。丸め前の距離で判定し、台帳には `overnight(片道約498km)` の形式で記録する。既存の未回答・承認済み候補も、報告書追記前に除外する。dry-run は台帳を更新せず除外理由を出力する。
