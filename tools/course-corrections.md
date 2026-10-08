# 軌道修正台帳

既存項目は削除せず、新しい指摘を末尾に追加する。

## CC-001 (2026-10-08) 他AIレーンの失敗を放置して Claude 本体に戻す

- 指摘: kim「他AIが使えないままなら、その問題の解決を先にその場でやれ」。他AIの不調を放置し、高額な Claude 本体へ戻ると user の費用を犠牲にする。
- 規則: 他AIの失敗・demote・cooldown を放置して Fable/Opus 本体で作業を続けない。
- 検出: lane-abandonment-gate / course-correction-gate / handoff-audit-gate rule 13。
- 修復: node tools/lane-doctor.mjs --probe で復旧し、生存レーンへ委譲する。全滅を30分以内の probe で確認した場合だけ Sonnet に渡し、本文に [LANE-FALLBACK] と理由を記載する。支払い等の本人操作は provider ごと24時間に1回だけ通知し、オートチャージ ON を勧める。

## CC-002 (2026-10-08) 到達確認していない URL を kim に渡した（AI Studio 課金 URL が 404）。監査が到達確認を求めたのに文言の書き換えで済ませた

- 指摘: 到達確認していない URL を kim に渡した（AI Studio 課金 URL が 404）。監査が到達確認を求めたのに文言の書き換えで済ませた
- 規則: kim に渡す URL は、当ターンに WebFetch/curl で到達確認した URL か、公式ドキュメントに記載された URL だけ。記憶からの URL 生成は禁止。監査（rule 12）が到達確認を求めたら文言変更で逃げず実際に確認する
- 検出: course-correction-gate / course-correction-gate
- 修復: WebFetch か curl で到達確認し、404/ログイン以外の到達結果を得てから提示。公式 doc 記載なら doc URL を根拠として併記
