# 内部スタッフ（経理等）への確認依頼 → チャット表示 の実測（2026-09-22）

handoff-audit:57eef0336eb2bedd（pattern「内部スタッフ（経理等）への確認依頼」× route「チャット表示」）の検証記録。
id は `sha256(JSON.stringify([NFKC正規化(pattern), NFKC正規化(route)])).slice(0,16)` で再計算して一致を確認した
（`tools/handoff-audit-nightly.mjs` の `hash`/`key` と同一式）。

**本記録が覆う範囲（4 id）**: 同一 route「チャット表示」に別々の pattern 名で付いた4件は、この1記録で畳む。
2026-09-22 の時点では 57eef0336eb2bedd しか完了印が付いていなかったため、残り3件を再調査しないよう
2026-09-22-13 に **4件すべての id を再計算して一致を実測**した（下の「4 id の確定」）。

## 結論（3行）

1. 経路は実装済み・登録済み・テスト緑。**MCP 経由の内部宛 Gmail 下書き/送信は deny される**（実測）。
2. ただしこのPCの APIキー運用（claude.ai コネクタ無効）では `mcp__claude_ai_Gmail__*` が存在せず、**ガードは発火しない（latent）**。
   Bash 経由の Gmail REST（DWD）は matcher の外で、実測でも素通りした＝**環境依存の片肺**。
3. 同 route の TODO が4件重複していた（同一セッション起源）。現行コードは route 重複を弾くので新規には増えない（実測）。

## 経路の実体

| 項目 | 実測値 |
|---|---|
| 実装 | `tools/internal-recipient-gmail-guard.mjs`（PreToolUse hook・deny を stdout に返す） |
| 登録 | `~/.claude/settings.json:475` matcher `mcp__claude_ai_Gmail(?:_\d+)?__(create_draft|send_message|update_draft|reply|forward)` / timeout 5 |
| live 実体 | `C:\Users\uers\orgiast-main\tools\internal-recipient-gmail-guard.mjs`（rules ツリーの同名ファイルとバイト一致 = `diff` で差分ゼロ） |
| 台帳 | `~/.claude/internal-recipients.json` は**このPCに存在しない** → default 台帳 `tools/internal-recipients.default.json`（domains: orgiast.jp / toho-kogyo.com、addresses: genbateam.toho@gmail.com / **keiri.orgiast@gmail.com（経理）** / atsuoast3@gmail.com / kimkongyong@gmail.com） |
| 履歴 | #357 で導入 → #414 で matcher の取りこぼし修正。どちらも `origin/main` に含まれる（`git branch -r --contains` で確認） |
| テスト | `node --test tools/internal-recipient-gmail-guard.test.mjs` = **14 pass / 0 fail** |

## 実測（2026-09-22・このPC）

stdin に PreToolUse の payload を流して判定を取った（送信は一切していない）。

| 入力 | 結果 |
|---|---|
| `mcp__claude_ai_Gmail__create_draft` → `keiri.orgiast@gmail.com`（経理） | **deny**。[INTERNAL-RECIPIENT] の理由文に「チャット本文に『宛先／用件／本文』をコピペできる完成形で表示」が含まれる |
| `mcp__claude_ai_Gmail__create_draft` → `client@example.com`（外部） | pass（無出力）＝外部宛は従来どおり下書き可 |
| `Bash`: `node tools/gmail-draft.mjs --to keiri.orgiast@gmail.com` | **pass（対象外）**。matcher が MCP ツール名に固定されているため Bash は素通り |
| `claude mcp list` | `gemini-cli` のみ。**claude.ai コネクタは `ANTHROPIC_API_KEY` が優先されるため無効** → この環境に `mcp__claude_ai_Gmail__*` は存在しない |

`tools/` に下書き作成の常設ツールは無い（`gmail-search.mjs` は `gmail.readonly` の読み取り専用）。
つまり REST 経路の穴は「常設ツールがある」のではなく、**アドホックなコードを書けば誰も止めない**という意味。

## 再発防止に効く形 / 効かない形

- **効く**: Gmail MCP が有効なセッション（claude.ai ログイン運用）では、内部宛の下書き作成が**ツール実行前に**止まり、
  代わりにチャット表示を促す文面が返る。判定は台帳のドメイン/アドレス列挙だけで行うので、追加は1行で済む。
- **効かない（穴）**:
  1. APIキー運用のPCでは MCP ツール自体が無く、フックは一度も呼ばれない。Gmail 下書きを作る経路が REST に移ると無防備。
  2. 台帳に無いフリーメールの社内スタッフ（新しい現場担当など）は素通りする。default 台帳が3つの gmail を明示列挙しているのは、
     ドメイン判定では拾えない社内アドレスを個別に足している運用の証拠。**人の追加が前提**。
  3. `reply_all` 等、コネクタ側に存在しうる書き込み系ツール名は `GMAIL_WRITE_ACTIONS` に無い（この環境ではコネクタが無効なため
     実ツール名を列挙して確認できていない＝**未確認**）。→ 2026-09-22-13 に**判定側は実測済み**（許可リスト外の名前は内部宛でも pass）。
     コネクタが公開するツール名の一覧だけが未確認のまま。下の「未確認 → 実測に変わった点」を参照。
