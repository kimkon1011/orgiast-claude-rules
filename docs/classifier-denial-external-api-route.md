# 分類器拒否で外部 API が使えない件の実測（2026-09-20）

handoff-audit `0d6fab8839e46a95`（「permission 分類器で自動経路が止まった」）の調査・検証記録。
**既存の権限・スコープのまま**読み取り専用プローブで実測した。送信・権限変更は行っていない。

## 結論

現行構成では **「分類器拒否で外部 API が使えない」は再現しない**。
読み取り目的の外部 API 呼び出しは 4 経路すべて**拒否なしで成功**した。
実在するギャップは 1 つだけで、それは分類器ではなく **DWD（ドメイン全体の委任）のスコープ委任漏れ（GTM のみ）**。

## 実測 1: 外部 API 到達（すべて拒否なし・2026-09-20）

| 経路 | 実測結果 |
|---|---|
| `node -e "fetch('https://api.github.com/rate_limit')…"` | `EXTERNAL-API-OK 60 / remaining 52` |
| `curl -s https://api.github.com/rate_limit` | `HTTP 200` |
| `WebFetch https://www.googleapis.com/discovery/v1/apis` | 応答取得（`kind = discovery#directoryList`） |
| `node <abs>/tools/google-property-check.mjs --json` | 完走・exit 0（GA4 / Search Console 取得成功） |

補足: 実物の `~/.claude/settings.json` の `permissions.defaultMode` は **`auto`**。
`tools/allow-rules.json` の `defaultMode: bypassPermissions` は**配布テンプレート側の値**であり、この PC の実物は `auto`。
**`auto`（＝分類器が動くモード）でも上記の読み取り照会は止まらない。**

## 実測 2: 拒否されるのは「外部 API」ではなく「操作カテゴリ」

2026-09-04〜17 の transcript 集計（呼び出し 5,394 回 / 拒否 246 回）で理由が付いた拒否は
Credential Exploration / Materialization / Modify Shared Resources / Permission Grant /
Production Deploy / Merge Without Review の 6 カテゴリ。

→ 拒否は**ホスト名や API 呼び出しそのもの**に対してではなく、**操作の意味**に対して起きる。
したがって「外部 API が使えない」と一般化すると誤る。読み取り照会は通る。

## 実測 3: DWD の実在ギャップ = GTM スコープ未委任（唯一の恒久策候補）

`node tools/google-property-check.mjs --json`（読み取り専用）の結果:

| API | 結果 | 詳細 |
|---|---|---|
| GA4 (Analytics Admin v1beta) | **ok** | accounts **17** 件（東邦鋼業 `properties/278904354` を含む） |
| Search Console v3 | **ok** | sites **12** 件（`https://tetsuko.co.jp/` = siteOwner を含む） |
| Tag Manager v2 | **NG** | `errorKind=scope_not_delegated` / `errorDetail=unauthorized_client` |

GTM の失敗はトークン交換の時点で落ちている＝**Admin Console の DWD にスコープが未登録**。
要求スコープは `https://www.googleapis.com/auth/tagmanager.readonly`。
ツール側はこの状態を `scope_not_delegated` として正しく分類しており（`tools/google-property-check.test.mjs` 10/10 green）、
コード側の不具合ではない。

参考: 2026-09-10 の TETSUKO 誤判定（「Search Console に無い可能性が高い」）は、
上表のとおり **Search Console に実在**していた。直接照会は当時から可能で、原因は権限ではなく手順だった。

## 実測 4: 「未確認＋代替案」の強制は生きている

`~/.claude/settings.json` の Stop hook に `C:\Users\uers\orgiast-main\tools\stop-gate-runner.mjs` が配線済み。
**ツリー側のコピーではなく live 実物**を grep して確認した（`stop-gate-runner.mjs:16` で
`./external-state-claim-gate.mjs` を import、`:40` でゲート登録）。

→ 外部状態の否定断定（「無い」「痕跡がない」等。ヘッジ語付きも対象）で、
transcript に vendor への直接照会 `tool_use` が無ければ **block** される。
「未確認」と書いて user に検証を外注するのも `OUTSOURCED-VERIFY` で止まる。

## 未確認（断定しない）

- **分類器が deny する具体的な閾値・判定ロジックそのもの**は未確認。
  読み取り専用プローブでは再現しなかっただけで、「拒否されない」の証明ではない。
  今回言えるのは「**読み取り照会は現行構成で通る**」までである。
- **Drive MCP（`mcp__claude_ai_Google_Drive__*`）の挙動**は本ヘッドレス環境では未ロード＝未確認
  （「MCP が使えない」ではなく「本環境では未ロード」）。
- GTM スコープが未委任である理由（意図的か漏れか）は未確認。

## 恒久策の提案（kim の手作業 1 回・DM はしない）

**GA4 / Search Console は追加作業ゼロで使える。手作業が発生するのは GTM を読む場合だけ。**

GTM を DWD で読めるようにする手順:

1. `admin.google.com` → セキュリティ → アクセス制御 → API コントロール → ドメイン全体の委任
2. サービスアカウント `aujust-sheets-reader@aujust-sales-automation.iam.gserviceaccount.com`
   の client_id を開く
3. スコープに `https://www.googleapis.com/auth/tagmanager.readonly` を追加して保存
4. 検証: `node tools/google-property-check.mjs --json` の `gtm.ok` が `true` になる

※ これは**許可を広げる変更**なので Claude 側では実行しない（§1.14 / 分類器 [Permission Grant] の対象）。
※ GTM を読む予定が無ければ **この作業は不要**（他 2 API は既に委任済み）。

## 再現手順

```
node tools/google-property-check.mjs --json     # 機械可読
node tools/google-property-check.mjs            # 人間向けレポート
```

読み取り専用。Drive・GA4・Search Console への書き込みは一切行わない。

## 残ったこと

- GTM スコープ追加は**未実施**（kim の 1 アクション待ち。GTM が不要なら実施不要）。
- 分類器の deny カテゴリを再現できる入力の特定は未着手。
