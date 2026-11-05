# 求人の定期更新リマインダー

engage の公開採用ページを読み取り、更新間隔を過ぎた求人から最も古い1件だけを選びます。媒体へのログインや画面操作は行いません。変更案を Discord DM で辻有香さんへ送り、公開ページの最終更新日が変わったかを翌日以降の実行で確認します。

## 動作

- 毎日10:15に公開中の求人一覧と各求人の「最終更新日」を確認します。
- 既定では最終更新から14日以上経過した求人のうち、最も古い1件を依頼します。
- 同じ求人は依頼後3日間待ちます。更新されなければ最大2回再依頼し、それでも変化がなければ `要確認` にします。
- 個別ページを取得できない求人は `取得不可` として記録・表示し、ほかの求人の処理は続けます。
- `--dry-run` はDMを送らず本文だけを表示します。`--list` は全求人を表で表示します。

```powershell
node refresh.mjs --list
node refresh.mjs --dry-run
node refresh.mjs --interval-days 14
node --test test/
```

## state.json

実行時に同じフォルダへ自動作成されます。求人IDごとに次を保存します。

- `lastUpdated`: 公開ページで確認した最終更新日
- `lastRequestedAt`: 最後にDMを送った日時
- `requestedText`: 依頼した貼り付け文
- `retryCount`: 再依頼回数（0～2）
- `needsReview`: 2回再依頼しても更新されなかった場合は `true`
- `statusNote`: 要確認になった理由

送信に失敗した場合は依頼履歴を更新しないため、次回に再試行できます。`--dry-run` でも state.json の依頼履歴は変更しません。

## タスクを止める

```powershell
schtasks /Delete /TN "orgiast-job-refresh" /F
```

再登録する場合:

```powershell
schtasks /Create /TN "orgiast-job-refresh" /SC DAILY /ST 10:15 /TR "node C:\Users\kimko\.claude\nightly-repo\tools\recruit\job-refresh\refresh.mjs" /F
```

