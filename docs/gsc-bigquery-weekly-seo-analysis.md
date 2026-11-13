# GSC一括エクスポートでSEO週次分析を自動化する完全設定ガイド（X-0003）

## 1. 概要

Google Search Console（GSC）の Bulk Data Export（一括エクスポート）を使い、検索パフォーマンスデータをBigQueryへ日次保存し、週次SEO分析を自動化する。

構成は次のとおり。

```text
Google Search Console
  → BigQuery（全件の日次エクスポート・長期保存）
  → BigQuery Scheduled Query（週次集計）
  → Google Sheets（Connected Sheets または GAS）
```

Search Console APIの行数上限を前提にした分割取得が不要になり、エクスポート開始後のデータを保持しながら、SQLでURL・検索クエリ・期間を横断した分析ができる。匿名化されたクエリはGoogleの仕様によりエクスポート対象外である。

## 2. GCP側の準備

### 2.1 GCPプロジェクトを選択または作成する

1. [Google Cloud Console](https://console.cloud.google.com/) を開く。
2. 上部のプロジェクト選択欄から既存プロジェクトを選ぶ。専用に分離する場合は「新しいプロジェクト」を選び、プロジェクト名と請求先を設定する。
3. 「IAMと管理」→「設定」で、**プロジェクトID**を確認する。プロジェクト名やプロジェクト番号ではない点に注意する。
4. 後工程で使うため、プロジェクトIDをコピーしておく。

### 2.2 APIを有効化する

「APIとサービス」→「ライブラリ」で、次のAPIを検索して有効化する。

- BigQuery API
- BigQuery Storage API

定期クエリはBigQuery Data Transfer Serviceを使用する。Scheduled Queryの作成時に求められた場合は、BigQuery Data Transfer APIも有効化する。

### 2.3 GSCエクスポート用サービスアカウントへ権限を付与する

1. 「IAMと管理」→「IAM」を開く。
2. 「アクセスを許可」をクリックする。
3. 新しいプリンシパルへ次を入力する。

   ```text
   search-console-data-export@system.gserviceaccount.com
   ```

4. 次の2ロールを付与する。
   - BigQuery Job User（`roles/bigquery.jobUser`）
   - BigQuery Data Editor（`roles/bigquery.dataEditor`）
5. 保存する。

これはGoogleが管理するGSC一括エクスポート専用サービスアカウントである。独自のサービスアカウントへ読み替えない。

## 3. GSC側の設定

1. [Google Search Console](https://search.google.com/search-console/) で対象プロパティを選択する。
2. 「設定」→「Bulk data export（一括データ エクスポート）」を開く。
3. 「Cloud project ID」へ、前節でコピーしたGCPの**プロジェクトID**を入力する。
4. データセット名を入力する。既定値は `searchconsole`。同一GCPプロジェクトへ複数のGSCプロパティを出力する場合は、プロパティごとに異なる名前を使う。
5. データセットのロケーションを選ぶ。本ガイドでは `US` を推奨する。**作成後にロケーションは変更できず、定期クエリの出力先も同じロケーションに置く必要がある。** 組織のデータ所在地要件がある場合は、それを優先する。
6. 接続テストを実行し、成功を確認して設定を保存する。
7. Search Consoleからの完了通知と、BigQuery側のテーブル作成を確認する。

初回データが見えるまで24〜48時間程度を見込む。設定前の過去データは遡及取得されないため、早めに設定する。

作成される主なテーブルは次の3つ。

- `searchdata_site_impression`: プロパティ単位の集計データ
- `searchdata_url_impression`: URL単位の集計データ。本ガイドの分析元
- `ExportLog`: 日次エクスポートの成否と状態

## 4. BigQuery SQLクエリ（3種の分析）

完全版は [`seo/gsc-bq-weekly-analysis.sql`](../seo/gsc-bq-weekly-analysis.sql) にある。実行前に `your-project-id` をGCPプロジェクトIDへ、必要なら `searchconsole` を実際のデータセット名へ置換する。3クエリは個別に実行する。

期間は「昨日までの7日間」と「その直前の7日間」。GSCデータの到着が遅れている場合は `CURRENT_DATE()` の基準をさらに1〜2日ずらす。

### 4.1 前週比クリック減ページ

URL×クエリ単位で今週と前週を `FULL OUTER JOIN` し、今週から消えた組み合わせも含めてクリック減少を検出する。

```sql
WITH current_week AS (
  SELECT url, query,
    SUM(clicks) AS clicks_curr,
    SUM(impressions) AS impressions_curr,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_curr,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_curr
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND query != ''
  GROUP BY url, query
), prior_week AS (
  SELECT url, query,
    SUM(clicks) AS clicks_prev,
    SUM(impressions) AS impressions_prev
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
    AND query != ''
  GROUP BY url, query
)
SELECT
  COALESCE(c.url, p.url) AS url,
  COALESCE(c.query, p.query) AS query,
  COALESCE(c.clicks_curr, 0) AS clicks_curr,
  COALESCE(p.clicks_prev, 0) AS clicks_prev,
  COALESCE(c.clicks_curr, 0) - COALESCE(p.clicks_prev, 0) AS clicks_diff,
  COALESCE(c.impressions_curr, 0) AS impressions_curr,
  COALESCE(p.impressions_prev, 0) AS impressions_prev,
  ROUND(COALESCE(c.ctr_curr, 0) * 100, 2) AS ctr_curr_pct,
  ROUND(c.avg_position_curr, 2) AS avg_position_curr
FROM current_week c
FULL OUTER JOIN prior_week p ON c.url = p.url AND c.query = p.query
WHERE COALESCE(c.clicks_curr, 0) - COALESCE(p.clicks_prev, 0) <= -1
ORDER BY clicks_diff ASC, impressions_curr DESC;
```

### 4.2 表示増なのにCTR低下キーワード

表示回数が増えている一方でCTRが下がった検索クエリを抽出する。タイトル・ディスクリプション・検索意図との不一致を確認する候補になる。

```sql
WITH current_week AS (
  SELECT query,
    SUM(clicks) AS clicks_curr,
    SUM(impressions) AS impressions_curr,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_curr,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_curr
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND query != ''
  GROUP BY query
), prior_week AS (
  SELECT query,
    SUM(clicks) AS clicks_prev,
    SUM(impressions) AS impressions_prev,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_prev
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
    AND query != ''
  GROUP BY query
)
SELECT c.query, c.impressions_curr, p.impressions_prev,
  ROUND(c.ctr_curr * 100, 2) AS ctr_curr_pct,
  ROUND(p.ctr_prev * 100, 2) AS ctr_prev_pct,
  c.clicks_curr,
  ROUND(c.avg_position_curr, 2) AS avg_position_curr
FROM current_week c
INNER JOIN prior_week p USING (query)
WHERE c.impressions_curr > 100
  AND c.ctr_curr < p.ctr_prev
  AND c.impressions_curr > p.impressions_prev
ORDER BY c.impressions_curr - p.impressions_prev DESC;
```

### 4.3 順位上昇なのに流入が伸びないページ

平均掲載順位が上昇（数値は低下）したのに、クリックが前週比+10以内に留まるURLを抽出する。スニペット改善や、クエリ構成の確認候補になる。

```sql
WITH current_week AS (
  SELECT url,
    SUM(clicks) AS clicks_curr,
    SUM(impressions) AS impressions_curr,
    SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr_curr,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_curr
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
    AND query != ''
  GROUP BY url
), prior_week AS (
  SELECT url,
    SUM(clicks) AS clicks_prev,
    SUM(impressions) AS impressions_prev,
    SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1.0 AS avg_position_prev
  FROM `your-project-id.searchconsole.searchdata_url_impression`
  WHERE data_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
                      AND DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY)
    AND query != ''
  GROUP BY url
)
SELECT c.url,
  ROUND(c.avg_position_curr, 2) AS avg_position_curr,
  ROUND(p.avg_position_prev, 2) AS avg_position_prev,
  ROUND(c.avg_position_curr - p.avg_position_prev, 2) AS position_diff,
  c.clicks_curr, p.clicks_prev, c.impressions_curr,
  ROUND(c.ctr_curr * 100, 2) AS ctr_curr_pct
FROM current_week c
INNER JOIN prior_week p USING (url)
WHERE c.avg_position_curr < p.avg_position_prev
  AND c.clicks_curr <= p.clicks_prev + 10
  AND c.impressions_curr > 50
ORDER BY position_diff ASC, c.impressions_curr DESC;
```

## 5. BigQueryからスプレッドシートへ連携する

### 5.1 定期クエリを作る

1. BigQueryで各クエリを開き、手動実行して結果を確認する。
2. 結果保存用データセット（例: `your_dataset`）を、GSCデータセットと**同じロケーション**に作る。
3. 「スケジュール」からScheduled Queryを作成する。
4. 毎週月曜9:00 JSTを指定する。Googleは正時実行で重複起動の可能性を案内しているため、書き込みの安全性を優先する場合は**毎週月曜9:03 JST**を推奨する。
5. 3クエリを別々に登録し、保存先を次のようにする。
   - `weekly_click_declines`
   - `weekly_ctr_declines`
   - `weekly_position_opportunities`
6. 毎週最新結果へ置き換えるなら書き込み設定を `WRITE_TRUNCATE` にする。履歴を残すなら実行日列を加え、日付パーティションへ `WRITE_APPEND` する。

### 5.2 Connected Sheetsを使う

Google Sheetsで「データ」→「データコネクタ」→「BigQueryに接続」を選び、プロジェクト、データセット、結果テーブルを指定する。抽出の更新スケジュールを設定すれば、SQLを書かずにシートやピボットテーブルへ反映できる。利用可否はGoogle Workspaceのエディションと管理設定に依存する。

Connected Sheetsを使えない場合は、次節のGASでBigQuery結果を取得する。

## 6. GASスプレッドシート連携（詳細）

### 6.1 事前準備

1. 出力先Google Sheetsを作成する。
2. 「拡張機能」→「Apps Script」を開く。
3. Apps Scriptの「サービス」から **BigQuery API** を追加する。
4. スクリプトの実行ユーザーに、対象テーブルの閲覧権限とBigQueryジョブ実行権限を付与する。

このリポジトリのDWD経路では `script.projects` が委任されていないため、GASプロジェクトの自動作成はできない。上記はkimがApps Script画面で一度設定・実行する手順である。

### 6.2 サンプルコード

`PROJECT_ID` と各テーブル名を実環境へ置換する。BigQuery APIのページングと非同期完了待ちに対応している。

```javascript
const PROJECT_ID = 'your-project-id';
const DATASET_ID = 'your_dataset';

const REPORTS = [
  { sheet: 'クリック減ページ', table: 'weekly_click_declines' },
  { sheet: 'CTR低下KW', table: 'weekly_ctr_declines' },
  { sheet: '順位上昇_clicks減', table: 'weekly_position_opportunities' },
];

function refreshWeeklySeoReport() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  REPORTS.forEach(({ sheet, table }) => {
    const rows = queryBigQuery_(
      `SELECT * FROM \`${PROJECT_ID}.${DATASET_ID}.${table}\``
    );
    writeRows_(spreadsheet, sheet, rows);
  });

  updateSummary_(spreadsheet);
}

