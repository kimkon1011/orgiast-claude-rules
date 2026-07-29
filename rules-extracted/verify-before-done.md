# すべての変更後にテストしてから報告する 詳細

ONBOARDING.compressed.md §1.4.4 の詳細（絶対ルール）。

## 1.4.4 すべての変更後、テストして「実際に直っている」ことを確認してから報告する(絶対ルール)

鉄則: コードを書いた / DB row を触った / cron や env を変えた直後、「実際にユーザーが見る画面・経路で意図通り動くか」を Claude 側で確認するまで完了報告しない。

このルールを すべての変更で適用する。「修正しました、確認お願いします」「画面で見てもらえますか」を user に振ったら違反。

### 🚨 報告メッセージのテンプレ (これに従わなければ完了報告と見なさない)

```
- 実装: <変更内容 1 行>
- typecheck: PASS ✅
- Layer 1: <script 名> → <期待値> PASS ✅   ← DB row / Server Action / 設定変更 で必須
- Layer 2: <spec 名> → e2e N passed ✅       ← UI 変更 / 画面に出る変更 で必須
- deploy: <commit hash> Vercel Ready ✅
```

この 5 行のうち「typecheck と deploy だけで Layer 1 / Layer 2 が無い」場合は報告するな。 自分で気付かなければ「未完了 todo」として残し、 Layer 1/2 を通してから報告する。

「短い修正だから e2e 不要」「typecheck PASS で十分」 という Skip 判断を内部で行うことを禁ずる。 1 行の文言変更でも e2e spec を 1 個書く (visible 確認だけでも OK)。

### 頻発する失敗パターン (これらは全て違反、 過去事例あり)

| 失敗パターン | 過去事例 | 正しい対応 |
|---|---|---|
| 「typecheck pass + commit + push しました」 だけ で 報告 | 2026-06-08 picker bug / 2026-06-15 配信停止ボタン分離・テンプレ Application error・/manual force-static で 全 e2e なしで報告 → user に「テストした？」と指摘される | typecheck の後に 必ず Layer 1 + Layer 2 e2e を書いて pass まで通す |
| 「ハードリロードしてください」 を user に頼む | 2026-06-15 /manual 白画面 / テンプレ Application error | 自分で curl + Playwright で production を実描画 確認、 server-side で原因特定してから報告 |
| 「同じ操作を試してください」 を user に頼む | 2026-06-15 テンプレ Application error の log 仕込み deploy | Playwright spec で 同じ操作を機械的に再現、 server log で動いてること確認まで完結 |
| 「これは bug ではなくブラウザの cache です」と早合点 | 2026-06-15 /manual 白画面 (実際は force-static の dashboard layout conflict) | production HTML を curl で取得して 中身を読む。 cache でなく 何かを返してるのを目視確認 |
| 軽い UI 文言変更だから e2e 不要、と判断 | 2026-06-15 配信停止ボタン文言分離 | どんな小さな UI 変更でも visible テスト 1 行は必須 |
| GAS/Sheets 書き込み API の戻り値で「成功」判定 | 2026-06-15 C0021 schedule の row 1 ラベル復元: `Range.setValue` がエラー無しで返ったため OK と報告 → 実は merge cell の non-top-left への書き込みは Sheets API が silent ignore して値は空のまま | 書き込んだセルを read-back して期待値が入っているか assert する。 戻り値で判定しない |
| 「frontend は browser でしか動かないから user に確認してもらう」 と判断して報告 | 2026-06-17 ブース制作 Upload dialog: 7MB PDF で「読み込み中」5 分 hang → `readAsDataURL` に直して backend 検証だけ通して 「dialog を再オープンしてください」 と user に投げた → user 「テストした？」 「他のケースでも置きないように汎用的に」。 frontend ロジックの大部分は V8 で動くので Node で再現可能だった (実際 `String.fromCharCode.apply(null, 7MB)` は Node でも `Maximum call stack size exceeded` で crash する) | `test/*.test.js` を Node で実行して assert pass まで通す。 ロジックを pure 関数化、 既知 bug パターンは 「OLD must throw」 として残し、 修正後ロジックは roundtrip integrity を assert |

### 「テストする」とは具体的に何をするか

