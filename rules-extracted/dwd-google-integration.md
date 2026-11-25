# DWD（Domain-Wide Delegation）による Google API 連携詳細

ONBOARDING.compressed.md §1.1.5 / §1.11 / §1.11.1 の詳細。

## 1.1.5 SA で Google Drive 書き込み = DWD impersonate が必須（2026-06-29 追加）

Google サービスアカウントは Drive 容量 0 GB 固定 で、GCP API では変更不可。`drive.files.create` を呼ぶたびに `The user's Drive storage quota has been exceeded` エラーになる。次の代替策はすべて失敗するので試さない：

| 試したけど失敗するパターン | なぜダメ |
|---|---|
| `parents: [kim_folder_id]` を指定して kim's drive 内に書く | ファイル owner は SA のまま → SA quota 消費 |
| 作成直後 `permissions.create` で `transferOwnership: true` | create が先に quota fail、transfer に到達せず |
| `supportsAllDrives: true` だけ追加 | Shared Drive 不在なら無効 |
| SA に Workspace ライセンス付与 | GCP API では不可（有料 + Admin 操作） |

唯一の自動化経路 = DWD（Domain-Wide Delegation）：
- SA が Workspace ユーザー（kim@orgiast.jp）を impersonate
- ファイル owner = kim、kim's Drive 15GB 容量を使用
- セットアップは Workspace Admin Console で 1 回のみ

### Drive 書き込みするプロジェクト立上げの確定シーケンス

```bash
# 1. SA 既存確認（再作成しない）
gcloud iam service-accounts list --project=<PROJECT>

# 2. SA key 発行（IAM API enable できなければ GCP Console から）
gcloud iam service-accounts keys create key.json \
  --iam-account=<SA_EMAIL> --project=<PROJECT>

# 3. base64 化して Vercel env に登録
B64=$(base64 -w0 key.json)
echo "$B64" | vercel env add GOOGLE_SERVICE_ACCOUNT_KEY_B64 production

# 4. DWD 設定（Workspace Admin、1 回のみ user 操作）
#    https://admin.google.com/ac/owl/domainwidedelegation
#    Client ID: key.json の client_id（数字 21 桁）
#    Scopes: https://www.googleapis.com/auth/drive,
#            https://www.googleapis.com/auth/spreadsheets

# 5. impersonate 用 env
echo "kim@orgiast.jp" | vercel env add GOOGLE_IMPERSONATE_EMAIL production
```

### コード側の必須対応

```typescript
// lib/google/auth.ts — subject 対応 + 個別キャッシュ
export function getGoogleAuthClient(subject?: string): JWT | null {
  const json = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64!, 'base64').toString('utf-8'));
  return new google.auth.JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: [
      'https://www.googleapis.com/auth/drive',          // drive.file ではなく full drive
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    ...(subject ? { subject } : {}),
  });
}

// 使用側 — Drive 書き込みする場面では必ず subject を渡す
const auth = getGoogleAuthClient(process.env.GOOGLE_IMPERSONATE_EMAIL);
```

### 罠リスト

- ❌ scope を `drive.file` にする → DWD では権限不足、`drive` フル必須
- ❌ `cachedClient` で subject 違いを使い回す → 別 user impersonate が前回 user で動く事故。subject ごとに Map キャッシュ
- ❌ Workspace Admin 操作を「過剰な依頼」と勘違いして避ける → DWD は Workspace Admin にしかできない、本当の例外
- ❌ subject 付き JWT に DWD 未許可の scope を含める（2026-06-29 追加）
  - DWD authorization は 要求された全 scope が許可リストに含まれていることを要求する厳格マッチ
  - `calendar.events.readonly` 等が DWD 未許可なのに JWT scope に含まれてた → `unauthorized_client: ... not authorized for any of the scopes requested` で全 API call が即失敗
  - 対策: `getGoogleAuthClient(subject)` で subject あり時は DWD 許可 scope のみ、なし時は通常 SA 全 scope を使い分ける
    ```typescript
    const scopes = subject
      ? ['drive', 'spreadsheets']  // DWD 許可分のみ
      : ['drive', 'spreadsheets', 'calendar.events.readonly'];  // SA 自身は全 scope OK
    ```

