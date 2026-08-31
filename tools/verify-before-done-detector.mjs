#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
try {
  if (!stdin.trim()) process.exit(0);
  const data = JSON.parse(stdin);
  if (data.stop_hook_active || !data.transcript_path || !fs.existsSync(data.transcript_path)) process.exit(0);
  const lines = fs.readFileSync(data.transcript_path, 'utf8').split(/\r?\n/).slice(-60);
  let assistantText = '', codeEdited = false, editedName = '', testRun = false;
  const exts = ['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.go','.rs','.java','.gs','.vue','.svelte','.php','.rb','.cs'];
  const excl = ['\\memory\\','\\.claude\\','rules-extracted','onboarding-compress','\\docs\\','node_modules','\\tools\\','\\.git\\','scratchpad','.test.','.spec.','\\test\\','\\tests\\'];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text) assistantText += `\n${b.text}`;
      if (b.type !== 'tool_use') continue;
      const name = String(b.name || '');
      if (/^(Edit|Write|MultiEdit)$/.test(name)) {
        const fp = String(b.input?.file_path || '').toLowerCase().replaceAll('/', '\\');
        if (fp && !excl.some((x) => fp.includes(x)) && exts.includes(path.extname(fp))) { codeEdited = true; editedName = path.basename(fp); }
      }
      if (name === 'Bash' && /(\bnode\b|\bpython3?\b|\bpwsh\b|\bpowershell\b|npm (test|run)|\btsc\b|pytest|vitest|jest|--dry[-_]?run|\bcurl\b|Invoke-RestMethod|Invoke-WebRequest|go test|cargo test|-Force|ParseFile|--noEmit)/i.test(String(b.input?.command || ''))) testRun = true;
    }
  }
  if (!assistantText.trim() || /\[(TESTED|NO-TEST-OK)\]/.test(assistantText)) process.exit(0);
  if (!/(完了|できました|直しました|修正しました|実装しました|反映しました|デプロイ|deployed|push(しました|済)|fixに|バグ.*修正|動くように)/.test(assistantText)) process.exit(0);
  if (codeEdited && !testRun) {
    const reason = `[VERIFY-BEFORE-DONE] コード(${editedName} 等)を変更して「完了」と報告していますが、この直近ターンに"実際に実行してテストした痕跡"が見当たりません(§1.18/§1.4)。\n\n出す前に必ず実行して確認してください:\n  - スクリプト: 実際に走らせて出力を目視(文字化け・構文エラー・二重実行/重複送信・空出力が無いか)\n  - 型/ビルド: tsc --noEmit / ParseFile 等\n  - 送信・DB系: read-back で結果確認\n  - Codexに実装させた場合も、Claude側で実行テストして結果を見て直すまでが1タスク\n\nテスト済みなら応答に [TESTED] を、テスト不要な軽微変更(typo/コメント等)なら [NO-TEST-OK] を(理由付きで)含めれば通ります。`;
    console.log(JSON.stringify({ decision: 'block', reason }));
  }
} catch {}
