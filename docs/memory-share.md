# memory の全社配布（2026-10-15）

kim-PC 夜間 → memory-publish → vercel deploy → private `/api/memory` → 各PC onboarding-sync → `~/.claude/shared-memory/` → CLAUDE.md の `@` 参照。

feedback / project / reference と索引を配布する。user、秘密値を含むファイル、`share: false` は除外。受信先は編集禁止。知見の戻しは `/share-knowledge`。

検証コマンド（リポジトリ直下）:

```sh
node tools/memory-publish.mjs --dry-run
node tools/memory-publish.mjs --deploy --verify
node tools/memory-share.mjs --install --json
node --test tools/
```

`--deploy --verify` は本番を更新し、自分の HMAC で manifest の生成日時を確認する。内容が不変なら deploy は skip。配信元の PC ID は `~/.claude/keyserve.env` の `ORGIAST_KEYSERVE_PC` を使う。Windows は PATH の vercel.cmd と同じ場所の npm パッケージを Node で直接実行し、シェルを使わない。

上書き設定: `ORGIAST_KEYSERVE_REPO`（既定 `~/Downloads/orgiast-keyserve`）、`ORGIAST_MEMORY_URL`、`ORGIAST_SHARED_MEMORY_DIR`（既定 `~/.claude/shared-memory/`）。CLAUDE.md の自動参照は既定の配置先を指すため、配置先を変える場合は参照も合わせる。オフライン受信は `--install --from <export先>`。

よくある失敗:

- 401: keyserve.env 未受領、または鍵のローテーション。
- 503: バンドル未生成。発信側で publish を実行する。
- 404: 旧デプロイ。別リポ orgiast-keyserve の `/api/memory` 対応版をデプロイする。
- generatedAt 不一致: 配信世代の切り替え中、または別の配信先。取得失敗時は state を進めず再試行する。
