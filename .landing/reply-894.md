PR #894 は既にマージ済みでした（追加の修正要望なし）。

- マージ: 2026-10-19 10:47Z（squash, seisaku-team-org）／マージコミット 9f47cc7ba59e6aebd050ca010476bf7b46523fe8
- CI: CI/test・test/test・test-posix・Auto merge の4件すべて SUCCESS
- main への反映: origin/main の祖先に 9f47cc7 があることを確認
- kim-PC の配布先（~/.claude/nightly-repo）: HEAD に 9f47cc7 を含む。tools/side-effect-left-gate.mjs の notice に「消してしまい|上書き…しまい|元に戻せない|復元できない」が入っていることを確認
- 他PC: fleet-status のビーコン（10/22 06:42 JST 時点）で kim-PC・kimko-PC・nishi-PC・作業用011・w018-PC・cafe015-PC の6台が 24h 以内に poll しているため、通常の converge で取り込まれます。ただしビーコンに commit 情報が無いため、PCごとの 9f47cc7 取り込みは未確認です（HP・作業用999 はビーコンなし、DESKTOP-BDOAK99 は 7日前で止まっています）。各PCで `git -C ~/.claude/nightly-repo merge-base --is-ancestor 9f47cc7 HEAD` を実行すれば確認できます。
