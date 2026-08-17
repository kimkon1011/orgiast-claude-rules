#!/bin/bash
# macOS用の適用チェック。設定内容は読むが変更しない。
ORGIAST_USER_HOME="${ORGIAST_HOME:-$HOME}"
REPO="$ORGIAST_USER_HOME/orgiast-claude-rules"
OK_COUNT=0; NG_COUNT=0
check() { if [ "$2" -eq 0 ]; then echo "[OK] $1"; OK_COUNT=$((OK_COUNT + 1)); else echo "[NG] $1"; NG_COUNT=$((NG_COUNT + 1)); fi; }
have_version() { if command -v "$1" >/dev/null 2>&1; then VERSION="$($1 --version 2>/dev/null | head -n 1)"; echo "[OK] $2 ($VERSION)"; OK_COUNT=$((OK_COUNT + 1)); else echo "[NG] $2"; NG_COUNT=$((NG_COUNT + 1)); fi; }
json_ok() { node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$1" >/dev/null 2>&1; }
json_has() { node - "$1" "$2" <<'NODE' >/dev/null 2>&1
const [f,n]=process.argv.slice(2); const j=JSON.parse(require('fs').readFileSync(f,'utf8'));
const cmds=Object.values(j.hooks||{}).flatMap(x=>Array.isArray(x)?x:[]).flatMap(x=>Array.isArray(x.hooks)?x.hooks:[]).map(x=>String(x.command||'')); process.exit(cmds.some(x=>x.includes(n))?0:1);
NODE
}

echo "===== オージャストAI設定 総合チェック ====="
have_version node "Node.js 導入"
have_version npm "npm 導入"
have_version codex "Codex CLI 導入"
[ -d "$REPO/tools" ]; check "ルールリポ tools の存在" $?
json_ok "$ORGIAST_USER_HOME/.claude/settings.json"; check "settings.json 妥当(BOM無/parse可)" $?
json_ok "$ORGIAST_USER_HOME/.claude.json"; check ".claude.json 妥当(BOM無/parse可)" $?
for NAME in onboarding-sync.mjs claude-cost-reporter.mjs tool-adoption-check.mjs cost-loop.mjs; do json_has "$ORGIAST_USER_HOME/.claude/settings.json" "$NAME"; check "SessionStart: $NAME" $?; done
json_has "$ORGIAST_USER_HOME/.claude/settings.json" pretooluse-delegation-warn.mjs; check "PreToolUse: 委譲警告" $?
json_has "$ORGIAST_USER_HOME/.claude/settings.json" verify-before-done-detector.mjs; check "Stop: テスト忘れ防止" $?
for FILE in cost-reporter.env manus.env deepseek.env xai.env openrouter.env groq.env mistral.env; do [ -f "$ORGIAST_USER_HOME/.claude/$FILE" ]; check "env: $FILE" $?; done
grep -q '^GEMINI_API_KEY=.' "$ORGIAST_USER_HOME/.gemini/.env" 2>/dev/null; check "Geminiキー(~/.gemini/.env)" $?
launchctl list 2>/dev/null | grep -q 'jp.orgiast.nightly-batch'; check "launchd: 夜間バッチ(03:00)" $?
launchctl list 2>/dev/null | grep -q 'jp.orgiast.fleet-poller'; check "launchd: フリート点検(03:15・mjs無ければ未登録)" $?
node -e "try{process.exit(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).tokens?.id_token?0:1)}catch{process.exit(1)}" "$ORGIAST_USER_HOME/.codex/auth.json" 2>/dev/null; check "Codexログイン済(auth.json)" $?
echo
echo "===== 結果: OK $OK_COUNT / NG $NG_COUNT ====="
[ "$NG_COUNT" -eq 0 ] && echo "全項目OK。セットアップは完全に適用されています。" || echo "NG項目を確認し、配布コマンドを再実行してください。Codexログインだけは codex login で。"
exit "$NG_COUNT"
