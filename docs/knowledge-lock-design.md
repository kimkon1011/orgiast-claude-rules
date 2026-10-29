# knowledge-lock 設計書: Claude 蓄積ノウハウの持ち出し防止・引き継ぎ書の鍵付き化・退職者監視

- 依頼: kim（2026-10-28）。設計: Opus 監督（2026-10-29 夜間）。実装: Codex。
- 関連リポ: `orgiast-claude-rules`（クライアント・台帳・監視）、`orgiast-keyserve`（Vercel・サーバ側の鍵と承認）

## 1. 目的と用語

| 用語 | 意味 |
|---|---|
| 契約アカウント | オージャストが費用を払っている Claude アカウント。台帳 `tools/claude-account-ledger.json` に `status: active` で載っている email、または `contractedOrgUuids` の組織に属するアカウント |
| 契約外アカウント | 上記以外（個人 Gmail の Claude、退職者のアカウントなど） |
| 封印ファイル | `*.lock`。AES-256-GCM で暗号化した引き継ぎ書。単体では読めない |
| マスター鍵 | RSA-OAEP-3072 の鍵ペア。秘密鍵は Vercel の Sensitive 環境変数 `KNOWLEDGE_LOCK_PRIVATE_KEY` にだけ置く（読み戻し不可）。公開鍵はリポ `tools/knowledge-lock-pubkey.pem` |
| 承認 | 契約外アカウントで開くときに要る kim 本人の操作。kim のスマホのパスキー（WebAuthn・生体認証必須） |

## 2. 脅威モデル

| # | 脅威 | 対策 | 残る穴 |
|---|---|---|---|
| T1 | 契約外アカウントの Claude が、同じ PC の `~/.claude` の memory・会話ログ・next-session.md を Read/Grep/Bash で読む | PreToolUse フック `knowledge-guard` が、サーバ署名済みのアカウント判定を見て保護パスへのアクセスを拒否する | フックは `settings.json` にあるため、PC の人間がフックを外せば効かない（→ T5 の監視で検知） |
| T2 | 引き継ぎ書ファイルを別 PC・別アカウントへ持ち出して AI に読ませる | 封印ファイルは AES-256-GCM。データ鍵は RSA 公開鍵で包む。開封はサーバ（keyserve）がアカウントを検証してから行う | 一度開いた平文を人が手で写すことは防げない |
| T3 | `~/.claude.json` の oauthAccount を書き換えて契約アカウントになりすます | 判定はサーバ側で行う。サーバは Claude の OAuth トークンで Anthropic の `/api/oauth/profile` を照会し、email と組織 UUID を取得する。判定結果はサーバの RSA 秘密鍵で署名し、クライアントは公開鍵で検証する | `/api/oauth/profile` は非公開 API。仕様が変わったら判定は失敗し、安全側（契約外扱い）に倒れる |
| T4 | 契約外 AI が kim の承認を代行する | 承認は WebAuthn（kim のスマホの生体認証つきパスキー）。秘密鍵は kim のスマホから出ない。Claude が持つ Discord・Gmail・keyserve・DWD のどれでも代行できない | パスキー登録の瞬間だけは、登録リンクを Claude が横取りして仮想認証器で登録する余地がある → 登録は1回限り・登録時に kim に DM・2件目以降は既存パスキーの承認が必要 |
| T5 | 退職者が会社 PC・自分のアカウントで Claude を使い続ける | 毎日の突き合わせ（台帳・Workspace の停止状態・Claude 組織メンバー・fleet の各 PC のログイン中アカウント）。検知したら kim に DM し、その人の PC を `ORGIAST_REVOKED_PCS` に入れて復号権限を失効させる | アカウント停止そのものは kim の承認待ち。Team プランで Admin API が使えない場合、Claude 組織メンバーは取得できない（→ 未取得と明記して通知） |
| T6 | PC の管理者権限を持つ人がローカルの keyserve 秘密（`keyserve.env`）を読む | keyserve の秘密だけでは開けない。開封には契約アカウントの OAuth トークンも要る。PC 単位の失効が効く | 契約アカウントのトークンと PC 秘密を両方盗まれたら開ける（→ 失効と監視で補う） |
| T7 | Claude Code が起動時に自動ロードする CLAUDE.md・MEMORY.md 索引 | フックより前に読まれるため、フックでは止められない。shared-memory の配布（memoryserve）を契約アカウントに限る。契約外アカウントで起動したら kim に DM | 既にディスクにある索引の1画面分は読まれうる |