### 過去事例（2026-06-29）

EOラーニング企画アプリで「📄 講師用リストを生成」機能の Sheet 作成に 6 回 quota エラーで試行錯誤。最終的に DWD でしか自動化できないと判明。user 「今後一発でできるように覚えておいてください」と要望。
詳細は memory [[feedback-sa-drive-dwd-pattern]] 参照。

## 1.11 Google API は DWD で OAuth Web Client を完全回避

Workspace 管理者(kim さん)がいる場合、per-user OAuth(Web Client 作成 + consent screen + 個別連携クリック)は すべて不要。代わりに:

1. 既存サービスアカウントの `client_id`(数字19桁)を取得(SA JSON に書いてある)
2. 直リンク https://admin.google.com/ac/owl/domainwidedelegation で「新しく追加」
3. Client ID + 必要 scope をカンマ区切りで貼って承認
4. コード側で `google.auth.JWT({ ..., subject: <impersonate_user> })` で完了

スコープ例:
- Gmail: `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/gmail.send`
- Calendar: `https://www.googleapis.com/auth/calendar`
- Drive: `https://www.googleapis.com/auth/drive`

これで OAuth Web Client 作成 + consent screen 設定の 15 分作業がゼロに。 Gmail/Drive/Calendar 連携を要するプロジェクトでは必ず DWD を第一選択にする。アプリのエンドユーザーログインも、次の 1.11.1 のマジックリンク方式でコンソール依存を回避できる(以前は「回避不能」としていたが、DWD 送信 + `admin.generateLink` で自前実装できると実証済み・2026-07-08)。

## 1.11.1 アプリのログインは「自前マジックリンク」でコンソール依存を切る

Supabase Auth の Google ログインを使うと、OAuth 同意画面(GCP Console)の設定に運用が縛られる。特に User type = Internal だと `@自ドメイン` 以外(個人 Gmail の社員・業務委託・アシスタント)が `403 org_internal` で弾かれ、Internal↔External の切替や公開(publish)は API 経路が存在せずコンソール専用。「これまで入れていた人が急に入れない」の典型原因。

回避策 = メールのマジックリンクを自前で発行・送信する(Supabase の SMTP 設定も外部メール SaaS も不要):

1. 発行: `service_role` クライアントで `auth.admin.generateLink({ type: "magiclink", email })` → `data.properties.hashed_token` を得る(未ログインの人向けに直前で `admin.createUser({ email, email_confirm: true })` を idempotent に呼ぶ)。
2. 送信: そのトークンを埋めた token_hash 経路の callback URL を、既存の Gmail DWD(1.11 の SA impersonate = seisaku-team 等)でメール送信。
   - リンク形: `${APP_URL}/api/auth/callback?token_hash=<hashed>&type=magiclink&next=/dashboard`
   - ※ Supabase の `action_link` をそのまま踏ませると token が URL fragment(`#access_token=`)で返りサーバー側 callback で処理できない。必ず `token_hash` クエリを自前で組む。
3. 検証: callback 側で `supabase.auth.verifyOtp({ token_hash, type })` → アプリ独自の許可リスト(自ドメイン / staff テーブル / Google Group メンバー等)でゲート。同意画面は一切通らない。

設計判断: アプリ側に許可リスト(サーバーサイド)があれば、Google ログインを残す必要すらない。メンバーが個人メール主体・人数が多い・コンソール権限が super admin(kim)に集中しているプロジェクトでは、最初からマジックリンクを主導線にすると運用が固い。`@自ドメイン` の人向けに Google ボタンを併置するのは任意(Internal のままでも自ドメインは通る)。

アンチパターン: 「個人 Gmail を Test users に個別追加」で凌ぐと、メンバー増減のたびにコンソール作業が再発する。許可リスト + マジックリンクなら DB/管理画面の操作だけで完結する。

参考実装(aujust-sales-automation): `src/lib/mailer.ts`(DWD 送信) / `src/app/actions/auth-magic-link.ts`(発行) / `src/lib/auth-allowlist.ts`(ゲート) / `src/app/api/auth/callback/route.ts`(検証)。