| 変更の種類 | 最小テスト要求 |
|---|---|
| UI 変更 (ボタン / プルダウン / フィルター / リスト) | Layer 1 (ロジック再現 assert) + Layer 2 (Playwright で production を実描画 assert) の 2 段 (下記詳細) |
| DB row 操作 (dedup / archive / migration / bulk update) | 操作後に 対象 row を service_role で再 select して状態 assert。さらに UI に出る項目なら Layer 2 も |
| Server Action / API route 修正 | curl or `gh workflow run` で 強制発火 → response JSON 内容 assert + 副作用 (DB / 外部) を再 select assert |
| パフォーマンス改善 | 修正対象ページの 再描画レスポンス時間を計測 (production curl の time / Playwright `page.waitForLoadState`) し、改善前後で差分提示 |
| 設定変更 (env / cron / GitHub Actions) | 反映後に対応する経路を 1 回叩いて期待値確認 |
| GAS / Sheets / Docs への書き込み(setValue / setFormula / insertSheet / copyTo / appendRow) | 書き込んだセル(or 出力 sheet)を read-back して「実値が期待通り入っているか」を verify。 関数の戻り値だけで成功判定しない |
| Frontend (HTML/JS、 GAS HtmlService dialog 含む) 変更 | Node で再現可能な部分 (ロジック / 文字列処理 / 既知 bug パターン) は必ず `test/*.test.js` を書いて `node test/xxx.test.js` で assert pass。 「browser でしか動かない」を理由に user 手動確認に丸投げしない。 W3C 標準 API (readAsDataURL/Blob/fetch 等) の native 実装は spec 信頼可だが、 ロジック層と「使い方を間違えていないか」 と 「既知バグパターン (例: `String.fromCharCode.apply(null, hugeArray)`)」 は Node で再現確認 |

### ダメな完了報告例(全部違反)

- 「実装して deploy しました。ブラウザで確認してみてください」
- 「dedup を走らせました。重複が消えたはずです」(再 probe してない)
- 「パフォーマンスを改善しました。8s → 4s になっているはずです」(実測してない)
- 「typecheck pass + commit + push しました」(=コードが書けただけ。動作確認は別物)
- 「次回 cron 発火で確認できます」(強制発火しろ)

### OK 報告の例

- 「実装 → deploy → Layer1 (script 再現) で名城大学 picker に creator 案件出る ✓ → Playwright で /inbox 開いて picker 選択 → 案件出ること DOM assert ✓ → 完了」
- 「dedup 実行: customers 70→1 統合確認 (probe-craft.ts で再 select) → クラフトフィックス 1 件のみ ✓ → 完了」

### Layer 1 — ロジック層 (`scripts/test-*.ts`、Node で再実行)

- server-side の DB query + range pagination + filter / order を 完全同一に Node で再現
- client-side の useMemo / filter / sort を 同じく Node で再現
- 代表ケースで期待値 assert(例: 「○○ customer 選択時に △△ deal が候補に含まれる」)
- NG なら user に渡す前に修正 → 再実行

### Layer 2 — ブラウザ層 (`@playwright/test`、 production を実描画 assert、全プロジェクト必須)

- `pnpm add -D @playwright/test` + `npx playwright install chromium` を初回 setup
- Auth 越え: Supabase なら `auth.admin.generateLink({type:'magiclink', email})` で test user のリンク発行 → playwright で navigate → storage state 保存。専用 test user(e.g. `test-bot@orgiast.jp`)を 1 つ作るのが最もクリーン
- コア導線をシナリオ化: navigate → 入力 → expect(locator).toContainText(...)
- NG なら user に渡す前に修正 → 再 push → 再 e2e

### プロジェクト立ち上げ時のテンプレに追加

- `e2e/auth.setup.ts`: test user の session を取得して `e2e/.auth/user.json` に保存
- `e2e/<feature>.spec.ts`: 主要シナリオ 1 本以上
- `playwright.config.ts`: `use: { storageState: 'e2e/.auth/user.json', baseURL: process.env.E2E_BASE_URL ?? '<prod-host>' }`
- `package.json` の `"verify-ui"` script で 「typecheck + Layer1 + Layer2」を一括実行

### やってはいけない

- Layer 1(DB level assert)だけ通して「テストしました」と報告する。React 描画/CSS hidden/Suspense fallback で落ちてるケースを拾えないので Layer 1 だけでは不十分。
- production curl で auth 越し HTML を取って「200 が返るから OK」とする。実描画と DOM は別物。

### 由来（past cases）

