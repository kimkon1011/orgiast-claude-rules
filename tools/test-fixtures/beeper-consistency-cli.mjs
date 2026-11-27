// 既存CLI回帰テスト専用。新ゲートは別の統合テストで実検査し、ここでは依存を注入する。
import { main } from '../beeper-send.mjs';
process.exitCode=await main(process.argv.slice(2),{consistencyCheck:async()=>({ok:true}),cleanup:async()=>({ok:true})});
