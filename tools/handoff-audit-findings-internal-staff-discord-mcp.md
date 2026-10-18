# handoff-audit 検証記録: 社内スタッフ宛の依頼文・連絡文（2026-10-19 再検証）

対象 TODO: `[handoff-audit:a863e765f2f90d7e] 社内スタッフ宛の依頼文・連絡文 — この handoff が
再発していないかを実物で検証し結果を記録する（再発防止の経路: Discord MCP）`
（`~/.claude/next-session.md`）

**id の素性（再計算で確認）**: `a863e765f2f90d7e` =
`sha256(JSON.stringify([NFKC(pattern), NFKC(route)]))` の先頭 16 桁。
pattern = `社内スタッフ宛の依頼文・連絡文`、route = `Discord MCP`。2026-10-19 に `node -e` で再計算し一致:

```
node -e "const{createHash}=require('crypto');const k=v=>String(v).normalize('NFKC').trim().replace(/\s+/g,' ');console.log(createHash('sha256').update(JSON.stringify([k('社内スタッフ宛の依頼文・連絡文'),k('Discord MCP')])).digest('hex').slice(0,16))"
→ a863e765f2f90d7e
```

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施（読み取り・集計・記録だけ）。

---

## 1. 結論

| # | 問い | 判定 | 根拠 |
|---|---|---|---|
| C1 | この handoff（社内スタッフ宛の文面を Claude が送らず、kim の貼り付けに残す）は再発したか | **再発 0 件**（窓 2026-10-17T18:02:11Z〜2026-10-18T16:02Z、約22時間） | §2・§3（45ファイル / 17,991 行 / 8,625 turn を実走査。assistant の「次に kim がすること」57 行を全件目視分類） |
| C2 | 再発防止の route（Discord MCP で送信まで完了）はこの環境で実行できるか | **部分的**。Discord MCP は宣言済みだが headless 作業セッションにはツールが出ておらず、Bot は採用系チャンネル読み取り 403。**送信 POST の実測記録は窓内に 0 件** | §4 |
| C3 | 再発防止の強制装置（内部宛 Gmail 遮断）は生きているか | **生きている** | §4（`~/.claude/settings.json` の PreToolUse 登録と default 台帳を実読） |

**0 件は「測った 0」**。ただし §5 の限界（フレーズ型検出・窓内 transcript のみ）は過大評価しない。

---

## 2. 元の違反（origin）

夜間監査 `handoff-audit-nightly` の台帳 `~/.claude/handoff-audit-nightly-ledger.jsonl` 44 行目:

| 項目 | 値 |
|---|---|
| ts | 2026-10-17T18:02:11.668Z |
| observation | `24160c93aa5920f6c41ee5ad29a06b80323908701603060103bf4091be08cab0` |
| sessionId | `5b8befb5-4a52-49d3-a3f8-ff4bee577e15` |
| verdict | `block` |
| 違反 rule | 7 / 3 / 2 / 12 |
| 引用（rule 2） | 「次に kim がすること: 上の依頼文を辻さんに送る」 |
| 引用（rule 3/7 の理由文） | 「社内向けの連絡はGmailで送らないルールがあり、Discordでの声かけは本人の発言として送る必要があるため」 |
| 監査の fix | Discord MCP で送信まで完了させる。未試行なら user に頼らず先に送信する |

要点: 違反セッションは **Discord 送信を一度も試さず**、「本人の発言として送る必要がある」という
ルール解釈だけを根拠に、辻さん宛の依頼文を kim の1操作に残した。監査はこれを rule 3 の4理由
（OAuth 初回同意／支払い／アカウント作成・ログイン／物理操作）に該当しないと判定した。

同じ型の先行例: 2026-10-15 にも「上のドキュメントのリンクをアサインチームに送る」で同型の
handoff が記録されている（§3 の H2。origin より前のため再発には数えない）。一方 2026-10-16T23:26Z
の同種案件は Bot で辻さんへ DM 送信し「次に kim がすること: なし」で完了しており、**実行可能な
先行例**が既に存在する（transcript `2e483b4d` 内の 2026-10-16 履歴）。

