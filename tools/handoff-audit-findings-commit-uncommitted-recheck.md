# handoff-audit 検証記録: 「本番反映済みだが git 未コミットの変更を user 判断でコミット可否確認」（2026-09-30 再検証・窓 2026-09-27T18:00Z〜09-30）

対象 TODO: `[handoff-audit:41e82bee49909aea] 本番反映済みだが git 未コミットの変更を user 判断でコミット可否確認 —
この handoff が再発していないかを実物で検証し結果を記録する（再発防止の経路: gh pr create）`（`~/.claude/next-session.md`）

この TODO の id は `sha256(JSON.stringify([NFKC正規化(pattern), NFKC正規化(route)])).slice(0,16)` で、
`~/.claude/handoff-audit-nightly-ledger.jsonl` の 1 行に一致することを実測で確認した（再現手順は §5）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

## 結論（3行）

1. **再発していない。** 窓 2026-09-27T18:00:22Z〜2026-09-30 03:45 JST で、同型 handoff は transcript 走査 **0 件**
   （台帳3種の block も 0 件）。ただし「0 件」を主張する前に**検出器の検出力を対照群で測り**、
   既知陽性 4/4 を捕捉できることを確認してある（§1.1）。
2. **記録された再発防止経路 `gh pr create` は本 PC では実行できない。** `gh auth status`=未ログイン、
   `%APPDATA%\GitHub CLI` も `~/.config/gh` も無し、keyserve 配布ファイル一覧にも GitHub トークン無し（§2）。
   一方 **`git push` は通る**（credential.helper=manager。`origin/auto/20260926-0dec-verify` が origin に存在）。
   つまり「コミットを kim に聞く」を消す経路は `gh pr create` ではなく **`git commit` + `git push`** で足りる。
3. **ただし根本状態は残っている。** 元の違反の対象だった ¥1,000 直前埋めの変更
   （`gas/PaceAdjuster.gs` / `test/pace_adjuster.test.mjs` / `config/pricing-decisions.json`）は
   **2026-09-30 時点でも未コミットのまま** nf-minpaku-automation の作業ツリーに残っている（§3）。
   さらに「コミットを次セッションへ先送りする」近縁形が窓内に 2 件（user へは投げていない）（§1.4）。

---

## 1. 実測

窓 = `2026-09-27T18:00:22Z`（nightly が session 6c7dca27 を block し、この pattern を high で昇格した時刻）
〜 `2026-09-30 03:45 JST`。

### 1.1 先に検出器の検出力を測った（対照群）

「0 件」は検出器が空振りしていても出る。そこで**窓より前の既知陽性**に同じ検出器を当てた。

| 検出器 | 既知陽性（窓より前） | 捕捉 |
|---|---|---|
| 狭（コミット語 + kim への問い） | 6c7dca27（09-24 23:54Z / 09-25 10:04Z / 09-27 02:32Z）・76f2f1da（09-24 09:00Z） | **4/4** |
| 広（本番反映済み×未コミットの記述 + 何らかの依頼） | 上記4件 + 2c5727ec（09-28・TODO 文の引用＝偽陽性1） | 5件中 真陽性4 |

狭い検出器（`コミット` の近傍 40 字に `してよい|可否|許可|承認|判断|返信|確認` 等があり、
かつ `次に kim がすること|確認してください|返信してください` 等の依頼形を伴う assistant テキスト）で
**既知陽性を落とさない**ことを確認した上で、窓に当てている。

### 1.2 transcript 走査（一次資料）

`~/.claude/projects/**/*.jsonl` のうち mtime が窓内の **14 本**（自セッションを除く）を全行走査。

| 検出器 | 走査本数 | ヒット | 中身 |
|---|---|---|---|
| 狭 | 14 | **0** | — |
| 広 | 14 | 1 | 2c5727ec 2026-09-28T18:32:53Z「次セッションが `~/.claude/next-session.md` の残TODO先頭（`[handoff-audit:41e82bee49909aea]` 本番反映済みだが git 未コミットの変更）から…」＝ **TODO 文をそのまま引用しただけ**で、同じメッセージの `次に kim がすること:` は「なし」。偽陽性 |

### 1.3 台帳走査（三次資料・横断）

| 台帳 | 窓内の行 | `コミット` を含む行 | block / retry-cap | 同型 handoff |
|---|---:|---:|---:|---:|
| `~/.claude/handoff-audit-ledger.jsonl` | 14 | 5 | 0 | **0** |
| `~/.claude/stop-gate-runner-ledger.jsonl` | 27 | 5 | 14 | **0**（14 件はすべて別 pattern: 外部状態断定 / セッション無効 / 停止フック再入） |
| `~/.claude/handoff-audit-nightly-ledger.jsonl` | 4 | 1 | 4 | **0**（唯一の `コミット` 行は 2026-09-27T18:00:22Z の**修正点そのもの**＝元の違反） |

**窓の外に母集団を広げると**（上限制なし・09-23 以降）: transcript で 5 件ヒットし、
うち 4 件が 09-24〜09-27 の既知陽性、残り 1 件が上記の偽陽性。
＝ **修正点より後に生まれた同型 handoff は 0 件**（[[feedback_evidence_must_postdate_the_fix]] の条件を満たす）。

### 1.4 近縁形（別 pattern・user へは投げていない）

根は同じ「コミットを着地させずに後に回す」だが、**kim への判断依頼にはなっていない**ものが 2 件。

