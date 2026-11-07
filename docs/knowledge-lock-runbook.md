# knowledge-lock 運用手順書

本書は kim 承認後に実行する本番手順。作成時点では鍵生成、環境変数更新、デプロイ、DM、Drive 共有削除を実行していない。設計は [knowledge-lock-design.md](knowledge-lock-design.md)、正本は [アカウント台帳](../tools/claude-account-ledger.json)。

## 実行環境と事前確認

以下は Windows の PowerShell と Windows 版 Node.js で実行する。WSL の HOME と Windows のユーザーディレクトリを混同しない。コマンド中の `<...>` は確認した実値に置き換える。既存の Vercel ログイン・プロジェクトリンクと各 PC の keyserve 認証を利用し、資格情報を取り直さない。

```powershell
Set-Location C:\Users\uers\Downloads\klock-rules
$rules = (Get-Location).Path
$keyserve = 'C:\Users\uers\Downloads\orgiast-keyserve'
node --version
vercel whoami
Get-Content "$keyserve\.vercel\project.json"
node tools/knowledge-lock.mjs status
```

`.vercel/project.json` が意図した orgiast-keyserve のプロジェクトを指すことを確認。秘密を含む env ファイルを表示しない。以下の全操作は担当者が実施し、kim の操作は本番承認とパスキー登録時のスマホ操作に限る。

## 有効化の順序

### ① 鍵を生成する

```powershell
node tools/knowledge-lock.mjs keygen --apply
if ($LASTEXITCODE -ne 0) { throw '鍵生成未完了。後続を止める' }
```

RSA 秘密鍵はプロセスメモリから Vercel CLI の stdin 経由で production/preview の Sensitive env `KNOWLEDGE_LOCK_PRIVATE_KEY` にだけ保存される。`KNOWLEDGE_LOCK_KID` と `KNOWLEDGE_GRANT_SECRET` も設定する。ローカルには公開鍵 `tools/knowledge-lock-pubkey.pem` と識別子 `tools/knowledge-lock-pubkey.json` のみ保存する。公開鍵が既にある場合は停止する。Sensitive 秘密鍵は読み戻せないため、障害時に安易な再生成・削除をしない。

### ② 台帳を同期する

```powershell
node tools/knowledge-lock.mjs ledger-sync
node tools/knowledge-lock.mjs ledger-sync --apply
if ($LASTEXITCODE -ne 0) { throw '台帳同期未完了' }
```

全台帳から導出した `KNOWLEDGE_LEDGER_JSON` を production/preview に同期する。差分はローカルの前回同期記録との比較であり、サーバ現在値との比較ではない。env 更新だけでは稼働中デプロイは変わらない。

### ③ Discord と公開 URL を設定する

値の取得元は [notify-kim.mjs](../tools/notify-kim.mjs) の `resolveDiscordBotToken()` の読み込み（`DISCORD_BOT_TOKEN`、なければ `~/.claude/orgiast-discord-bot-token.txt`）。kim の Discord ID は同ファイルの公開定数 `KIM_DISCORD_USER_ID`（kim: `715210673642012733`）。通知ツールには別ユーザー向け override もあるため、ここでは kim の定数を使う。

公開 URL は [knowledge-lock.mjs](../tools/knowledge-lock.mjs) の既定 keyserve URL とサーバ `api/knowledge.js` の `baseUrl()` に基づく `https://orgiast-keyserve.vercel.app`。WebAuthn の origin に使うため、実際にスマホで開く固定 HTTPS origin を設定する。

次のコードはトークンを画面・ファイルへ出さず、既存の `putEnv` で stdin に渡す。環境変数が既存の場合も置き換える。