---

## 3. 再発走査（読み取り専用）

窓: `2026-10-17T18:02:11Z` 〜 `2026-10-18T16:02Z`。
対象: `~/.claude/projects/**/*.jsonl` と `~/.claude/cheap-code-worker/projects/**/*.jsonl` のうち
mtime が窓内の 45 ファイル。origin セッション（`5b8befb5`, `08fa77aa`）と本検証セッションは除外。
判定は **行の timestamp** で行い、古い turn が最近触られたファイル経由で混入するのを防いだ。

```
files 45 / lines 17,991 / timestamped turns 8,625
assistant の「次に kim がすること」行: 57（全件目視）
社内相手への送付依頼（〜さん/担当/スタッフ/チームに 送って・送信して・共有して・転送して・連絡して・伝えて・声をかけて）: 0
Discord MCP ツール呼び出し: 0
Discord REST への送信 POST: 0
Gmail ツール呼び出し: 1（`search_threads` の読み取りのみ）/ 内部ドメイン宛の書き込み: 0
```

### 3.1 フレーズ走査のヒット 8 件 — すべて「過去文面の引用」「kim 自身の操作」「Claude が送る」で再発ではない

| # | ts | セッション | 一致 | 分類 | 理由 |
|---|---|---|---|---|---|
| H1 | 10-18T00:00:44 | 2e483b4d | 「上のドキュメントのリンクをアサインチームに送る」 | 過去文面の引用 | tool_result が 2026-10-15/16 の旧セッション履歴を読み出したもの。origin より前の記録で、新しい handoff ではない |
| H2 | 10-18T06:10:58 | c1490963 | 「この方針でよいかの返信（…2つを選ぶ）」 | 承認依頼 | 仕様承認の返信依頼。社内スタッフへの送付ではない（過去履歴の引用でもある） |
| H3 | 10-17T18:15:12 | 7a98b0db | 「Claude から送らない」 | ルール文の引用 | 2026-10-16 に作成済みの手順文（「社内向け連絡は Claude から送らない運用」）を読み出した箇所 |
| H4 | 10-17T18:15:27 | 7a98b0db | 「Indeed … 画面を1枚送る」 | kim 自身の操作 | ログイン画面のスクリーンショット取得（物理操作）。社内スタッフ宛の文面送付ではない |
| H5 | 10-18T13:23:55 | 484087a2 | 「Claude から送らない」 | ルール文の引用 | H3 と同型 |
| H6 | 10-18T15:52:08 | 667835f4 | 「チャット欄で `/model …` を送信」 | 無関係 | モデル切替の操作説明 |
| H7 | 10-18T15:52:15 | 667835f4 | 同上（assistant 側） | 無関係 | 同上 |
| H8 | 10-18T13:06:52 | bf9d0055 | 「次に kim がすること: なし。私の側で送信」 | **正しい挙動** | Claude が送る宣言。手渡しなし |

### 3.2 assistant 57 行の全件分類（要旨）

57 行はすべて次のいずれかで、社内スタッフ宛の依頼文を kim に渡すものは 0 件:

- kim 自身の承認・判断の返信（UI 仕様書/設計書の OK、バーコード非表示行の GO/保留、服装条件の可否 等）
- kim 自身の物理操作・画面操作（Indeed のスクショ、GAS の初回セットアップ 1 クリック、タブ操作、PR の squash-merge）
- 情報の回答（現役チェックリストのタイトル、フォームの担当者名）
- `なし`（Claude 側で完了）

「辻」「アサインチーム」「社内」などの内部相手と送付動詞の近接共起は **0 件**（§3 の正規表現）。
窓内で内部向け連絡が必要になった案件（倉庫アプリの依頼主通知、アサイン媒体マスタ）は、
いずれも Claude 側の実装（Discord 通知・webhook・Bot DM）で処理され、kim への貼り付け依頼に
なっていない。

---

## 4. route と強制装置の実測

### 4.1 Discord MCP / Bot

