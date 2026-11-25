# DEC-0001: 司令塔型プロトコルの差分導入

## decision_id
DEC-0001

## date
2026-09-17

## status(ACTIVE|SUPERSEDED)
ACTIVE

## project
Claude Code 共通ルール

## QUESTION
外部共有された司令塔 AI-OS 一式をそのまま導入するか、差分だけ取り込むか。

## CONTEXT
当社には§1.18の監督/実行レーン分離、session-close/start skill、memory索引、deploy-verifyが既にあり、司令塔/実行役分離・モデルルーティング・人間ループ外を満たしている。
memoryは600件超あるが、再発回数も昇格判定もなく「注意事項」として溜まるだけだった。
外部資料は`AI-OS/`ディレクトリ一式（CLAUDE.md / active-learning / learning-ledger / protocols / decisions）を新設する前提で書かれている。

## OPTIONS
- (a) 一式を新ディレクトリ `AI-OS/` として導入
- (b) 未導入4要素だけ既存skill/toolsに後付け
- (c) 導入しない

## DECISION
(b) 未導入4要素だけ既存skill/toolsに後付けする。

## WHY
司令塔/実行役分離・モデルルーティング・session-close/start・母数照合の思想は既に存在する。二重正本を作ると「どこが正本か分からない」構造になり、当該プロトコル自身の原則に反する。

## TRADE-OFF
一式導入なら他社と同じ語彙で会話できる利点を捨てる。

## ASSUMPTIONS
- memory frontmatterに任意フィールドを足してもharnessが壊さない。
- session-closeが毎セッション実行されている。

## REVERSIBILITY(REVERSIBLE|PARTIALLY_REVERSIBLE|IRREVERSIBLE)
REVERSIBLE。`protocols/`と`tools/learning-ledger.mjs`を削除し、skillの追記節を戻せば元に戻る。

## REVISIT_TRIGGER
- memory件数が1,500を超える。
- PROMOTE判定が月10件を超えて処理が追いつかない。
- harnessがfrontmatterを検証し始めた。

## RELATED
- 出典: AI廃人部 2026-09-16 第3回オフ会資料（著者: ふみちゃん＝多動な廃人掃除屋）
