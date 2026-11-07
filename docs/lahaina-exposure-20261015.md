# ラハイナ 露出スコア 2026-10-15 実測（クラウドRoutineの egress 制限を回避）

## 結論（先に3行）
- **クラウド Routine の egress 制限は回避できた。** 制限が掛かっているのは claude.ai 実行環境のプロキシだけで、
  **普通のPCからは lahaina.jp / www.jalan.net / travel.rakuten.co.jp / www.instagram.com に全て HTTP 200 で到達できる**（2026-10-15 実測）。
- したがって計測は kim の UI 設定操作を待たずに **PC 上で実行できる**。その計測ツール `tools/lahaina-exposure-check.mjs` を実装した。
- **露出スコア 2026-10-15（在庫照会日 10/20）= 1/6**（確定分 1/4・未計測2件）。警戒水準 3未満 → **警戒**。

## 実測結果

| 媒体 | 判定 | 根拠（実データ） |
|---|---|---|
| じゃらん | **buyable** | プラン検索（adultNum=2・10/20）が料金表記 **13,750円** を返す（=2名27,500円。既知の【鴨鍋＋真鯛の香草焼き】プランと整合）。「予約受付を停止」の文言は0件 |
| 楽天トラベル | delisted | `https://travel.rakuten.co.jp/HOTEL/37967/` が **「指定されたページは掲載終了しました。」**（HTTP 200・本文1,648バイトのエラーページ） |
| 公式HP | not_listed | `https://lahaina.jp/` の `href` に予約導線リンクが**0本**（jalan/rakuten/booking/airbnb/beds24 いずれも無し）。お知らせの最終は 2026.06.05 から変化なし |
| Booking.com | unmeasurable | curl は bot 遮断（HTTP 202・本文約8.4KB）。WebFetch では検索結果「0軒に空室があります」＝**掲載なし**。ただし自動計測では **未計測**扱い（理由は下記） |
| Airbnb | not_listed | `https://www.airbnb.jp/s/牛窓町/homes`（本文1.1MB）に「ラハイナ」を含まず |
| Google | unmeasurable | Google 検索は bot 遮断で機械取得不可（WebFetch も「Google 検索にアクセスできない場合は…」のエラーページのみ）。**0 と決めつけない** |

### Booking を「未計測」にした理由（誤検知の実測）
最初は「検索結果に『ラハイナ』が含まれれば buyable」と判定していたが、**同じURL・同じ条件で 3回中1回だけ 2/6 に振れた**。
原因は Booking の bot 対策ページが**検索語そのものを本文にエコーする**ことで、施設が掲載されていなくても「ラハイナ」が本文に現れる。
施設カードのコンテナ（`property-card` 等）で絞っても安定しなかった（対策ページにもカード用テンプレートが同梱される）。
→ **誤検知で KPI を水増しするより、未計測として正直に出す**方が運用上正しいと判断し、Google と同じ「未計測」に統一した
（対処後、3回連続で `1/6（確定分 1/4・未計測2件）` に安定することを実測）。

- 到達性そのものは 4/4 サイト OK（HTTP 200）。**未計測の原因は「サイトが落ちている」ではなく「クラウド実行環境の egress ポリシー」**であることが、
  この対比で確定した（本PCでは同じURLが取れる）。

## 何が根本的に変わったか
- これまで: 週次Routine（claude.ai クラウド）が計測できず **3週連続で露出0/6（＝未計測）**。解消には kim が
  https://claude.ai/code/environments で env_01W6MWRqRxXscNxrmoXY7h5n に許可ドメインを追加する必要があり、**kim の UI 操作待ちで止まっていた**。
- これから: `node tools/lahaina-exposure-check.mjs --date YYYY-MM-DD` をPC上で実行すればよい。
  **kim の設定操作は必須ではなくなった**（クラウドRoutineを直す方は、レポートのDrive保存・カレンダー通知まで含めて引き続き価値があるので、kim が設定した場合はそちらを使う）。

## 使い方
```bash
node tools/lahaina-exposure-check.mjs                    # 在庫照会日 = 今日+5日
node tools/lahaina-exposure-check.mjs --date 2026-10-20  # 日付指定
node tools/lahaina-exposure-check.mjs --json             # JSON出力（Drive/Sheet 連携用）
node --test tools/lahaina-exposure-check.test.mjs        # 判定ロジックのテスト（12件）
```
- 判定は4値に統一: `buyable` / `not_listed` / `delisted` / `unmeasurable`。
- ネット不通でも落ちず、全媒体 `unmeasurable` で exit 0（フェイルソフト）。
- **Google は常に未計測**として出す（機械取得不可のため 0 扱いしない）。

## 残っていること
1. **Instagram が未計測のまま**: 本ツールは6媒体（公式・じゃらん・楽天・Booking・Airbnb・Google）の定義に従っており Instagram は含まれない。
   Instagram は Meta Graph API のトークン待ち（kim の `.cmd` 1クリック・別TODO）。トークンが入れば `followers` / 最新投稿日を自動で取れる。
2. **Booking.com の確実な判定**: 現状は bot 遮断で `unmeasurable`。WebFetch 相当の取得を通すか、kim の目視1回で確定させるのが確実。
3. **クラウドRoutine側の根本解消**: kim が許可ドメインを追加すれば、Driveレポート＋カレンダー通知まで含む本来の週次自動化が復活する（本ツールはその代替ではなく、それまでの穴埋め＋PC側の常設手段）。