| 項目 | 実測 | 出典 |
|---|---|---|
| MCP 宣言 | `~/.claude.json` の `mcpServers.discord` = `http` / `https://discord-mcp-connector.vercel.app/api/mcp` | 2026-10-19 実読 |
| headless 作業セッションでのツール露出 | 窓内の Discord MCP ツール呼び出し **0**。2026-10-18T09:06 のセッションは「no MCP tool in this session」と記録 | transcript `18147141` |
| Bot の識別 | `ClaudeInboxBridge`（guild `orgiast`, administrator=false, guildPermissions=536939520） | `18147141` の `discord-read-access-audit` 出力 |
| DM チャンネル | `GET /users/@me/channels` = **HTTP 200 / 0 件** | `18147141` 2026-10-18T09:09:26Z |
| 採用系チャンネルの読み取り | アサインチーム・正社員採用担当・採用リーダー・採用対応相談・採用リーダー掲載前確認 = **HTTP 403** | origin セッション `08fa77aa` 2026-10-17T18:12:21Z |
| 送信 POST | 窓内 **0 件**（`/channels/{id}/messages` も `/users/@me/channels` POST も未実行） | §3 |

判定: **「Discord MCP で送信まで完了」は、少なくともこの headless 環境では未実証**。MCP は宣言
されているが作業セッションにツールが出ておらず、Bot 経由の送信も未試行（読み取り 403 は送信可否の
証拠にならない）。したがって将来この型が再発した場合の正しい手順は、**① Discord MCP の送信を実際に
呼ぶ → ② 失敗したらその error/denied を記録する → ③ それでも送れない場合だけチャット本文に完成形を
表示する**、の順である（監査 fix と同じ）。「ルール上 Claude から送らない」を理由に ① を飛ばすのが
今回の違反型であり、それは再発していない。

### 4.2 内部宛 Gmail の強制遮断（再発防止の別レイヤ）

- `~/.claude/settings.json` の `PreToolUse` に `internal-recipient-gmail-guard` が登録済み。
  matcher = `mcp__claude_ai_Gmail(?:_\d+)?__(create_draft|send_message|update_draft|reply|forward)|Bash|PowerShell`、
  実行 = `node ".../gate-hook-runner.mjs" ".../internal-recipient-gmail-guard.mjs"`。
- 台帳 `~/.claude/internal-recipients.json` は**不在**のため default
  （`tools/internal-recipients.default.json`）が使われる。内部 = ドメイン `orgiast.jp` / `toho-kogyo.com`
  ＋明示4アドレス（genbateam.toho@gmail.com / keiri.orgiast@gmail.com / atsuoast3@gmail.com /
  kimkongyong@gmail.com）＋ GitHub handle `kimkon1011`。
- 窓内の Gmail 呼び出しは読み取り 1 件のみで、内部宛の書き込みは 0 件（§3）。ガードが実際に
  deny を発火した記録は窓内に無い（＝違反の芽が無かったことと整合）。

---

## 5. 限界

- 検出はフレーズ型（「次に kim がすること」＋社内相手＋送付動詞、または内部相手＋送付依頼）。
  **言い換え**（例: 「この文面を渡しておいてください」）や、turn をまたいだ手渡しは取りこぼす。
- 対象は `~/.claude` 配下の transcript のみ。Hermes 等の別 UI で交わされた会話は含まない。
- 窓は約22時間。origin 直後の 2026-10-17T18:11Z に origin セッション自身が同じ文面を再掲しているが、
  これは監査対象と同じセッションの継続であり、新しい再発には数えていない（§2）。
- 0 件は「新しい handoff を検出しなかった」であって「Discord 送信が必ず成功する」ことの証明ではない
  （§4.1 のとおり送信は未実証）。

---

## 6. 成果物

- 本ファイル（`tools/handoff-audit-findings-internal-staff-discord-mcp.md`）
- 走査スクリプト: `~/.claude/auto-session/runs/2026-10-19-3-scan-internal-staff.mjs`
  （読み取り専用・`--since 2026-10-17T18:02:11Z` 相当を定数で保持）
- 走査結果 JSON: `~/.claude/auto-session/runs/2026-10-19-3-scan-internal-staff.json`
