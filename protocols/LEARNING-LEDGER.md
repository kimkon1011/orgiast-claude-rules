# LEARNING LEDGER

## 正本
台帳の正本は新規台帳ファイルではなく、既存memoryのfrontmatterとする。

`metadata`へ次を追加する。

- `count`: 発生回数の整数。省略時1。
- `status`: `ACTIVE|PROMOTE|PROMOTED|ARCHIVED`。省略時`ACTIVE`。
- `promoted_to`: 昇格先。
- `promoted_at`: 昇格日。
- `critical`: `true`なら1回目で`PROMOTE`。

## 3回ルール
`count >= 3`で`PROMOTE`。データ消失・バックアップ不全・セキュリティ・権限事故・誤送信・不可逆操作・金銭損失は`critical: true`とし、1回目で`PROMOTE`。

## PROMOTION HIERARCHY
下ほど強い。可能な限り「覚えて守る」より「守らないと通らない」を選ぶ。

1. memory
2. CLAUDE.md / ONBOARDING
3. Procedure / Checklist / Template
4. Skill / Agent
5. Hook / Validator / Test
6. Script / Automation
7. System Constraint（permission）

## PROMOTION DECISION
- LEARNING:
- ROOT CAUSE:
- CURRENT CONTROL:
- CAN MACHINE DETECT?:
- CAN MACHINE PREVENT?:
- PROMOTION TARGET:
- IMPLEMENTATION:
- VERIFICATION:
- ROLLBACK:

## 完了条件
昇格後は`status: PROMOTED`、`promoted_to`、`promoted_at`を記録する。仕組みで完全に防げる場合は本文の注意書きを1行へ縮め、索引を肥大化させない。

「提案した」は完了ではない。DESIGN → IMPLEMENT → TEST → REVIEW → ACTIVATEまで実行する。実装できない時だけ理由と次アクションを返す。

## 自動ロード層の規律
常時ロードされる`## 常に効くルール`は20行以内を目安とし、増やす時は1行減らす。
`PROMOTED` / `ARCHIVED`の学びは常時ロードから外し、`index/<domain>.md`の1行だけ残す。仕組みが守るものを毎回読ませない。
`--list`の`自動ロード層`が90%を超えたらsession-closeの報告に1行載せ、次セッションの目的候補へ「常時ロード層の整理」を足す。
`MEMORY.md`はharness管理のため、台帳ツールから書き換えない。

## コマンド
- 一覧とキュー更新: `node tools/learning-ledger.mjs --list --queue-out ~/.claude/promotion-queue.md`
- 再発記録: `node tools/learning-ledger.mjs --bump <memory.md>`
- 重大事故: `node tools/learning-ledger.mjs --bump <memory.md> --critical`

出典: AI廃人部 第3回オフ会（2026-09-16）司令塔型 AI-OS プロトコル（著者: ふみちゃん＝多動な廃人掃除屋）
