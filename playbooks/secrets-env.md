aliases: [APIキー, 環境変数, env, keyserve, Vercel, secret, 鍵, キー]

# secrets-env — 所在検索・登録・読み戻し

実測: env-kv/keyserve 14回／7セッション、vercel 17回／6セッション。Resend鍵の所在を3セッションが重複調査した。出典: `~/.claude/skill-and-loop-redesign-20261028.md` §1。参照: ONBOARDING §AUTOMATION-FIRST、§1.20、[keyserve-status](../tools/keyserve-status.mjs)・[env-kv](../tools/env-kv.mjs)。

## 所在をこの順に確認する

1. `node tools/keyserve-status.mjs` で keyserve の状態・既存経路を確認する。
2. `node tools/env-kv.mjs` のusageに沿って対象envファイルの既存設定を調べる。秘匿値の取得・保存は専用ツール経由のみ。
3. production bundle は公開設定値だけを確認する。秘密鍵の探索・抽出先にはしない。
4. 自動設定は `tools/env-kv.mjs` 等の専用ツール経由に限定する。`gh secret set` / `.env.local` 直書き / transcript grep はしない（classifierのCredential系で止まる）。値を人に再質問する前に、既存の所在と結果を確認する。

## Vercel に登録する

対象プロジェクトと環境（production/preview/development）を照合し、`vercel env add <KEY> <env>` で登録する。秘匿値は承認済みの専用経路で渡し、コマンド引数・チャット・記録へ展開しない。

`vercel env pull` が通っても `vercel env add` は拒否され得る。読み取り・書き込みは別判定。classifier 拒否はカテゴリ・操作を1行報告し、言い換え再試行しない。

## 読み戻して確認する

登録後に `vercel env ls` または対象アプリのenv取得で、対象KEYが正しいプロジェクト・環境に登録されたことを実測する。一覧確認は登録の証拠であり、値の一致やアプリの動作まで証明するものではない。必要なら専用ツールで値を表示せず一致判定し、対象アプリの動作も確認する。

報告にはキー名・対象環境・照会日時・結果だけを書く。秘匿値そのものは書かない。読み戻せなければ「未確認」とする。