```powershell
@'
import { spawn } from 'node:child_process';
import { putEnv } from './tools/knowledge-lock.mjs';
import { KIM_DISCORD_USER_ID, resolveDiscordBotToken } from './tools/notify-kim.mjs';
const token = resolveDiscordBotToken();
if (!token) throw Error('既存 bot token が空です');
const ctx = { spawn, platform: process.platform, serverDir: 'C:/Users/uers/Downloads/orgiast-keyserve' };
await putEnv(ctx, 'DISCORD_BOT_TOKEN', token);
await putEnv(ctx, 'KIM_DISCORD_USER_ID', KIM_DISCORD_USER_ID);
await putEnv(ctx, 'KNOWLEDGE_PUBLIC_BASE_URL', 'https://orgiast-keyserve.vercel.app');
console.log('production/preview 設定完了。再デプロイ待ち');
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'env 更新未完了' }
```

### ④ keyserve PR をマージして本番デプロイする

```powershell
Push-Location $keyserve
gh pr view <keyserveのPR番号> --json url,state,mergeable,statusCheckRollup
gh pr merge <keyserveのPR番号> --merge
vercel ls --environment production
vercel inspect https://orgiast-keyserve.vercel.app
Pop-Location
```

Git 連携による本番デプロイが Ready で、対象 PR の変更を含むことを確認してから続ける。マージ直後の一覧だけで完了扱いにしない。

### ⑤ パスキーを登録し再デプロイする

```powershell
node tools/knowledge-lock.mjs passkey-link
```

kim が DM のリンクをスマホで開き、生体認証を1回行う。`dmSent: false` の場合は出力された登録 URL を使う。登録完了 DM の blob を次の引数に渡す。登録リンク発行だけでは登録完了ではない。

```powershell
node tools/knowledge-lock.mjs passkey-install --blob '<DMのblob>' --apply
if ($LASTEXITCODE -ne 0) { throw 'パスキー反映未完了' }
Push-Location $keyserve
vercel ls --environment production
vercel redeploy <直前に確認した本番デプロイURL> --target production
vercel inspect https://orgiast-keyserve.vercel.app
Pop-Location
```

`KIM_PASSKEY_CREDENTIALS` とローカル `tools/knowledge-passkeys.json` には公開情報だけを保存する。再デプロイが Ready になるまで進めない。実装は登録済みのとき新規登録リンクを拒否するため、追加登録や初期化を無断で行わない。DM を送る操作を実施した担当者は、送信本文全文と添付があればその内容を作業チャットにも記録する。

### ⑥ 公開鍵の PR をマージし各 PC へ配布する

公開鍵 PEM と kid JSON を同じ PR に含め、通常のリポ配布経路で各 PC の checkout を更新する。秘密鍵は含めない。

```powershell
gh pr view <公開鍵を含むrulesのPR番号> --json url,files,statusCheckRollup
gh pr merge <公開鍵を含むrulesのPR番号> --merge
# 以下は各 PC の rules リポで実行（kim-PC だけの実行では全PC配布にならない）
node tools/onboarding-sync.mjs --force
node tools/setup.mjs --converge
node tools/knowledge-lock.mjs status
node tools/knowledge-lock.mjs verify-account --json
```

公開鍵が存在しない間、knowledge-guard は無効。既にフックが登録された PC では公開鍵が届いた時点で有効になるため、サーバ・パスキーを先に準備する。各 PC の converge 結果と署名検証成功を確認し、未確認 PC を全台成功に含めない。

### ⑦ 平文を残して移行・往復検証する

```powershell
node tools/knowledge-lock.mjs migrate --plan
node tools/knowledge-lock.mjs migrate --apply
if ($LASTEXITCODE -ne 0) { throw '往復未完了。平文は削除しない' }
Get-Content "$HOME\.claude\state\knowledge-migrate.json"
```

対象は `~/.claude/next-session*.md`、`~/.claude/handoff*` 配下の Markdown、Downloads 直下の Git リポの `HANDOVER.md`。一般の memory や会話ログ全体を移行するコマンドではない。対象一覧と記録を照合し、各レコードの `roundTrip: "ok"` を確認する。対象0件の exit 0 を移行成功と扱わない。`skipped(kim承認待ち)` や `failed` があれば削除しない。