### できないこと（正直な限界）
1. 復号した平文を人が目で見て写す・スクショすることは技術的に防げない。
2. PC の管理者は、フック・ツールを書き換えたり外したりできる。これは「AI の持ち出し」ではなく「人の不正」なので、監視（T5）と失効で補う。
3. Claude Code 本体が書く会話ログ（`~/.claude/projects/**/*.jsonl`）は平文で書かれる。暗号化して書かせることはできない。読み出しをフックで止めることと、古いログを封印して平文を消すこと（kim の承認後）で補う。
4. keyserve が落ちているあいだは封印ファイルを開けない（安全側）。署名済みのアカウント判定が7日以内にあれば、フックの判定だけはその結果で続ける。

## 3. 構成

```
[Claude Code (各PC)]
  ├─ PreToolUse フック knowledge-guard ──(保護パス?)── 署名済み判定キャッシュを検証
  │                                                     └ 無い/期限切れ → knowledge-lock verify-account
  ├─ tools/knowledge-lock.mjs  seal / open / verify-account / migrate / status
  │     seal: 公開鍵だけで暗号化（通信なし）
  │     open: POST keyserve /api/knowledge {action:"unwrap"} + PC の HMAC + Claude OAuth トークン
  └─ tools/offboarding-watch.mjs（kim-PC で毎日）→ notify-kim.mjs で DM、失効は Vercel env 更新

[orgiast-keyserve (Vercel・依存ゼロ)]
  └─ api/knowledge.js
       verify-account: profile 照会 → 台帳(KNOWLEDGE_LEDGER_JSON)照合 → RSA-PSS 署名つき判定
       unwrap:  契約 → データ鍵を返す ／ 契約外 → 承認リクエスト(署名トークン)を返し kim に DM
       approve: kim のスマホで開くページ。WebAuthn で本人確認 → 8文字の許可コードを表示
       register: パスキー登録（1回限り・登録時に kim へ DM）
```

### 3.1 封印ファイルの形式（`.lock`）
1行目 `ORGLOCK1`、2行目以降は JSON。
`{v:1, kid, alg:"A256GCM+RSA-OAEP-256", wrappedKey, iv, tag, ct, name, sealedAt, sha256OfPlaintext}`（バイナリは base64url）。
`name` と `sealedAt` は AAD に入れて改ざんを検出する。

### 3.2 開封の分岐
1. `knowledge-lock open X.lock` は `~/.claude/.credentials.json` の OAuth トークンと PC の HMAC を付けて unwrap を呼ぶ。
2. サーバは profile を照会する。台帳上「契約」なら、データ鍵を復号して返す（kim の操作なし）。
3. 契約外なら `{status:"approval_required", request, approveUrl}` を返し、サーバから kim に Discord DM を送る（要求元 PC・アカウント・ファイル名つき）。
4. kim がスマホでリンクを開き、パスキー（生体認証）で承認すると、ページに8文字の許可コードが出る。
5. 要求元のセッションでそのコードを入力すると（`knowledge-lock open X.lock --request <r> --grant <code>`）、サーバが署名を検証してデータ鍵を返す。許可は 15 分・その1ファイル・その PC だけに有効。

ステートレス設計（keyserve は保存先を持たない）のため、許可の受け渡しは「8文字のコードを入力」にした。発生は契約外アカウントが封印ファイルを開こうとしたときだけで、年0〜数回の見込み。保存先（KV）を追加すれば入力なしにできるが、新規サービス契約になるので見送る。

### 3.3 保護対象と方式

