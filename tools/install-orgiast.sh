#!/bin/bash
# オージャスト共通ルール & コスト監視 macOS 一括インストーラ。sudo・gitは使わない。

ok() { echo "  [OK] $1"; }
warn() { echo "  [注意] $1"; }
step() { echo; echo "■ $1"; }
have() { command -v "$1" >/dev/null 2>&1; }

ORGIAST_USER_HOME="${ORGIAST_HOME:-$HOME}"
REPO="$ORGIAST_USER_HOME/orgiast-claude-rules"
CLAUDE_DIR="$ORGIAST_USER_HOME/.claude"
NODE_HOME="$ORGIAST_USER_HOME/.orgiast/node"
mkdir -p "$CLAUDE_DIR" "$ORGIAST_USER_HOME/.gemini" 2>/dev/null

LABEL="${ORGIAST_LABEL:-}"
if [ -z "$LABEL" ]; then LABEL="$(scutil --get ComputerName 2>/dev/null)"; fi
if [ -z "$LABEL" ]; then LABEL="$(hostname 2>/dev/null)"; fi

echo "============================================================"
echo " オージャスト Claude セットアップ (このMac: $LABEL)"
echo "============================================================"
echo "会社の共通ルール、コスト集計、委譲/テスト忘れ防止、Codex・Gemini連携を自動設定します。"
echo "※会話の中身は読みませんし送りません。送るのは数字の集計だけです。"

step "必要なツールの確認 (Node.js)"
if ! have node; then
  ARCH="$(uname -m)"
  case "$ARCH" in arm64) NODE_ARCH="arm64" ;; x86_64) NODE_ARCH="x64" ;; *) NODE_ARCH="" ;; esac
  if [ -n "$NODE_ARCH" ]; then
    TMP_NODE="$(mktemp -d 2>/dev/null)"
    SUMS="$TMP_NODE/SHASUMS256.txt"
    if curl -fsSL --retry 2 "https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt" -o "$SUMS"; then
      TARBALL="$(awk '/darwin-'"$NODE_ARCH"'\.tar\.gz$/ { print $2; exit }' "$SUMS")"
      if [ -n "$TARBALL" ] && curl -fsSL --retry 2 "https://nodejs.org/dist/latest-v20.x/$TARBALL" -o "$TMP_NODE/$TARBALL"; then
        rm -rf "$NODE_HOME.new" 2>/dev/null
        mkdir -p "$NODE_HOME.new"
        if tar -xzf "$TMP_NODE/$TARBALL" -C "$NODE_HOME.new" --strip-components=1; then
          rm -rf "$NODE_HOME" 2>/dev/null
          mv "$NODE_HOME.new" "$NODE_HOME"
          PATH_LINE='export PATH="$HOME/.orgiast/node/bin:$PATH"'
          if ! grep -Fqx "$PATH_LINE" "$ORGIAST_USER_HOME/.zshrc" 2>/dev/null; then printf '\n%s\n' "$PATH_LINE" >> "$ORGIAST_USER_HOME/.zshrc"; fi
          export PATH="$NODE_HOME/bin:$PATH"
        fi
      fi
    fi
    rm -rf "$TMP_NODE" 2>/dev/null
  fi
fi
if have node; then ok "Node.js あり ($(node -v))"; else warn "Node.js の導入に失敗。ネット接続/CPU種別を確認してください"; fi

