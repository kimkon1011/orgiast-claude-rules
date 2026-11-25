# ラハイナ minimal tier のクライアント対応

サーバーが `tier=minimal` を返した場合、onboarding-sync は受領したファイル名と
tier だけを `.keys-sync-state.json` に保存する。鍵の値は receipt に含めない。
欠落検査はサーバーが宣言したファイルだけを対象にする。

minimal の配布・収束検査対象は `deepseek.env`、`openrouter.env` と
継続同期用のPC専用 `keyserve.env`。manifest の他の鍵は未配布でも異常としない。
fleet-selfcheck は case-handoff / Gmail / Drive / Discord / LINE を「対象外」とする。
lane-doctor は Codex（ChatGPT ログイン）/ DeepSeek / OpenRouter を対象にし、
対象外レーンの古い失敗履歴を再 probe・通知・修復ゲートの根拠にしない。
対象レーンの実際の障害は従来どおり修復対象。
pretooluse-lane-guard の通常の実装委譲ルールは保持し、codex-do / llm-ask の呼び出しが通る。

サーバー応答に tier がない既存PCは ai と扱う。minimal から未登録に変更された場合も
次回成功応答で ai に戻る。クライアント receipt は診断用であり、アクセス権の根拠は
サーバーの `ORGIAST_PC_TIERS_JSON` と認証結果である。

## kim 承認後に監督が行う本番手順

1. クライアントと [orgiast-keyserve PR #12](https://github.com/kimkon1011/orgiast-keyserve/pull/12) の
   対応PRをレビュー・マージし、クライアント導入元を更新する。
2. Vercel production の `ORGIAST_PC_TIERS_JSON` は既存PCの項目を維持したまま、
   次の2項目を追加する。下記は値の形のみで、秘密値を含まない。

   ```json
   {"lahaina-2018":"minimal","lahaina-office":"minimal"}
   ```

3. サーバーの minimal コードと環境変数を揃えて本番反映した後に、対象PC用の
   enroll トークンを発行し `tools/install-orgiast.ps1 -Enroll <token>` で導入する。
   コードまたは設定が片方だけの段階で enroll しない。
4. ファイル名3件、tier、PC名、lane-doctor の結果を値なしで確認する。
   Codex の ChatGPT ログインは鍵配布とは別に対象アカウントで行う。

この変更は既存鍵を削除・失効しない。既に全社鍵を取得したPCの権限回収や
別サービスのプロキシ認可は別途対応が必要。実機のインストール・本番疎通は
このPRでは行わず、ダミー鍵と一時ホーム・localhostでテストする。
