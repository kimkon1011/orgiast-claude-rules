# Linux 移植 棚卸し

| 項目 | 今回 | 事前調査 | 差分 |
| --- | ---: | ---: | ---: |
| ps1Total | 60 | 78 | -18 |
| hooksTotal | 1 | 71 | -70 |
| pwshHooksTotal | 0 | 19 | -19 |
| hardcodedPathFiles | 80 | 55 | +25 |
| hardcodedPathLines | 193 | 336 | -143 |
| distributionHooksTotal | 52 | - | - |
| distributionPwshHooksTotal | 0 | 19 (実PC) | - |

事前調査は ~/.claude 配布ツリーも含む範囲、本ツールはリポジトリ root（または --root）を走査するため一致しません。
直書きは C:\Users\・C:/Users/・H:\ のいずれかを含む行を数え、文書・テストも含めます（事前調査は C:\Users が対象）。

register-*.ps1: 31

| Windows 固有呼出し | 出現数 |
| --- | ---: |
| taskkill | 10 |
| schtasks | 27 |
| reg query | 3 |
| Get-ItemProperty | 5 |
| Start-Process | 21 |

集計方法: hooks 配下の実行定義を JSON 構造で数えます。呼出しはコメント・文書内も含む文字列出現数です。
.git、node_modules、.cache、シンボリックリンク、バイナリ、本ツールの生成レポートとベースラインは除外します。日時・絶対ルートは記録しません。