- 2026-06-08 aujust-sales-automation の案件選択プルダウンで「エクストリンクの 20周年映像 _前金 が出ない」事故 → Layer 1 だけで OK 報告した直後 user から「テストした?」確認 → 実 UI 未検証を認めて Playwright 提案 → user 「それは今後全ての Claude Code 開発でルール化して」
- 2026-06-12 aujust-sales-automation で staff fix / archive-stub / picker perf 改善などをまとめて push → user が確認 → 「名城大学が picker に出ない」発見 → 「実装したあとに、すべてテストして問題ないかチェックしてから報告するというのを全体のルールに適用してくれるかな。ONBOARDING にも反映して」と再強化要望 → §1.4.4 を「UI 限定」から「すべての変更で実テスト必須」に格上げ・absolute rule 化
- 2026-06-15 ブース制作アプリ C0021 schedule sheet 再構築で「rebuild 完了 2479 セル再評価」と報告 → 実際は row 1 ラベル・row 6 ヘッダー全部未復元 (merge cell の non-top-left に setValue したため Sheets API が silent ignore) → user「またルール違反」「どんなケースでも置きないように、ONBOARDING にも反映」 → §1.4.4.x で「GAS/Sheets 書き込みは read-back verify 必須」を absolute rule 化、 失敗パターン表に「書き込み API の戻り値で成功判定する」を追加。
- 2026-06-17 ブース制作アプリ Upload dialog で 7MB PDF が「読み込み中」5 分 hang → `reader.readAsDataURL` に修正 + backend 検証だけで「dialog を再オープンしてください」 と完了報告 → user「テストした？」「毎回するルールじゃなかったっけ？どうして実行されなかったか原因をしらべて。 他のケースでも置きないように汎用的な対策に」 → root cause: 「frontend は browser でしか動かない」と勝手判断して Node-side 検証を skip。 実際は frontend ロジックの大部分は V8 で動くので Node で再現可能 (`String.fromCharCode.apply(null, 7MB)` は Node でも crash することを確認)。 → §1.4.4.y で「Frontend 変更は Node test 必須」を absolute rule 化、 失敗パターン表に「frontend は browser でしか動かないと判断」を追加。 generic 対策として `test/<name>.test.js` パターン (OLD must throw + NEW roundtrip integrity) を全プロジェクト共通テンプレ化。

## 1.4.4.x GAS / Sheets / Docs 書き込みの read-back verify (絶対ルール)

GAS の `Range.setValue` / `setFormula` / `insertSheet` / `copyTo` / `appendRow` / Doc の `appendParagraph` などは エラー無しで silent ignore されるケース がある:

1. Merge cell の non-top-left への書き込み — Sheets API は merge 範囲の左上以外を read-only 扱いし、 戻り値は同じ Range だが値は変わらない
2. Protected range への書き込み — 編集権限が無い場合エラー無しで無視されるケースあり
3. Data validation (drop-down / range 限定) に違反する値 — 一部条件で reject
4. copyTo / insertSheet 後の formula 参照先が存在しないシート — `#REF!` / `#NAME?` がキャッシュされる

必ず: 書き込み後に 同じ場所を read-back して期待値が入っているか assert する。 関数の戻り値だけで「書けた」と判定しない:

```js
sheet.getRange('S1').setValue('開催日');
SpreadsheetApp.flush();
const actual = sheet.getRange('S1').getValue();
if (actual !== '開催日') {
  // merge top-left を探して書き直し:
  const merged = sheet.getRange('S1').getMergedRanges();
  if (merged.length > 0) merged[0].setValue('開催日');
}
```

または `getMergedRanges()` を先に呼んで top-left に書き込む。 read-back が用意できない場合は 完了報告するな(未完了 todo として残す)。

## 1.4.4.y Frontend (HTML/JS) 変更の Node テスト必須化 (絶対ルール)

frontend 変更 (GAS HtmlService dialog/sidebar、 Next.js client component、 任意の `*.html` 内 JS) を触ったら 「browser でしか動かない」を完了報告の言い訳にしない。

frontend ロジックの 大部分は V8 で動くため Node で再現可能。 例:
- `String.fromCharCode.apply(null, hugeArray)` は Node でも RangeError ("Maximum call stack size exceeded") を投げる
- `Buffer.toString('base64')` / `Buffer.from(b64, 'base64')` で `reader.readAsDataURL` の出力を完全模擬できる
- 文字列処理 (slicing, regex, JSON.parse) はそのまま走る

必須テンプレ (`test/<feature>.test.js`):

```js
// 1. OLD bug pattern: must throw on representative input (regression guard)
let oldThrew = false;
try { /* OLD impl with 7MB data */ } catch (e) { oldThrew = true; }
assert('OLD throws on 7MB', oldThrew);

// 2. NEW logic: roundtrip / shape / edge cases
const dataUrl = 'data:application/pdf;base64,' + sample.toString('base64'); // readAsDataURL 模擬
const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
assert('decoded equals source', Buffer.from(b64, 'base64').equals(sample));

// 3. Edge cases (empty input, no comma, multiple commas, etc.)
```

W3C 標準 API (readAsDataURL / Blob / fetch / URL / FormData 等) の native 挙動は spec 信頼可だが、 その出力を受けるロジック と 「使い方を間違えていないか」 と 「既知の bug パターン」 は 必ず Node test に落とす。

`node test/xxx.test.js` で assert pass しない frontend 変更は 「未完了 todo」 として残す。 user に「dialog を開き直してください」「ハードリロードしてください」 を完了報告の代わりにしない。