| 対象 | 方式 |
|---|---|
| `~/.claude/next-session.md`・session-close の出力 | 封印（`.lock`）＋フックで読み出し制限。平文の廃止は第2段（書き手・読み手の全ツールを `lib/handoff-store.mjs` 経由に移す。kim の承認後） |
| 各リポの `HANDOVER.md` | 移管先（別アカウント）が読む前提の文書。封印版 `HANDOVER.md.lock` を併置し、移管時は移管先アカウントを台帳に載せれば自動で開ける |
| memory（`~/.claude/projects/*/memory`）・会話ログ（`*.jsonl`） | フックで読み出し制限。古いログの封印・平文削除は kim の承認後 |
| shared-memory 配布（memoryserve） | 取得時に verify-account を必須にする（第2段・memoryserve 側の変更） |
| fleet-mail 本文（フリートシート） | 送信時に本文を封印して保存する（第2段。GAS 側も変更が要る） |
| Drive の claude-common-rules ハブ | Drive の共有範囲を orgiast.jp ドメインに限る（現状の照会結果を検証表に記載） |

## 4. 鍵の保管と失効

| 鍵 | 場所 | 失効・ローテーション |
|---|---|---|
| マスター秘密鍵（RSA-3072） | Vercel `orgiast-keyserve` の Sensitive env `KNOWLEDGE_LOCK_PRIVATE_KEY`（読み戻し不可）。生成スクリプトは標準出力に出さず、直接 `vercel env add` に渡す | 新しい鍵ペアを作り、`kid` を上げる。旧鍵は `KNOWLEDGE_LOCK_PRIVATE_KEY_OLD` に残して旧ファイルを開けるようにし、`knowledge-lock reseal` で掛け直す |
| PC の HMAC 鍵 | 各 PC の `~/.claude/keyserve.env`（既存） | `ORGIAST_REVOKED_PCS` に PC ID を足す（既存の仕組み）。退職者監視が自動で足す |
| アカウント台帳 | 正本 `tools/claude-account-ledger.json`。サーバ用の写しは `KNOWLEDGE_LEDGER_JSON`（`tools/knowledge-ledger-sync.mjs` が正本から生成） | 退職者は `status: retired` にすると、次の同期でサーバが即座に拒否する |
| kim のパスキー公開鍵 | Vercel env `KIM_PASSKEY_CREDENTIALS`（公開鍵なので漏れても無害） | 再登録は既存パスキーでの承認が必要 |
| 署名鍵（判定・許可トークン） | マスター秘密鍵で RSA-PSS 署名（判定）、HMAC は `KNOWLEDGE_GRANT_SECRET` | env を入れ替える |

## 5. 退職者監視（`tools/offboarding-watch.mjs`、kim-PC で毎日 07:10）

突き合わせる元データ（取れなかったものは「未取得」と通知に書き、黙って飛ばさない）:
1. 台帳 `members[]`（`status`・`retiredOn`・`pcs[]`・`claudeEmails[]`）
2. Google Workspace の `suspended`・`archived`・削除（DWD・`admin.directory.user.readonly`）
3. Claude 組織メンバー（Admin API `GET /v1/organizations/users`。Team で使えなければ未取得）
4. fleet の各 PC のログイン中アカウント（フリートシートのビーコン）

判定: 退職者（台帳で retired、または Workspace で停止・削除）が、Claude 組織に残っている／どこかの PC にログイン中／その人の PC が未失効、のどれかに当てはまれば kim に DM。`--apply-revoke` のときは、その人の PC を `ORGIAST_REVOKED_PCS` に足し、台帳の写しを同期する。台帳に無いメンバー（Claude 組織や PC に台帳外の email）も DM で知らせる。

## 6. 移管（HANDOVER.md）方針
- このリポを別アカウント（例: cr@orgiast.jp）へ移すときは、移管先の email を台帳に `active` で足すだけで、封印ファイルは kim の操作なしで開ける。
- マスター秘密鍵は Vercel プロジェクトごと移管される（env は Vercel 側にある）。リポ側に秘密は無い。
- 移管手順は `HANDOVER.md` の「knowledge-lock」節に書く。

## 7. 配布と移行
- 配布は `setup --converge` のみ。`tools/setup-manifest.json`・`tools/distribution-manifest.json`・`tools/fleet-scope.json` に登録する。settings.json を直接配らない。
- 既存の平文の移行は `knowledge-lock migrate --plan`（一覧）→ `--apply`（`.lock` を併置し、サーバ経由の復号で往復一致を確認）。平文の削除は `--delete-plaintext --kim-approved` のときだけ実行し、無人では呼ばない。
