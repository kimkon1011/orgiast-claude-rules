const fs = require('fs');
const p = 'tools/lane-doctor.mjs';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf("let ok = false;");
const end = s.indexOf("} finally { try { resetLaneProbeWorkDir(cwd); } catch {} }", start);
if (start < 0 || end < 0) { console.error('markers missing', start, end); process.exit(2); }
const block = s.slice(start, end);
const neu = "let ok = false;\n    try { ok = fs.readFileSync(path.join(cwd, 'WRITE_OK.txt'), 'utf8').trim() === 'WRITE_OK'; } catch {}\n    // 書き込み成否はファイル内容で判定する（codex-do が exit 非0でもファイルが書けていれば probe_ok。2026-11-22 011NEXT 実測）\n    return { viaChain: ok ? false : probeViaChain(result.text, 'codex'), code: ok ? 0 : 1, text: ok ? 'WRITE_OK' : `書き込み確認失敗 ${result.text || ''}` };\n  ";
if (!block.includes("result.code === 0 && ok")) { console.error('unexpected block', block); process.exit(3); }
fs.writeFileSync(p, s.slice(0, start) + neu + s.slice(end));
console.log('PATCHED_OK');