| 日時 | session | 文言（抜粋） | 判定 |
|---|---|---|---|
| 2026-09-28T18:12Z | a7b45b5e | 「`analysis/0ota/2026-09-27/result.md` の追記と新規スクショ2枚は未コミットのまま残しています。次セッションで…」／`次に kim がすること: 操作は不要です` | user 依頼なし・**先送り** |
| 2026-09-29T18:04Z | 56b30f70 | 「`analysis/0dec/result-2026-09-25.md` の §(j) は未コミットのため、次セッションで main 着地（残TODO）を実施」 | user 依頼なし・**先送り** |

rule 1（user の手作業は最上位のコスト）に対しては**違反していない**。
ただし [[feedback_evidence_must_postdate_the_fix]] の隣にある「恒久修正を設計のみで次セッションへ送る」と同じ型なので、
knowledge の route には併読先として書いた。

## 2. 再発防止経路 `gh pr create` の実行可能性（実測）

| 経路 | 実測 | 可否 |
|---|---|---|
| `gh auth status` | `You are not logged into any GitHub hosts.` | ✗ |
| `gh api user` | `please run: gh auth login` | ✗ |
| `%APPDATA%\GitHub CLI`（hosts.yml） | ディレクトリ自体が無い | ✗ |
| `~/.config/gh` | 無い | ✗ |
| keyserve 配布一覧（`tools/keyserve-status.mjs`） | kimi/groq/openrouter/mistral/deepseek/xai/makimono-feedback/anthropic/fleet-sheet/cost-reporter/discord-bot/keyserve の12件のみ。GitHub 無し | ✗ |
| `git push`（credential.helper=manager） | `origin/auto/20260926-0dec-verify` が origin に存在＝push 実績あり | **○** |
| 本 PR の作成 | 上記 git push で branch を上げ、`gh pr create` が未認証で失敗することを実測（§5） | ✗ |

**結論**: 本 PC では「コミットして PR を出す」のうち **PR 作成だけが塞がっている**。
`git commit` + `git push` は塞がっていないので、**コミットを kim に聞く必要は一切ない**。
PR が要る場合のみ `tools/gh-login.cmd`（デバイスコード方式）を **kim が1回**通せば以後は自動化できる（提案であって今回の依頼ではない）。

## 3. 残存リスク: 元の違反対象が今も未コミット

元の違反（2026-09-24〜09-27、session 6c7dca27）が本番反映済みのまま残していた 3 ファイルは、
**2026-09-30 03:40 JST 時点で nf-minpaku-automation の作業ツリーに未コミットで残っている**。

```
$ git -C C:/Users/kimko/nf-minpaku-automation status --porcelain -- gas/PaceAdjuster.gs test/pace_adjuster.test.mjs config/pricing-decisions.json
 M config/pricing-decisions.json
 M gas/PaceAdjuster.gs
 M test/pace_adjuster.test.mjs
$ git diff --stat -- gas/PaceAdjuster.gs test/pace_adjuster.test.mjs config/pricing-decisions.json
 149 insertions(+), 8 deletions(-)   # getNearTermFill / nearTermFillPrice=1000 / nearTermFillMaxLeadDays=13
```

これらは**現在も別セッションが使用中のブランチ `auto/20260926-0dec-verify` の作業ツリー**にある
（本セッションは読み取りのみ。他セッションの未コミット差分を勝手にコミットしない —
`git add -A` 禁止の規約と同じ理由）。**したがって §3 は「本セッションでは直さない」が、
状態としては『本番反映済み・git 未コミット』が今も存在する**と記録する。
担当は当該ブランチのセッション。判断材料として、この 3 ファイルは `git diff` の内容が
`nearTermFillPrice=1000`（kim 決定 2026-09-25）と一致しており、**作業途中ではなく完成形**である。

## 4. 恒久策（本 PR で実施）

- `tools/handoff-audit-knowledge.json` に当該 pattern を追加。route は
  **`gh pr create` ではなく `git commit` + `git push`** を主経路として書き、
  「本番反映済みの変更を未コミットで残すと他セッションの再デプロイで消える」実害と、
  gh が塞がっている事実・`tools/gh-login.cmd` が唯一の人手点であることを明記。
- 併せて近縁形（未コミットのまま次セッションへ送る）を併読先として参照。

これにより、夜間監査が同型の learned を再び high で昇格させたとき、
`knownRoutes` に `git commit` 系の route が入り、**昇格先が実行可能な経路**になる。

## 5. 再現コマンド

```bash
# id → pattern/route の逆引き
node -e "const fs=require('fs'),{createHash}=require('crypto');const key=v=>String(v).normalize('NFKC').trim().replace(/\s+/g,' ');const h=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');for(const f of ['C:/Users/kimko/.claude/handoff-audit-ledger.jsonl','C:/Users/kimko/.claude/handoff-audit-nightly-ledger.jsonl'])for(const l of fs.readFileSync(f,'utf8').split(/\r?\n/)){if(!l.trim())continue;let o;try{o=JSON.parse(l)}catch{continue}for(const x of (o.learned||[]))if(h([key(x.pattern),key(x.route)]).slice(0,16)==='41e82bee49909aea')console.log(o.ts,o.verdict,x)}"

# transcript 走査（検出力の対照群つき）
node ~/.claude/auto-session/scan-handoff-commit-v2.mjs "2026-09-23T00:00:00Z" "" broad   # 既知陽性 4 を捕捉できること
node ~/.claude/auto-session/scan-handoff-commit-v2.mjs "2026-09-27T18:00:22Z" "" broad   # 窓内 = 偽陽性1・同型0

# gh の実行可否
gh auth status ; ls "$APPDATA/GitHub CLI" ; node tools/keyserve-status.mjs
```

## 次に kim がすること: なし

（`gh` を使った PR 作成を今後も自動で回したい場合のみ、`tools/gh-login.cmd` を1回実行する選択肢がある。
 急ぎではないため今回は依頼しない。）
