# auto-progress 無人再開の社外送信事故防止

## 真因

既存の送信承認 hook は Gmail だけを対象にし、LINE 送信 CLI を検査していなかった。さらに auto-progress の headless resume は、古い `nextClaude` に残った送信約束を現在の本文承認と結び付けず実行でき、登録時にも送信語を拒否していなかった。

## 変更ファイル

- `tools/lib/send-approval.mjs`: 本文 SHA-256 と承認マーカーの共通検証
- `tools/mail-send-approval-gate.mjs`: 無人送信、LINE/Beeper/Discord DM、dry-run、対話直前承認の判定
- `tools/auto-progress.mjs`: 未承認の送信約束を登録時に拒否
- `tools/auto-progress-watch.mjs`, `tools/auto-session.mjs`: `ORGIAST_HEADLESS_JOB=auto-progress:*` を子プロセスへ明示
- `tools/*test.mjs`: 無人拒否、マーカー一致、本文改変拒否、dry-run、登録拒否の回帰テスト
- `tools/setup-manifest.json`: 配布 hook の説明更新
- `protocols/INCIDENT-TYPES.md`: 無人再開の古い送信約束実行型を追記

## PR

https://github.com/kimkon1011/orgiast-claude-rules/pull/1799

## テスト結果

- 主要回帰 90 件: pass 90 / fail 0
- `mail-send-approval-gate`: 無人 LINE 拒否、正しいマーカーで許可、本文変更で拒否、`--dry-run` 許可を確認
- LINE channel / Beeper / Discord DM: 無人環境で拒否を確認
- auto-progress: 送信を含む `nextClaude` のマーカーなし登録拒否を確認
- `git diff --check`: pass
- `setup.test.mjs`: runner の30秒上限までに出力された全ケース pass（suite 全体は時間上限で終了）