step "共通ルール一式のダウンロード"
GOT_REPO=0
TRY=1
while [ "$TRY" -le 3 ] && [ "$GOT_REPO" -eq 0 ]; do
  TMP_REPO="$(mktemp -d 2>/dev/null)"
  if curl -fsSL --retry 2 "https://github.com/kimkon1011/orgiast-claude-rules/archive/refs/heads/main.zip" -o "$TMP_REPO/rules.zip" && unzip -q "$TMP_REPO/rules.zip" -d "$TMP_REPO"; then
    if [ -d "$TMP_REPO/orgiast-claude-rules-main/tools" ]; then
      rm -rf "$REPO.new" 2>/dev/null
      mv "$TMP_REPO/orgiast-claude-rules-main" "$REPO.new"
      if [ -d "$REPO" ]; then mv "$REPO" "$REPO.old-installer" 2>/dev/null; fi
      if mv "$REPO.new" "$REPO"; then rm -rf "$REPO.old-installer" 2>/dev/null; GOT_REPO=1; ok "ダウンロード完了(zip)"; else [ -d "$REPO.old-installer" ] && mv "$REPO.old-installer" "$REPO"; fi
    fi
  fi
  rm -rf "$TMP_REPO" 2>/dev/null
  [ "$GOT_REPO" -eq 0 ] && warn "zip取得失敗 (試行 $TRY/3)"
  TRY=$((TRY + 1))
done
[ "$GOT_REPO" -eq 0 ] && warn "共通ルールの取得に失敗。既存リポがあればそれを使って続行します"

write_env_if_missing() {
  FILE="$1"; VALUE="$2"; SUCCESS="$3"; MISSING="$4"
  if [ -f "$FILE" ]; then ok "既存(上書きしません): $FILE"; elif [ -n "$VALUE" ]; then printf '%s\n' "$VALUE" > "$FILE" && ok "$SUCCESS"; else warn "$MISSING"; fi
}
step "各種AI・コスト報告の設定"
if [ -f "$CLAUDE_DIR/cost-reporter.env" ]; then ok "コスト報告設定 既存(上書きしません)"; elif [ -n "${ORGIAST_WEBHOOK:-}" ]; then printf 'DISCORD_COST_WEBHOOK=%s\nREPORTER_LABEL=%s\n' "$ORGIAST_WEBHOOK" "$LABEL" > "$CLAUDE_DIR/cost-reporter.env"; ok "コスト報告設定を作成"; else warn "Discord webhook 未指定。コスト報告は送信されません"; fi
write_env_if_missing "$CLAUDE_DIR/manus.env" "${ORGIAST_MANUS_KEY:+MANUS_API_KEY=$ORGIAST_MANUS_KEY}" "Manusキー設定" "Manusキー未指定(他機能は動作)"
write_env_if_missing "$CLAUDE_DIR/deepseek.env" "${ORGIAST_DEEPSEEK_KEY:+DEEPSEEK_API_KEY=$ORGIAST_DEEPSEEK_KEY}" "DeepSeekキー設定" "DeepSeekキー未指定(他機能は動作)"
write_env_if_missing "$CLAUDE_DIR/xai.env" "${ORGIAST_GROK_KEY:+XAI_API_KEY=$ORGIAST_GROK_KEY}" "Grokキー設定" "Grokキー未指定(他機能は動作)"
write_env_if_missing "$CLAUDE_DIR/openrouter.env" "${ORGIAST_OPENROUTER_KEY:+OPENROUTER_API_KEY=$ORGIAST_OPENROUTER_KEY}" "OpenRouterキー設定" "OpenRouterキー未指定(他機能は動作)"
write_env_if_missing "$CLAUDE_DIR/groq.env" "${ORGIAST_GROQ_KEY:+GROQ_API_KEY=$ORGIAST_GROQ_KEY}" "Groqキー設定" "Groqキー未指定(他機能は動作)"
write_env_if_missing "$CLAUDE_DIR/mistral.env" "${ORGIAST_MISTRAL_KEY:+MISTRAL_API_KEY=$ORGIAST_MISTRAL_KEY}" "Mistralキー設定" "Mistralキー未指定(他機能は動作)"
write_env_if_missing "$CLAUDE_DIR/kimi-api.env" "${ORGIAST_KIMI_KEY:+MOONSHOT_API_KEY=$ORGIAST_KIMI_KEY}" "Kimi K3キー設定(中量級の生成/量産を別課金プールへ委譲可能に)" "Kimiキー未指定(他機能は動作)"
write_env_if_missing "$ORGIAST_USER_HOME/.gemini/.env" "${ORGIAST_GEMINI_KEY:+GEMINI_API_KEY=$ORGIAST_GEMINI_KEY
GEMINI_CLI_TRUST_WORKSPACE=true}" "Gemini APIキー(会社共有)を設定" "Geminiキー未指定(Gemini連携はキー設定まで使用不可)"