- 規約（§1.1 内部宛はチャット表示・Gmail 下書き禁止）とガードは**二重化になっていない**。
  片方は文章、片方は環境依存のフックなので、APIキー環境では実効が文章だけになる。

## TODO の重複（コスト面）

同一 route「チャット表示」の TODO が4件あった。

| id | pattern |
|---|---|
| 57eef0336eb2bedd | 内部スタッフ（経理等）への確認依頼 |
| 8f97ab9b74388d90 | 内部スタッフへ確認連絡 |
| b197bef2949f4454 | 内部スタッフへの連絡依頼 |
| 9845df1eb6fe821e | 内部スタッフへの再登録依頼の伝達 |

出所はすべて同一セッション `009374eb-9aab-45ad-bffc-690a68519d6e`（2026-09-18）で、監査LLMが同じ handoff を
別々の pattern 名で5回ラベルしたもの（`~/.claude/handoff-audit-nightly-ledger.jsonl` で確認）。
`id = hash(pattern, route)` のため pattern 名が揺れると別TODOになる。
現行 `enqueueTodos` は **route 単位で重複を弾く**（旧形式の行からも route を抽出する）ことを実測で確認した（同じ route を渡すと `SKIP`）。
つまり新規には増えないが、旧形式で書かれた既存4行は残る。**1回の調査で4件を畳める**（本記録がその1回）。

## B軸（人手・コスト）

- 内部宛は「Gmail 下書きを開いて確認」より「チャット文面をコピペ」の方が kim の手数が少ない。deny 理由文が完成形の指示を兼ねる。
- 4件の重複TODOを1調査で畳んだ（同種の調査を最大4セッション分節約）。
- 一方で APIキー環境ではこの保護が無効なので、**「守られている」と誤認したまま運用すると、規約違反が無言で通る**。
  恒久策（Bash matcher 追加 or MCP 有効化）は誤爆リスクと権限変更を伴うため、本記録では実装しない。

## 未確認（推測で埋めない）

- claude.ai コネクタ有効環境での実発火（このPCではコネクタが無効で再現できない）。
- Gmail コネクタが実際に公開している書き込み系ツール名の全リスト（`reply_all` 等の有無）。
- 分類器が Bash 経由の Gmail 下書き作成を止めるか（未試行。試行自体が外部システムへの書き込みを伴うため行っていない）。

## 4 id の確定（2026-09-22-13 実測 / handoff-audit:8f97ab9b74388d90）

`hash([key(pattern), key('チャット表示')]).slice(0,16)` を4 pattern で再計算し、**4件すべてが期待 id と一致**した
（`hash`/`key` は `tools/handoff-audit-nightly.mjs:13-14` と同一式。同ファイルは両者を export していないため転記して実行）。

| 期待 id | pattern | 再計算 |
|---|---|---|
| 57eef0336eb2bedd | 内部スタッフ（経理等）への確認依頼 | MATCH |
| 8f97ab9b74388d90 | 内部スタッフへ確認連絡 | MATCH |
| b197bef2949f4454 | 内部スタッフへの連絡依頼 | MATCH |
| 9845df1eb6fe821e | 内部スタッフへの再登録依頼の伝達 | MATCH |

「同じ route・別 pattern 名」で4件に割れていたことが**機械的に確定**した。**4件はこの1記録で足りる**（再調査不要）。

### live フック再実測（2026-09-22-13・送信なし）

`C:\Users\uers\orgiast-main\tools\internal-recipient-gmail-guard.mjs` に PreToolUse payload を stdin で流した。

| tool_name | 宛先 | 結果 |
|---|---|---|
| `mcp__claude_ai_Gmail__create_draft` | keiri.orgiast@gmail.com（経理） | **deny**（理由文に「チャット本文に『宛先／用件／本文』をコピペできる完成形で表示」を含む） |
| `mcp__claude_ai_Gmail__create_draft` | client@example.com（外部） | pass（無出力） |
| `mcp__claude_ai_Gmail__send_message` | kimkongyong@gmail.com（本人） | **deny** |
| `mcp__claude_ai_Gmail__reply_all` | keiri.orgiast@gmail.com（経理） | **pass（素通り）** |

`node --test tools/internal-recipient-gmail-guard.test.mjs` = **14 pass / 0 fail**（2026-09-22-13 再実行）。

### 未確認 → 実測に変わった点（穴の確定）

- `TARGET = ^mcp__claude_ai_Gmail(?:_\d+)?__(create_draft|send_message|update_draft|reply|forward)$` は
  **許可リスト固定**なので、これ以外の名前（`reply_all` 等）は**内部宛でも pass する**＝判定側は実測で確定。
- ただし「Gmail コネクタが実際に `reply_all` を公開しているか」は**引き続き未確認**
  （このPCは `ANTHROPIC_API_KEY` 優先でコネクタ無効＝ツール一覧を取得できない）。
  確定したのは「**もし**その名前が存在すればガードは止めない」という一点のみ。過大に読まないこと。
- 恒久策（許可リスト→deny-by-default への反転・Bash matcher 追加・MCP 有効化）は**権限面の変更**を含むため
  本記録では実装しない（既存の承認範囲を守る）。必要になった時点で kim の1回の同意を得て行う。
