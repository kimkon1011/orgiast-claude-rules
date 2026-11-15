# レーン事前確認（lane preflight）

目的: 「Fable は設計のみ、実装・量産は委譲」を守るため、着手前にレーンの生存を確認し、落ちていれば先に直す。

手順:
1. SessionStart の生存行を読む（例: codex ❌(probe_failed) glm ❌(usage_limit)）。
2. 主レーンが ❌ なら、理由別に対処する。
   - probe_failed（win32・WSL 無し）: codex-do に --allow-native を付けて 1 回実測する。通れば実装は進めてよい。lane-doctor の表示は PR で直す。
   - usage_limit: provider-cooldown.json の until まで待つか、implementOrder の次（deepseek / gemini-cli）を使う。
   - auth: codex login --device-auth（URL＋コード）を人に手渡す（これは例外として許容）。
3. 必要な連携（Gmail／Calendar／Discord／LINE／GAS）は、使う前に 1 回ずつ最小の読み取りで実測し、結果（可／reader のみ／未認証）を設計書か memory に書く。
4. 修復が Claude 側で完結しないものは、人にしかできない操作を 1 件だけ「何を・どこで・なぜ」で手渡す。2 件以上になるときは設計を変えて減らす。
5. 以上を終えるまで、Fable が実装・量産を肩代わりしない。

判定の記録: 応答冒頭の「[委譲判定]」行に、レーン生存の確認結果を 1 語添える（例: 実装=Codex（native 実測 OK））。