step "自動実行フックと Gemini MCP の登録"
if have node && [ -f "$REPO/tools/register-hooks.mjs" ]; then ORGIAST_HOME="$ORGIAST_USER_HOME" ORGIAST_REPO="$REPO" node "$REPO/tools/register-hooks.mjs" || warn "フック/MCP登録に失敗"; else warn "register-hooks.mjs または node が無いためスキップ"; fi

plist_install() {
  LABEL_ID="$1"; HOUR="$2"; MINUTE="$3"; SCRIPT="$4"; PLIST="$ORGIAST_USER_HOME/Library/LaunchAgents/$LABEL_ID.plist"
  mkdir -p "$ORGIAST_USER_HOME/Library/LaunchAgents"
  node - "$PLIST" "$LABEL_ID" "$HOUR" "$MINUTE" "$(command -v node)" "$SCRIPT" "$PATH" <<'NODE'
const fs=require('fs'); const [f,label,h,m,node,script,p]=process.argv.slice(2);
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${esc(label)}</string><key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(script)}</string></array><key>StartCalendarInterval</key><dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(p)}</string></dict></dict></plist>\n`);
NODE
  LAUNCH_DOMAIN="gui/$(id -u)"
  launchctl bootout "$LAUNCH_DOMAIN/$LABEL_ID" >/dev/null 2>&1 || true
  if launchctl bootstrap "$LAUNCH_DOMAIN" "$PLIST" >/dev/null 2>&1; then
    ok "$LABEL_ID 登録完了(毎日 $HOUR:$MINUTE)"
  else
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    if launchctl load "$PLIST" >/dev/null 2>&1; then ok "$LABEL_ID 登録完了(毎日 $HOUR:$MINUTE)"; else warn "$LABEL_ID の launchctl 登録に失敗"; fi
  fi
}
step "夜間バッチの定時起動を登録"
if have node && [ -f "$REPO/tools/batch-run.mjs" ]; then plist_install "jp.orgiast.nightly-batch" "3" "0" "$REPO/tools/batch-run.mjs"; else warn "batch-run.mjs が無いためスキップ"; fi
if [ -f "$REPO/tools/fleet-poller.mjs" ]; then plist_install "jp.orgiast.fleet-poller" "3" "15" "$REPO/tools/fleet-poller.mjs"; else warn "fleet-poller.mjs は現状無いため Mac では03:15登録をスキップ"; fi

step "Ollama(無料ローカルAI)"
warn "Ollama(無料ローカルAI)は Mac 版では未対応です。他は全部動きます"

npm_install_timeout() {
  PACKAGE="$1"; SECONDS_LIMIT="$2"
  npm i -g "$PACKAGE" --no-fund --no-audit & PID=$!
  ( sleep "$SECONDS_LIMIT"; kill "$PID" >/dev/null 2>&1 ) & WATCH=$!
  wait "$PID"; STATUS=$?; kill "$WATCH" >/dev/null 2>&1; wait "$WATCH" 2>/dev/null
  return "$STATUS"
}
npm_prefix_is_writable() {
  PREFIX_TO_CHECK="$1"
  [ -n "$PREFIX_TO_CHECK" ] && [ "$PREFIX_TO_CHECK" != "undefined" ] && [ -d "$PREFIX_TO_CHECK/lib/node_modules" ] && [ -w "$PREFIX_TO_CHECK/lib/node_modules" ]
}
use_npm_prefix() {
  NPM_HOME="$1"
  mkdir -p "$NPM_HOME" || return 1
  export PATH="$NPM_HOME/bin:$PATH"
  NPM_PATH_LINE="export PATH=\"$NPM_HOME/bin:\$PATH\""
  if ! grep -Fqx "$NPM_PATH_LINE" "$ORGIAST_USER_HOME/.zshrc" 2>/dev/null; then printf '\n%s\n' "$NPM_PATH_LINE" >> "$ORGIAST_USER_HOME/.zshrc"; fi
}
step "開発ツール Codex / Gemini の導入"
if have npm; then
  # npm は未設定でも /usr/local 等の既定値を返すため、設定の有無ではなく実際の書込権限で判定する。
  PREFIX_CUR="$(npm config get prefix 2>/dev/null)"
  NPM_PREFIX_SWITCHED=0
  if npm_prefix_is_writable "$PREFIX_CUR"; then
    NPM_HOME="$PREFIX_CUR"
  else
    NPM_HOME="$ORGIAST_USER_HOME/.orgiast/npm"
    mkdir -p "$NPM_HOME/lib/node_modules"
    npm config set prefix "$NPM_HOME" >/dev/null 2>&1
    NPM_PREFIX_SWITCHED=1
  fi
  use_npm_prefix "$NPM_HOME"
  npm_install_timeout '@openai/codex' 180 || warn "Codex CLI が時間内に入りませんでした"
  if ! have codex && [ "$NPM_PREFIX_SWITCHED" -eq 0 ]; then
    NPM_HOME="$ORGIAST_USER_HOME/.orgiast/npm"
    mkdir -p "$NPM_HOME/lib/node_modules"
    if npm config set prefix "$NPM_HOME" >/dev/null 2>&1 && use_npm_prefix "$NPM_HOME"; then
      NPM_PREFIX_SWITCHED=1
      warn "Codex CLI をユーザー専用 npm prefix で再試行します"
      npm_install_timeout '@openai/codex' 180 || warn "Codex CLI の再試行が時間内に完了しませんでした"
    fi
  fi
  if have codex; then ok "Codex CLI 導入完了"; else warn "Codex CLI 未導入。後で npm i -g @openai/codex を実行してください"; fi
  npm_install_timeout '@google/gemini-cli' 120 || warn "Gemini CLIグローバル導入失敗(MCPはnpxで取得するため続行)"
else warn "npm が無いためCLI導入をスキップ"; fi

step "共通ルールの初回取込"
if have node && [ -f "$REPO/tools/onboarding-sync.mjs" ]; then ORGIAST_HOME="$ORGIAST_USER_HOME" node "$REPO/tools/onboarding-sync.mjs" --force >/dev/null && ok "共通ルールを取り込みました"; else warn "取込は次回Claude Code起動時に実行されます"; fi

if have codex; then
  echo; echo "Codexログイン画面では 【seisaku-team@orgiast.jp】 を選んでください。"
  codex login & LOGIN_PID=$!
  DEADLINE=$(( $(date +%s) + 600 )); LOGGED=0
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if node -e "const f=process.argv[1];try{process.exit(JSON.parse(require('fs').readFileSync(f,'utf8')).tokens?.id_token?0:1)}catch{process.exit(1)}" "$ORGIAST_USER_HOME/.codex/auth.json" 2>/dev/null; then LOGGED=1; break; fi
    sleep 5
  done
  [ "$LOGGED" -eq 1 ] && ok "Codexログイン確認OK" || warn "10分以内にログインを確認できませんでした。後で codex login を実行してください"
  kill "$LOGIN_PID" >/dev/null 2>&1
fi

step "適用状況の総合チェック"
[ -f "$REPO/tools/selftest-install.sh" ] && ORGIAST_HOME="$ORGIAST_USER_HOME" /bin/bash "$REPO/tools/selftest-install.sh"
echo; echo "Claude Code を開き直してください(設定は次回起動時に自動で有効になります)"
