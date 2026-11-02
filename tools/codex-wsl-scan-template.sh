#!/usr/bin/env bash
#===============================================================================
# codex-wsl-scan-template.sh — Codex(WSL) 向け検証コマンド委譲テンプレート
#
# 目的:
#   Codex(WSL) に台帳スキャン等の検証コマンドを委譲する際、
#   WSL 側の古い node ではなく win32 node を使い、かつ HOME を Windows 側に向ける。
#
# 使用方法:
#   source tools/codex-wsl-scan-template.sh   # 変数定義のみ（source）
#   bash codex-wsl-scan-template.sh           # 単体実行（使用例を表示）
#
# 環境変数:
#   CODEX_WSL_NODE    — win32 node への絶対パス
#                       （既定: /mnt/c/Program Files/nodejs/node.exe）
#   CODEX_WSL_HOME    — HOME 上書き値
#                       （既定: /mnt/c/Users/kimko）
#   CODEX_IS_WSL      — 0: 非 WSL（通常 node を使用）
#                        1: WSL（明示指定）
#                        未設定: 自動判定（uname -a で microsoft の有無）
#
# 判明している絶対パス:
#   Windows:          C:\Program Files\nodejs\node.exe
#   WSL マウント経由: /mnt/c/Program Files/nodejs/node.exe
#   Git Bash:         /c/Program Files/nodejs/node
#   WSL 内 node:      /usr/bin/node (v22.23.3 — 古い・使用不可)
#
# 関連 memory:
#   feedback_codex_wsl_scan_needs_home_env.md
#     - Codex(WSL) に台帳スキャン等を委譲するとき HOME=/mnt/c/Users/kimko を
#       付けないと、WSL の home を見て total=0 になり『ヒット0』の偽陰性になる
#     - tools/permanent-fix-deferral-scan.mjs の main() は scan() に home を
#       渡さず os.homedir() を使う
#     - total が 0 なのに hits=0 は「クリーン」ではなく「読めていない」
#===============================================================================

# --- 既定値の設定 ------------------------------------------------------------
# 利用側で上書き可能

: "${CODEX_WSL_NODE:=/mnt/c/Program\ Files/nodejs/node.exe}"
: "${CODEX_WSL_HOME:=/mnt/c/Users/kimko}"

# --- WSL 判定 ----------------------------------------------------------------
# CODEX_IS_WSL が明示されていなければ自動判定

if [ -z "${CODEX_IS_WSL+x}" ]; then
    if uname -a 2>/dev/null | grep -qi microsoft; then
        CODEX_IS_WSL=1
    else
        CODEX_IS_WSL=0
    fi
fi

# --- node 解決 ---------------------------------------------------------------
# 結果を NODE_CMD に設定

if [ "$CODEX_IS_WSL" = "1" ]; then
    # WSL モード: スペースを含むパスを適切に処理
    # shellcheck disable=SC2088  (展開順序により正しく動作)
    NODE_CMD="$CODEX_WSL_NODE"
    # ノート: 実行時は変数経由で呼び出す（直接展開防止）
else
    # 非 WSL モード: 通常の node を使用
    NODE_CMD="node"
fi

# --- ヘルパー: node 実行 -----------------------------------------------------
# 使用例:
#   wsl_node your-script.mjs [引数...]
#
# 呼び出し側で source した後、以下のように使う:
#
#   if [ "$CODEX_IS_WSL" = "1" ]; then
#       HOME="$CODEX_WSL_HOME" "$NODE_CMD" tools/permanent-fix-deferral-scan.mjs
#   else
#       node tools/permanent-fix-deferral-scan.mjs
#   fi
#
# =============================================================================
# 【重要】HOME が正しく設定されないと total=0 の偽陰性になる
#
# Codex(WSL) 実行では WSL ユーザーの home（例 /home/<user>）を見るため、
# ~/.claude/*ledger.jsonl が存在せず total=0 / hits=0 を静かに返す。
# total が 0 なのに hits=0 は「クリーン」ではなく「読めていない」。
#
# 【確認手順】
# 結果の出力中から以下のような total 行を探し、0 でないことを確認すること:
#
#   total=42, hits=3, ...   ← OK: 読み取れている
#   total=0, hits=0, ...    ← NG: 読めていない（HOME 設定を要確認）
# =============================================================================

# --- 単体実行時: 使用例の表示 ------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    echo "=== codex-wsl-scan-template.sh ==="
    echo ""
    echo "CODEX_IS_WSL=$CODEX_IS_WSL"
    echo "CODEX_WSL_NODE=$CODEX_WSL_NODE"
    echo "CODEX_WSL_HOME=$CODEX_WSL_HOME"
    echo "NODE_CMD=$NODE_CMD"
    echo ""
    echo "使用例（source して利用）:"
    echo ""
    echo "  # 1. テンプレートを読み込む"
    echo "  source tools/codex-wsl-scan-template.sh"
    echo ""
    echo "  # 2. 環境変数を必要に応じて上書き"
    echo "  # CODEX_WSL_NODE=/mnt/c/Program\\ Files/nodejs/node.exe"
    echo "  # CODEX_WSL_HOME=/mnt/c/Users/kimko"
    echo ""
    echo "  # 3a. WSL モード: HOME を Windows 側に設定して win32 node を実行"
    echo "  if [ \"\$CODEX_IS_WSL\" = \"1\" ]; then"
    echo "      HOME=\"\$CODEX_WSL_HOME\" \"\$NODE_CMD\" tools/permanent-fix-deferral-scan.mjs"
    echo "  fi"
    echo ""
    echo "  # 3b. 非 WSL モード: 通常の node で実行"
    echo "  if [ \"\$CODEX_IS_WSL\" = \"0\" ]; then"
    echo "      node tools/permanent-fix-deferral-scan.mjs"
    echo "  fi"
    echo ""
    echo "  # 4. 結果の total 行が 0 でないことを確認"
    echo "  #    grep total= で該当行を抽出"
    echo ""
    echo "台帳スキャン固有の例（nf-minpaku-automation リポジトリ）:"
    echo ""
    echo "  cd /path/to/nf-minpaku-automation"
    echo "  source /path/to/tools/codex-wsl-scan-template.sh"
    echo "  CODEX_IS_WSL=1 \\"
    echo "    HOME=\"\$CODEX_WSL_HOME\" \\"
    echo "    \"\$CODEX_WSL_NODE\" tools/permanent-fix-deferral-scan.mjs"
    echo ""
fi