### ⑧ 平文削除は別途 kim 承認後だけ

```powershell
node tools/knowledge-lock.mjs migrate --delete-plaintext --kim-approved
Get-Content "$HOME\.claude\state\knowledge-migrate.json"
```

削除対象は往復成功し、その後平文と `.lock` のハッシュが変わっていないファイルだけ。`deleted: true` を確認する。フラグ指定は承認の代わりではなく、実際の kim 承認を先に得る。

## 各段階の戻し方

- ①：配布・移行前なら作業を中断する。生成済み秘密鍵は保持する。片環境だけ設定された場合も消して再生成せず、設定完了状況を調べる。封印済みファイルがある鍵を失うと復旧できない。
- ②：台帳を直前の承認済み内容へ戻し、`ledger-sync --apply`、再デプロイする。
- ③：誤った env を上記③のコードで正しい値に置き換え、再デプロイする。Sensitive 値を読み戻して復旧しようとしない。
- ④：直前の正常なデプロイへ戻す。ただし knowledge API のない版へ戻す前に⑥のフック停止を行う。
- ⑤：誤登録なら登録を使用させず停止し、公開パスキー台帳を直前の承認済み配列に戻して下記コマンドで env 同期・再デプロイする。初回登録を消すと再登録可能になるため kim の管理下でのみ行う。
- ⑥：公開鍵 PEM を外した PR をマージし、全 PC に更新・converge する。ローカルに PEM が残っていないことまで確認する。秘密鍵・封印ファイルは残す。
- ⑦：平文が残るので移行を止める。既存 `.lock` と検証記録を保持する。再実行は `.lock` と記録を更新するため、障害調査前に繰り返さない。
- ⑧：鍵とサーバが正常なうちに `open --out` で平文を復元する。失った秘密鍵を公開鍵から復元する方法はない。

```powershell
# ② 台帳復旧後
node tools/knowledge-lock.mjs ledger-sync --apply
# ④ 正常な既存デプロイへ戻す（対象を一覧で確認）
Push-Location $keyserve
vercel ls --environment production
vercel rollback <直前の正常デプロイURL>
Pop-Location
# ⑤ 公開パスキー台帳を復旧した後
@'
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { putEnv } from './tools/knowledge-lock.mjs';
const entries = JSON.parse(fs.readFileSync('tools/knowledge-passkeys.json', 'utf8'));
if (!Array.isArray(entries)) throw Error('配列ではありません');
await putEnv({ spawn, platform: process.platform, serverDir: 'C:/Users/uers/Downloads/orgiast-keyserve' }, 'KIM_PASSKEY_CREDENTIALS', JSON.stringify(entries));
'@ | node --input-type=module
# env 復旧後は⑤と同じ redeploy / inspect を実施する
# ⑥ 公開鍵削除PRを通常経路で作成・レビューした後
gh pr merge <公開鍵削除PR番号> --merge
# 各PCのcheckout更新
node tools/onboarding-sync.mjs --force
node tools/setup.mjs --converge
Test-Path tools/knowledge-lock-pubkey.pem  # False を確認
node tools/knowledge-lock.mjs status
# ⑧ 復元（出力先に既存ファイルがないことを先に確認）
Test-Path '<復元先HANDOVER.md>'
node tools/knowledge-lock.mjs open '<HANDOVER.md.lockのパス>' --out '<復元先HANDOVER.md>'
```

## 退職者が出たとき

台帳の対象席を email で特定して `status=retired`、`retiredOn` を実際の退職日にする。`pcs` は keyserve の実 ID と照合する。表示名から推測して失効させない。