function queryBigQuery_(query) {
  let result = BigQuery.Jobs.query(
    { query, useLegacySql: false, timeoutMs: 10000 },
    PROJECT_ID
  );
  const jobId = result.jobReference.jobId;
  const location = result.jobReference.location;

  while (!result.jobComplete) {
    Utilities.sleep(1000);
    result = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId, { location });
  }

  const headers = result.schema.fields.map(field => field.name);
  const output = [headers];
  let page = result;

  while (true) {
    (page.rows || []).forEach(row => output.push(row.f.map(cell => cell.v)));
    if (!page.pageToken) break;
    page = BigQuery.Jobs.getQueryResults(PROJECT_ID, jobId, {
      location,
      pageToken: page.pageToken,
    });
  }
  return output;
}

function writeRows_(spreadsheet, sheetName, rows) {
  const sheet = spreadsheet.getSheetByName(sheetName)
    || spreadsheet.insertSheet(sheetName);
  sheet.clearContents();
  if (rows.length > 0 && rows[0].length > 0) {
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sheet.setFrozenRows(1);
  }
}

function updateSummary_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName('サマリー')
    || spreadsheet.insertSheet('サマリー', 0);
  const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  const values = [
    ['項目', '値'],
    ['最終更新（JST）', now],
    ['クリック減ページ件数', countDataRows_(spreadsheet, 'クリック減ページ')],
    ['CTR低下KW件数', countDataRows_(spreadsheet, 'CTR低下KW')],
    ['順位上昇_clicks減件数', countDataRows_(spreadsheet, '順位上昇_clicks減')],
  ];
  sheet.clearContents();
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  sheet.setFrozenRows(1);
}

