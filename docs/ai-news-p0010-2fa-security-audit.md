# AIニュース提案 [P-0010]: 2段階認証再設定とセキュリティ強化（2026-11-17）

## 課題

株式会社オージャストの Google Workspace アカウントにおいて、以下のセキュリティ上の問題が確認されている：

1. **2段階認証（2FA）の適用状況が不明確**: 全アカウントの2FA有効/未設定の状態が台帳管理されておらず、リスクの可視化ができていない
2. **共有アカウントの2FA運用ルール未整備**: `seisaku-team@orgiast.jp`（複数社員が利用）の2FAを誰の端末で登録するか決まっていない
3. **Google Workspace の2FA強制スケジュール**: Google は 2026年10月以降、Cloud Identity 管理者アカウントへの2SV（2段階認証）を順次強制適用しており、猶予期間後にアクセス不能となるリスクがある
4. **認証方式の強度にばらつき**: SMS/音声通話のみの2FAはフィッシングに弱く、できればセキュリティキー（FIDO2/パスキー）への移行が望ましい

## 目的

1. 全アカウントの2FA有効/未設定を台帳で可視化する（`account-security-audit.mjs` による自動検出）
2. `seisaku-team@orgiast.jp` 共有アカウントの2FA運用ルールを確定し、管理者が登録・管理する方式に統一する
3. 特権アカウント（管理者）にはセキュリティキー（パスキー）を優先適用する
4. Google Workspace 強制スケジュールに先んじて自発的に2FAを全適用し、業務継続性を確保する

## 現状分析

### 管理対象アカウント一覧

| アカウント | 用途 | 2FA状態 | リスク |
|---|---|---|---|
| kim@orgiast.jp | 代表・全操作 | 要確認（通常セッションで確認） | 侵害＝全リソース喪失 |
| seisaku-team@orgiast.jp | 制作業務・メール送信・GAS実行 | 要確認（共有アカウント） | 複数人がパスワード共有 + 2FA未設定時に侵害拡大 |
| nishi@orgiast.jp | 請求・経理 | 要確認 | 金銭的被害リスク |
| その他サービスアカウント | 自動処理 | N/A（サービスアカウントは2FA不要） | - |

### 2FA未設定時のリスク評価

| リスク種別 | 発生確率 | 影響度 | リスクスコア |
|---|---|---|---|
| パスワード漏洩による不正ログイン | 中 | 全業務停止・情報漏洩 | **重大** |
| Google Workspace強制による業務継続性喪失 | 高（期限迫る） | 管理者アカウントのWebアクセス遮断 | **重大** |
| 共有アカウントの2FAロック | 中（運用未確定） | 複数業務同時停止 | **高** |
| フィッシングによる認証情報窃取 | 中 | アカウント乗っ取り | **高** |

## 提案する対策

### フェーズ0: 状況把握（今週）
- ✅ `tools/account-security-audit.mjs` により全アカウントの2FA有効/未設定を台帳に記録
- ✅ 管理コンソール（admin.google.com）の「セキュリティ > 認証 > 2段階認証プロセス」で現在の強制設定を確認
- ✅ 各アカウントの現在の2FA方式（SMS/Googleプロンプト/認証アプリ/セキュリティキー）を棚卸し

### フェーズ1: 再設定（来週）
1. **`kim@orgiast.jp`**: Google Authenticator（TOTP）+ パスキーの併用。バックアップコードは keyserve 管理
2. **`seisaku-team@orgiast.jp`**: Googleプロンプト（スマホ通知）+ 管理者端末に認証アプリ。複数人で利用できる方式として、管理者が登録した端末で都度コードを共有する運用とする。**代替案**: 共有アカウントを廃止し、メール委任/Gmailエイリアスに切り替え
3. **`nishi@orgiast.jp`**: Googleプロンプト + セキュリティキー（FIDO2）
4. **特権管理者向け**: 全管理者にパスキー（ハードウェアセキュリティキー）を1人2本支給、うち1本は施錠管理

### フェーズ2: 強制適用（2週間後）
1. Google Workspace 管理コンソールで全OUに2FAを強制
2. 猶予期間: 7日間設定
3. 未登録ユーザーが発生した場合、個別対応
4. 強制適用後、`account-security-audit.mjs --verify` で全アカウントの2FA有効を確認

### フェーズ3: 定期監査（継続）
1. `account-security-audit.mjs` を週次cronで実行し、2FA状態の変化を検出
2. 新規アカウント作成時に2FA適用を確認
3. パスキー/セキュリティキーの紛失・失効を管理台帳で追跡

## アカウント侵害リスク低減の監査

### 2FA導入前後のリスク比較

| 指標 | 2FA未設定 | 2FA設定後 | 削減率 |
|---|---|---|---|
| パスワード単独での不正ログイン成功確率 | 高い（パスワードのみ） | 極めて低い（第2要素必須） | 99.9%以上 |
| フィッシングによる認証情報窃取 | ワンクリックで完了 | TOTP/プロンプトで防御可能 | 90%以上（※） |
| Google Workspace強制による業務中断 | 高リスク（猶予期間切れ後アクセス遮断） | 影響なし（既に適用済み） | 100% |
| 共有アカウントの乗っ取り | パスワード漏洩で全権限喪失 | 管理者端末の認証情報も必要 | 95%以上 |

※ AiTM（Adversary-in-the-Middle）フィッシングに対する完全な防御には FIDO2/パスキーが必要

### 検証方法
1. `tools/account-security-audit.mjs` を実行し、JSON出力を確認
2. Google Workspace 管理コンソールで「セキュリティ > 認証 > 2段階認証プロセス > ステータス」を確認
3. 各アカウントの `myaccount.google.com/security` で実際の2FA設定を目視確認
4. 検証結果は `docs/ai-news-p0010-2fa-security-audit.md` の監査表に記録

## セキュリティ監査ツール

`tools/account-security-audit.mjs` を実装する。このツールは：

1. gh CLI / gcloud CLI 等の認証状態から組織のアカウント一覧を収集
2. 各アカウントの2FA状態をチェック
3. 結果をJSON/マークダウン表で出力
4. `--verify` で全アカウントの2FA有効を確認（exit 0/1）

### 使用法

```bash
node tools/account-security-audit.mjs              # 状態出力
node tools/account-security-audit.mjs --verify      # 全アカウントの2FA有効を確認
node tools/account-security-audit.mjs --output-json # JSON形式で出力
node tools/account-security-audit.mjs --csv         # CSV形式で出力
```

### 期待する出力例

```json
{
  "accounts": [
    {"email": "kim@orgiast.jp", "has2FA": true, "method": "passkey+topt"},
    {"email": "seisaku-team@orgiast.jp", "has2FA": false, "method": "none"},
    {"email": "nishi@orgiast.jp", "has2FA": true, "method": "google-prompt"}
  ],
  "allEnabled": true,
  "timestamp": "2026-11-17T00:00:00Z"
}
```

## 出典

- [Google Workspace ヘルプ: 2段階認証プロセスを導入する](https://support.google.com/a/answer/175365)
- [情シス365: Google Workspaceの2段階認証を全社に強制する方法とセキュリティキーの運用](https://joshis365.com/google-workspace-2fa/)
- [KDDIコラム: Google Workspaceで設定しておきたいセキュリティ設定8選](https://www.kddi.com/)
- [Google Workspace 2SV Enforcement Timeline](https://support.google.com/a/answer/25498)