```powershell
$env:RETIRING_EMAIL = '<退職者email>'
$env:RETIRING_DATE = '<YYYY-MM-DD>'
@'
import fs from 'node:fs';
const file = 'tools/claude-account-ledger.json';
const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
const member = ledger.members.find(m => m.email === process.env.RETIRING_EMAIL);
if (!member || !/^\d{4}-\d{2}-\d{2}$/.test(process.env.RETIRING_DATE || '')) throw Error('対象または日付を確認');
member.status = 'retired'; member.retiredOn = process.env.RETIRING_DATE;
fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
'@ | node --input-type=module
node tools/offboarding-watch.mjs --json
# 未取得・退職判定の全対象を確認してから実行（指定した1人だけに限定するコマンドではない）
node tools/offboarding-watch.mjs --apply-revoke
```

失効台帳と `ORGIAST_REVOKED_PCS`、契約台帳 env が更新される。⑤の `vercel redeploy` / `inspect` で本番反映する。これは Claude Team 席削除・Workspace アカウント停止を行わない。Team 管理画面・Workspace 管理画面で別途承認済みの処置を行う。未取得源を正常と報告しない。

## 移管（HANDOVER）

移管先の実 email を active で台帳に追加する。既存の retired 席を自動で active に戻してはいけない。

```powershell
$env:HANDOVER_EMAIL = '<移管先email>'
$env:HANDOVER_NAME = '<移管先氏名>'
@'
import fs from 'node:fs';
const file = 'tools/claude-account-ledger.json';
const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
const email = (process.env.HANDOVER_EMAIL || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !process.env.HANDOVER_NAME) throw Error('移管先を確認');
if (ledger.members.some(m => [m.email, ...(m.claudeEmails || [])].some(v => v.toLowerCase() === email))) throw Error('既存席を確認');
ledger.members.push({ name: process.env.HANDOVER_NAME, email, claudeEmails: [], discordId: null, pcs: [], status: 'active', retiredOn: null });
fs.writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n');
'@ | node --input-type=module
node tools/knowledge-lock.mjs ledger-sync
node tools/knowledge-lock.mjs ledger-sync --apply
# ⑤の redeploy / inspect 後、認証設定済みの移管先PCで実行
node tools/knowledge-lock.mjs verify-account --json
node tools/knowledge-lock.mjs open '<HANDOVER.md.lockのパス>' --out '<復元先HANDOVER.md>'
```

Vercel プロジェクトそのものを移管すれば、プロジェクトに属する秘密鍵 env も移る。新規プロジェクトを作って公開鍵だけコピーする手順とは異なる。Vercel の対象プロジェクト Settings の Transfer で移管し、移管後の管理権限・Sensitive env の存在・ドメインと上記の開封成功を確認する。秘密鍵は読み戻せない。公開 origin を変える場合、既存パスキーとの互換性を別途検証する。

## 既知の未取得と解消案（2026-10-29 の監督実測）

本節は引き継がれた実測記録であり、この手順書作成セッションでの再測定ではない。

| 未取得 | 解消案・再確認 |
|---|---|
| Workspace の DWD `admin.directory.user.readonly` が未認可、HTTP 401 `unauthorized_client` | Google 管理コンソールのセキュリティ → API の制御 → ドメイン全体の委任で、既存 SA の client_id に `https://www.googleapis.com/auth/admin.directory.user.readonly` を追加する。既存スコープを消さない。追加後に下記監視を再実行。 |
| Claude Team 全席 | 現在の Admin キーは API Console 組織「オージャスト」（UUID の確認済み接頭辞 `72a89cff…`）用で kim と m.kanau のみ。Team「オージャスト」（UUID `07b2296b-cf32-43b5-993e-be47884b3fda`）とは異なる。Team 管理画面の席一覧と正本を照合し、確認済み email と証拠を追記する。Admin API 成功を Team 全席取得と見なさない。 |
| fleet 24台で Claude email・keyserve PC ID が欠落 | ビーコン送信側・受信側に両フィールドを実装・配布し、各 PC の実値を報告させる。表示名から補完しない。未報告 PC には通常の配布経路で更新を適用し、台数が0になるまで未取得として残す。 |