function countDataRows_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  return sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0;
}
```

GASの時間主導トリガーは、BigQueryの定期クエリが完了した後（例: 毎週月曜10:00〜11:00 JST）に `refreshWeeklySeoReport` を実行するよう設定する。

推奨シート構成:

- `サマリー`: 最終更新日時と各改善候補数
- `クリック減ページ`: クエリ1の結果
- `CTR低下KW`: クエリ2の結果
- `順位上昇_clicks減`: クエリ3の結果

## 7. 展示会ブース・イベントキーワード監視

監視対象例:

- `展示会 ブース 制作`
- `イベント 出展 東京`
- `海外 展示会 出展 サポート`
- `展示会 ブース デザイン`
- `展示会 施工会社`

集計元の `WHERE` 句へ次を追加する。

```sql
AND EXISTS (
  SELECT 1
  FROM UNNEST([
    '展示会 ブース 制作',
    'イベント 出展 東京',
    '海外 展示会 出展 サポート',
    '展示会 ブース デザイン',
    '展示会 施工会社'
  ]) AS keyword
  WHERE STRPOS(LOWER(query), LOWER(keyword)) > 0
)
```

キーワードごとに週次の表示回数、クリック、CTR、平均掲載順位を保存し、前週比と4週移動平均をシートへ表示する。検索需要や提供サービスの変化を反映するため、キーワードリストは四半期ごとに見直す。表記揺れや語順違いもあるため、完全一致だけでなく部分一致を使い、広すぎる語は除外条件も追加する。

## 8. 費用と注意点

- BigQueryの無料利用枠は、原則として月10GiBのアクティブストレージと月1TiBのオンデマンドクエリ処理を含む。料金・無料枠は変更される可能性があるため、運用開始時に[BigQuery料金](https://cloud.google.com/bigquery/pricing)を確認する。
- 小〜中規模サイトの週次集計は無料枠に収まりやすいが、保証はされない。クエリ実行前の処理量表示とCloud Billing予算アラートを使う。
- `data_date` を必ず絞り、全期間のフルスキャンを避ける。
- 保存期間を限定する場合は、データセットまたはパーティションの有効期限を設定して古いデータを自動削除する。ただしGSCから過去データを再取得できないため、削除前に保持要件を確認する。
- GSC一括エクスポートは設定前のデータを遡及取得できない。
- 匿名化クエリはエクスポートされないため、画面上の総数とクエリ別集計が一致しない場合がある。
- BigQueryのロケーションは後から変更できない。元データ、Scheduled Query、出力先を同じロケーションにそろえる。
- `ExportLog` を週次で確認し、エクスポート失敗やデータ欠損を検知する。

## 9. 参考リンク

- [Search Console: 一括データ エクスポートについて](https://support.google.com/webmasters/answer/12918484)
- [Search Console: 新しい一括データ エクスポートを開始する](https://support.google.com/webmasters/answer/12917675)
- [Search Console: BigQueryテーブルのガイドとリファレンス](https://support.google.com/webmasters/answer/12917991)
- [BigQuery: 定期クエリをスケジュールする](https://cloud.google.com/bigquery/docs/scheduling-queries)
- [BigQuery料金](https://cloud.google.com/bigquery/pricing)
