# 再発監査: Gmail 差出アカウントの切替可否（handoff-audit:067e73209ea31bad）

監査日: 2026-10-23 / 対象 handoff: 2026-10-21 session `ebda188f`（212coffee ケータリング PDF 送信）

## 対象となった handoff

Claude が「212.coffee.212@gmail.com からは送れない」として kim に A/B（A=Claude が seisaku-team 差出で送る／B=kim が 212 差出で送る）を選ばせた件。
初期ターン（02:47〜02:48）では理由を「**OAuth 再認証が必要**」と述べ、02:54 のターンで DWD 送信に自己訂正している。

## 実測（2026-10-23・この PC = DESKTOP-63MQR3L）

### 1. OAuth 同意手渡しスキャナ（読み取り専用）

```
node tools/handoff-audit-oauth-consent-scan.mjs --selftest   → 5/5 pass（陽性2・陰性3）
node tools/handoff-audit-oauth-consent-scan.mjs --since 2026-10-01
  → ledger 1202 行 / transcript 181 ファイル 92,156 turn、ヒット 1 件
```

ヒット 1 件は `2026-09-08`（窓外）かつ誤検知（212 バーチャルオフィスの Web ページ文言に GA4 語と同意語が共起）。
**窓内（2026-10-01〜10-23）の Google プロパティ OAuth 手渡しは 0 件。**

**限界（重要）**: このスキャナの語彙は GA4 / Search Console / GTM のみ。`detect()` の `googleProp` に Gmail は無いため、
**Gmail 差出アカウントの手渡しは原理的に検出しない**。本件の再発有無をこのスキャナの 0 件で語ってはいけない。

### 2. DWD で sendAs を直接照会（これが本件の一次証拠）

SA 鍵 `~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json` +
`https://www.googleapis.com/auth/gmail.settings.basic`（DWD 委任済み・追加作業ゼロ）で
`users.settings.sendAs.list` を照会 → 3 ユーザーとも **HTTP 200**。

| 代理ユーザー | sendAs 件数 | うち gmail.com の差出 |
|---|---|---|
| kim@orgiast.jp | 8 | kimkongyong@ / nacci0713@ / airb.osaka@ |
| seisaku-team@orgiast.jp | 70 | miho.furukawa0430@ / kim.sec4@ |
| nishi@orgiast.jp | 8 | （なし） |

**`212.coffee.212@gmail.com` はどの Workspace ユーザーの sendAs にも存在しない。**

### 3. Google プロパティ（参考・同じ DWD 経路）

- GA4: ok（accounts 17）
- Search Console: ok（sites 12）
- GTM: `scope_not_delegated`（`unauthorized_client`）＝2026-09-20 と同一。読むなら Admin Console の
  ドメイン全体の委任に `tagmanager.readonly` を追加する kim の 1 アクションが要る（本件の判定には不要）。

## 判定

1. **この handoff は正当。再発ではない。** `212.coffee.212@gmail.com` は orgiast.jp の Workspace ユーザーではなく、
   どのユーザーの sendAs にも未登録 → DWD でも claude.ai コネクタでも差出にできない。Claude 側で差出を選べるのは
   **登録済み sendAs の中だけ**（例: seisaku-team@ の 70 件）。
2. **ただし同セッション初期ターンの理由付けは誤り**だった。「差出を変えるには OAuth 再認証が必要」は一般論で、
   DWD は OAuth 同意を必要としない（02:54 に本人が訂正済み）。この型＝「資格情報の一般論で手渡す」は
   oauth-consent スキャナの対象外なので、**手渡す前に `sendAs.list` を実測する**のが正しい型。
3. 運用上の帰結: 「212 ブランドで送りたい」案件は、**212 を sendAs に登録する（kim の 1 アクション・確認メール要）**
   か、seisaku-team 差出で送るかの二択。Claude からは前者を代行できない（sendAs 作成自体は
   `gmail.settings.basic` で API 可能だが、確認コードの受信が必要）。

## この監査で直した恒久バグ

`tools/google-property-check.mjs` / `gmail-draft.mjs` / `gdoc-create.mjs` / `gdoc-update.mjs` の既定 SA 鍵パスが
`C:/Users/uers/...`（ディレクトリ名の打ち間違い）で、**鍵が実在する PC でも `SA key not found` → exit 2** になっていた。
`tools/lib/drive-auth.mjs` の `defaultDriveKeyPath()`（homedir 基準）に統一し、再発防止テストを追加。
この修正前は、本監査の DWD 経路が「鍵なし」に見えて『未確認』で止まる状態だった。
