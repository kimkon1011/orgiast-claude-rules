import fs from 'node:fs';

let src = fs.readFileSync('tools/auto-progress-digest.mjs', 'utf8');

// Find and remove all remaining <<<<<<< HEAD ... >>>>>>> origin/main blocks
// where the content between them is already the resolved version

// Conflict 1 pattern
const pattern1 = /<<<<<<< HEAD\nconst cases = \(label === 'kim-PC' \|\| isKimOperated\(home, localOwner\) \|\| isKimOperated\(home\)\) \? await collectCaseProgress\(\{ home, now, previous: state\.caseProgress, fetchResume: io\.fetchCaseResume, fetchCatalog: io\.fetchCaseCatalog, dryRun \}\) : \{ text: '', checkpoints: \{\} \};\n    let deadlineText = '';\n    if \(currentSlot === '朝' && localOwner === 'kim@orgiast\.jp'\) \{\n      try \{ deadlineText = await \(io\.readDeadlineDigest \|\| readDeadlineDigest\)\(\{ home, today: new Date\(now \+ 9 \* 3600000\)\.toISOString\(\)\.slice\(0, 10\) \}\)\; \}\n      catch \(e\) \{ deadlineText = '今週の期限\\n期限台帳を取得できません。再試行が必要です。'; \(io\.stderr \|\| console\.error\)\(`deadline digest: \$\{e\.message\}`\)\; \}\n    \}\n>>>>>>> origin\/main/g;

src = src.replace(pattern1, `const cases = (label === 'kim-PC' || isKimOperated(home, localOwner) || isKimOperated(home)) ? await collectCaseProgress({ home, now, previous: state.caseProgress, fetchResume: io.fetchCaseResume, fetchCatalog: io.fetchCaseCatalog, dryRun }) : { text: '', checkpoints: {} };
    let deadlineText = '';
    if (currentSlot === '朝' && localOwner === 'kim@orgiast.jp') {
      try { deadlineText = await (io.readDeadlineDigest || readDeadlineDigest)({ home, today: new Date(now + 9 * 3600000).toISOString().slice(0, 10) }); }
      catch (e) { deadlineText = '今週の期限\\n期限台帳を取得できません。再試行が必要です。'; (io.stderr || console.error)(\`deadline digest: \${e.message}\`); }
    }`);

// Conflict 2 pattern
const pattern2 = /<<<<<<< HEAD\n\s+if \(cases\.text \|\| deadlineText\) group\(localOwner\);\n>>>>>>> origin\/main/g;
src = src.replace(pattern2, "    if (cases.text || deadlineText) group(localOwner);");

fs.writeFileSync('tools/auto-progress-digest.mjs', src, 'utf8');
console.log('All remaining conflicts in auto-progress-digest resolved');

// Verify
const remaining = src.match(/<<<<<<</g);
console.log('Remaining conflict markers:', remaining ? remaining.length : 0);