```powershell
# SA の非秘密 client_id だけ確認（秘密鍵全体を表示しない）
@'
import fs from 'node:fs';
import { defaultDriveKeyPath } from './tools/lib/drive-auth.mjs';
console.log(JSON.parse(fs.readFileSync(process.env.GOOGLE_SA_KEY || defaultDriveKeyPath(), 'utf8')).client_id);
'@ | node --input-type=module
node tools/offboarding-watch.mjs --json
```

## Drive ハブの外部共有（削除案・未実行）

2026-10-29 の監督実測で、Drive ハブ **claude-common-rules**（フォルダ ID `1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw`）の共有に **nacci0713@gmail.com / writer** が含まれる。必要性を確認し、削除承認後のみ実施する。[drive-hub-sync.mjs](../scripts/drive-hub-sync.mjs) と同系統の DWD 認証を [drive-auth.mjs](../tools/lib/drive-auth.mjs) から使う。以下は現状再取得・対象 email/role 照合・削除・再取得を行う案。既定は照会のみ。

PowerShell の here-string 内を Node.js として実行する。削除承認後に限り `$env:DELETE_HUB_EXTERNAL_SHARE = 'approved'` を先に設定する。

```powershell
# 既定は照会のみ。承認前はこの変数を設定しない
Remove-Item Env:DELETE_HUB_EXTERNAL_SHARE -ErrorAction SilentlyContinue
@'
import { getDriveToken } from './tools/lib/drive-auth.mjs';
const file = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw'; // claude-common-rules
const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/drive', impersonate: 'kim@orgiast.jp' });
const base = `https://www.googleapis.com/drive/v3/files/${file}/permissions`;
async function call(url, method = 'GET') {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw Error(`Drive HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}
async function list() {
  const items = []; let page;
  do {
    const url = new URL(base);
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', 'nextPageToken,permissions(id,type,emailAddress,role,permissionDetails)');
    if (page) url.searchParams.set('pageToken', page);
    const data = await call(url);
    items.push(...(data.permissions || [])); page = data.nextPageToken;
  } while (page);
  return items;
}
const permissions = await list();
const targets = permissions.filter(p => p.type === 'user' && p.emailAddress?.toLowerCase() === 'nacci0713@gmail.com');
console.log(JSON.stringify({ folder: 'claude-common-rules', targets }, null, 2));
if (process.env.DELETE_HUB_EXTERNAL_SHARE === 'approved') {
  if (targets.length !== 1 || targets[0].role !== 'writer' || targets[0].permissionDetails?.some(d => d.inherited)) throw Error('対象・role・継承状態を再確認');
  await call(`${base}/${encodeURIComponent(targets[0].id)}?supportsAllDrives=true`, 'DELETE');
  if ((await list()).some(p => p.emailAddress?.toLowerCase() === 'nacci0713@gmail.com')) throw Error('共有が残っています');
  console.log('claude-common-rules: nacci0713@gmail.com の直接共有削除を確認');
}
'@ | node --input-type=module
Remove-Item Env:DELETE_HUB_EXTERNAL_SHARE -ErrorAction SilentlyContinue
```

削除実行時は先頭の `Remove-Item` を承認済み変数の設定に置き換える。継承共有は親フォルダを調べ、別承認で処理する。代替操作は [claude-common-rules の Drive 画面](https://drive.google.com/drive/folders/1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw) → 共有 → 対象メールのアクセス権削除。組織外 Gmail をすべて一律削除せず、グループ会社の正当な席などと区別する。

## リリース前の検査

```powershell
node --test tools/offboarding-watch.test.mjs tools/knowledge-guard.test.mjs tools/knowledge-lock.test.mjs tools/claude-account-ledger.test.mjs tools/distribution-coverage.test.mjs tools/register-hooks.test.mjs tools/gate-contract.test.mjs
node tools/selftest-guards.mjs
```

テスト成功は本番の有効化完了を意味しない。デプロイ Ready、各 PC の署名判定、実ファイルの往復、未取得源の解消をそれぞれ証拠で確認する。
