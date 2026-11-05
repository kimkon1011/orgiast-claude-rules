import fs from 'node:fs';

// =========================================================
// 1. auto-progress-digest.mjs - just strip remaining markers
// =========================================================
let src = fs.readFileSync('tools/auto-progress-digest.mjs', 'utf8');
src = src.replace(/<<<<<<< HEAD\n/g, '').replace(/\n=======\n/g, '\n').replace(/\n>>>>>>> origin\/main\n/g, '\n')
  .replace(/<<<<<<< HEAD/g, '').replace(/=======/g, '').replace(/>>>>>>> origin\/main/g, '');
fs.writeFileSync('tools/auto-progress-digest.mjs', src, 'utf8');

// =========================================================
// 2. kim-inbox.mjs - full rewrite of conflict regions
// =========================================================
src = fs.readFileSync('tools/kim-inbox.mjs', 'utf8');

// Fix 1: Rewrite create() function (lines ~77-125)
src = src.replace(
  /\/\/ 集約の検索と作成を同じロックで守り、同時追加も取りこぼさない。\nfunction create\(home, options\) \{\n  return locked\(home, 'info-aggregation', \(\) => \{\n    const text = clean\(options\.text\);\n<<<<<<< HEAD\n    if \(options\.deliveryKey\) \{\n      const existing = listItems\(home\)\.find\(item => item\.deliveryKey === options\.deliveryKey\);\n      if \(existing\) return existing;\n    \}\n    if \(\(options\.kind \?\? 'info'\) === 'info' \|\| \/\(\?:\^C\\d\{4,\}\|\d\{6\}\[A-Z\]\{2,6\}\)\s\)\/\.test\(text\)\) \{\n      const key = normalizationKey\(text\);\n      const matches = listItems\(home, \{ status: 'open' \}\)\.filter\(i => i\.kind === \(options\.kind \?\? 'info'\) && normalizationKey\(i\.text\) === key\)\.sort\(newestFirst\);\n=======\n    if \(options\.kind === 'deadline'\) \{\n      if \(!options\.key \|\| !\/\^\[A-Za-z0-9_-\]\+\$\/\.test\(options\.key\)\) throw new Error\('deadline には有効な --key が必要です'\);\n      const existing = listItems\(home, \{ status: 'open' \}\)\.find\(i => i\.kind === 'deadline' && i\.key === options\.key\);\n      if \(existing\) return update\(home, existing\.id, current => \{\n        current\.text = text; current\.due = options\.due \|\| ''; current\.remainingDays = options\.remainingDays \?\? null;\n        current\.lastAt = new Date\(\)\.toISOString\(\);\n      \}\);\n    \}\n    if \(options\.dedupeKey\) \{\n      const existing = listItems\(home\)\.find\(item => item\.dedupeKey === clean\(options\.dedupeKey\)\);\n      return existing \|\| createNew\(home, options\);\n    \}\n    if \(\(options\.kind \?\? 'info'\) === 'info'\) \{\n      const key = normalizationKey\(text\);\n      const matches = listItems\(home, \{ status: 'open' \}\)\.filter\(i => !i\.dedupeKey && i\.kind === 'info' && normalizationKey\(i\.text\) === key\)\.sort\(newestFirst\);\n>>>>>>> origin\/main\n/,
  `// 集约の検索と作成を同じロックで守り、同時追加も取りこぼさない。
function create(home, options) {
  return locked(home, 'info-aggregation', () => {
    const text = clean(options.text);
    if (options.deliveryKey) {
      const existing = listItems(home).find(item => item.deliveryKey === options.deliveryKey);
      if (existing) return existing;
    }
    if (options.kind === 'deadline') {
      if (!options.key || !/^[A-Za-z0-9_-]+$/.test(options.key)) throw new Error('deadline には有効な --key が必要です');
      const existing = listItems(home, { status: 'open' }).find(i => i.kind === 'deadline' && i.key === options.key);
      if (existing) return update(home, existing.id, current => {
        current.text = text; current.due = options.due || ''; current.remainingDays = options.remainingDays ?? null;
        current.lastAt = new Date().toISOString();
      });
    }
    if (options.dedupeKey) {
      const existing = listItems(home).find(item => item.dedupeKey === clean(options.dedupeKey));
      return existing || createNew(home, options);
    }
    if ((options.kind ?? 'info') === 'info') {
      const key = normalizationKey(text);
      const matches = listItems(home, { status: 'open' }).filter(i => !i.dedupeKey && i.kind === 'info' && normalizationKey(i.text) === key).sort(newestFirst);
`
);

// Fix 2: createNew duplicate + conflict
src = src.replace(
  /function createNew\(home, \{ kind = 'info', text, source = '', from = resolveFleetLabel\(home, \{ hostname: os\.hostname\(\) \}\), forwardMailId = null, deliveryKey \}\) \{\n  if \(!\['ask', 'info'\].includes\(kind\)\) throw new Error\('kind は ask または info'\);\n=======\nfunction createNew\(home, \{ kind = 'info', text, source = '', from = resolveFleetLabel\(home, \{ hostname: os\.hostname\(\) \}\), forwardMailId = null, dedupeKey, key, due, remainingDays, urgent = false \}\) \{\n  if \(!\['ask', 'info', 'deadline'\].includes\(kind\)\) throw new Error\('kind は ask \/ info \/ deadline'\);\n/,
  `function createNew(home, { kind = 'info', text, source = '', from = resolveFleetLabel(home, { hostname: os.hostname() }), forwardMailId = null, deliveryKey, dedupeKey, key, due, remainingDays, urgent = false }) {
  if (!['ask', 'info', 'deadline'].includes(kind)) throw new Error('kind は ask / info / deadline');
`
);

// Fix 3: item construction duplicate
src = src.replace(
  /const item = \{ id, createdAt, \.\.\.\(deliveryKey \? \{ deliveryKey \} : \{\}\), \.\.\.\(kind === 'info' \? \{ repeatCount: 1, lastAt: createdAt \} : \{\}\), kind, source: clean\(source\), from: clean\(from\), text: clean\(text\), status: 'open', shownSessions: \[\], shownCount: 0, lastShownAt: null, answeredAt: null, answer: null, answerSession: null, forwardMailId, forwardError: null \};\n=======\n    const item = \{ id, createdAt, \.\.\.\(urgent \? \{ urgent: true \} : \{\}\), \.\.\.\(kind === 'deadline' \? \{ key, due: due \|\| '', remainingDays: remainingDays \?\? null \} : \{\}\), \.\.\.\(dedupeKey \? \{ dedupeKey: clean\(dedupeKey\) \} : \{\}\), \.\.\.\(kind === 'info' \? \{ repeatCount: 1, lastAt: createdAt \} : \{\}\), kind, source: clean\(source\), from: clean\(from\), text: clean\(text\), status: 'open', shownSessions: \[\], shownCount: 0, lastShownAt: null, answeredAt: null, answer: null, answerSession: null, forwardMailId, forwardError: null \};\n/,
  `    const item = { id, createdAt, ...(deliveryKey ? { deliveryKey } : {}), ...(urgent ? { urgent: true } : {}), ...(kind === 'deadline' ? { key, due: due || '', remainingDays: remainingDays ?? null } : {}), ...(dedupeKey ? { dedupeKey: clean(dedupeKey) } : {}), ...(kind === 'info' ? { repeatCount: 1, lastAt: createdAt } : {}), kind, source: clean(source), from: clean(from), text: clean(text), status: 'open', shownSessions: [], shownCount: 0, lastShownAt: null, answeredAt: null, answer: null, answerSession: null, forwardMailId, forwardError: null };
`
);

// Fix 4: Remove HEAD's addItem (keep origin/main's), fix forwardItem/ingestFleetMail markers
// Fix: splitInboxText + HEAD's addItem + forwardItem stub vs origin/main isInboxNoise etc + addItem
src = src.replace(
  /<<<<<<< HEAD\n\/\/ 全文を保持し、案件境界を優先してセッション予算に収まる項目へ分割する。\nexport function splitInboxText\(text\) \{\n  const blocks = clean\(text\)\.split\(\/\\n\(\?=\(\?:\^C\\d\{4,\}\|\d\{6\}\[A-Z\]\{2,6\}\)\s\)\/\);\n  return blocks\.flatMap\(block => \{\n    if \(block\.length <= 900\) return \[block\];\n    const heading = \/\^\(\?:\^C\\d\{4,\}\|\d\{6\}\[A-Z\]\{2,6\}\)\s\/\.test\(block\) \? block\.split\('\\n'\)\[0\] : '';\n    const prefix = heading\.length < 300 \? heading : '';\n    const body = prefix \? block\.slice\(prefix\.length\)\.replace\(\/\^\\n\/, ''\) : block;\n    const chunks = \[\], size = 850 - prefix\.length;\n    for \(let offset = 0; offset < body\.length; offset \+= size\)\n      chunks\.push\(\`\$\{prefix \? prefix \+ '\\n' : ''\}\$\{body\.slice\(offset, offset \+ size\)\}\`\);\n    return chunks\.map\(\(part, i\) => \`\$\{part\}\\n（続き \$\{i \+ 1\}\/\$\{chunks\.length\}）\`\);\n  \}\);\n\}\nexport async function addItem\(home, options\) \{\n  const results = \[\];\n  for \(const \[index, text\] of splitInboxText\(options\.text\)\.entries\(\)\) \{\n    results\.push\(await forwardItem\(home, create\(home, \{ \.\.\.options, text, deliveryKey: options\.deliveryKey \? \`\$\{options\.deliveryKey\}:\$\{index\}\` : undefined \}\), options\)\);\n  \}\n  return \{ \.\.\.\(results\.find\(item => item\.forwardError\) \|\| results\[0\]\), items: results \};\n\}\nasync function forwardItem\(home, item, options = \{\}\) \{\n  if \(item\.status !== 'open'\) return item;\n  if \(resolveFleetLabel\(home, \{ hostname: os\.hostname\(\) \}\) === 'kim-PC'\) return item;\n  const release = acquireLock\(path\.join\(directory\(home\), \`\$\{item\.id\}\.forward\.lock\`\)\);\n  if \(!release\) return \{ \.\.\.item, forwardError: '転送中（次回再試行）' \};\n  let temp;\n=======\n/,
  `// 全文を保持し、案件境界を優先してセッション予算に収まる項目へ分割する。
export function splitInboxText(text) {
  const blocks = clean(text).split(/\\n(?=(?:C\\d{4,}|\\d{6}[A-Z]{2,6})\\s)/);
  return blocks.flatMap(block => {
    if (block.length <= 900) return [block];
    const heading = /^(?:C\\d{4,}|\\d{6}[A-Z]{2,6})\\s/.test(block) ? block.split('\\n')[0] : '';
    const prefix = heading.length < 300 ? heading : '';
    const body = prefix ? block.slice(prefix.length).replace(/^\\n/, '') : block;
    const chunks = [], size = 850 - prefix.length;
    for (let offset = 0; offset < body.length; offset += size)
      chunks.push(\`\${prefix ? prefix + '\\n' : ''}\${body.slice(offset, offset + size)}\`);
    return chunks.map((part, i) => \`\${part}\\n（続き \${i + 1}/\${chunks.length}）\`);
  });
}
export function isInboxNoise({ kind = 'info', source = '', text = '' }) {
  return kind === 'info' && (source === 'gate-report' || /^gate-report\\b/.test(text) || /別のパソコン[^\\n]*送った連絡が(?:届いて|読まれて)/.test(text));
}
export function seenMatching(home, expression, kind = 'info') {
  if (kind !== 'info') throw new Error('--seen-matching は info 専用です');
  const pattern = new RegExp(expression);
  return listItems(home, { status: 'open' }).filter(i => i.kind === kind && (pattern.test(i.text) || pattern.test(i.source)))
    .map(i => markSeen(home, i.id));
}
export function spoolItem(home, options) {
  const dir = path.join(directory(home), 'spool');
  fs.mkdirSync(dir, { recursive: true });
  const id = randomBytes(16).toString('hex');
  const file = path.join(dir, \`\${id}.json\`), temp = \`\${file}.tmp\`;
  const record = { kind: options.kind || 'info', text: clean(options.text), source: clean(options.source),
    from: clean(options.from ?? resolveFleetLabel(home, { hostname: os.hostname() })),
    dedupeKey: options.dedupeKey ? clean(options.dedupeKey) : \`spool:\${id}\` };
  try {
    fs.writeFileSync(temp, JSON.stringify(record) + '\\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return { delivered: 'spooled', id };
}
export async function drainSpool(home, { stderr = console.error, execImpl, signal } = {}) {
  const dir = path.join(directory(home), 'spool');
  if (!fs.existsSync(dir)) return [];
  let release;
  try { release = acquireInboxLock(home, 'spool-drain', 0); }
  catch { return []; }
  const imported = [];
  try {
    for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9]{32}\\.json$/.test(n)).sort().slice(0, 20)) {
      const file = path.join(dir, name);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!['ask', 'info'].includes(record.kind) || typeof record.text !== 'string' || !record.dedupeKey) throw new Error('invalid spool record');
        const item = await addItem(home, { ...record, execImpl, signal }, { drain: false });
        if (item.status === 'open' && item.forwardError) break;
        fs.unlinkSync(file);
        imported.push(item);
      } catch (error) {
        stderr(\`kim-inbox: spool を保持して次回再試行: \${clean(error.message)}\`);
        break;
      }
    }
  } finally { release(); }
  return imported;
}
export async function addItem(home, options, { drain = true } = {}) {
  if (drain) await drainSpool(home, { execImpl: options.execImpl, signal: options.signal });
  if (isInboxNoise(options)) return { id: null, status: 'suppressed', kind: options.kind || 'info' };
  const item = create(home, options);
  if (item.kind === 'deadline' || isKimSeat(home) || item.forwardMailId || ['seen', 'answered', 'dropped'].includes(item.status)) return item;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-'));
`
);

// Fix 5: forwardItem continuation + the rest of addItem (line ~260 area)
src = src.replace(
  /<<<<<<< HEAD\n    return update\(home, item\.id, current => \{ if \(current\.status === 'open'\) current\.status = 'forwarded'; current\.forwardMailId = id; current\.forwardError = null; \}\);\n=======\n    return update\(home, item\.id, current => \{ current\.status = 'forwarded'; current\.forwardMailId = id; current\.forwardError = null; \}\);\n/,
  `    return update(home, item.id, current => { if (current.status === 'open') current.status = 'forwarded'; current.forwardMailId = id; current.forwardError = null; });
`
);

// Fix 6: ingestFleetMail conflict - splitInboxText vs isInboxNoise
src = src.replace(
  /<<<<<<< HEAD\n      const received = splitInboxText\(mail\.body\)\.map\(\(text, index\) => \{\n        const partId = \`\$\{id\}:\$\{index\}\`;\n        return listItems\(home\)\.find\(i => i\.forwardPartId === partId \|\| \(index === 0 && i\.forwardMailId === id && !i\.forwardPartId\)\) \?\? \(\(\) => \{\n          const item = create\(home, \{ kind, text, from: mail\.from, source: 'fleet-mail', forwardMailId: id \}\);\n          return update\(home, item\.id, current => \{ current\.forwardPartId = partId; \}\);\n        \}\)\(\);\n      \}\);\n      const item = received\[0\];\n=======\n      const item = listItems\(home\)\.find\(i => i\.forwardMailId === id\) \?\? \(isInboxNoise\(\{ kind, text: mail\.body \}\) \? \{ id: 'suppressed', status: 'suppressed' \} : create\(home, \{ kind, text: mail\.body, from: mail\.from, source: 'fleet-mail', forwardMailId: id \}\)\);\n/,
  `      // splitInboxText + forwardPartId（HEAD）+ isInboxNoise（origin/main）
      const noiseCheck = isInboxNoise({ kind, text: mail.body });
      if (noiseCheck) { const marker = path.join(directory(home), '.ingested', id); fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, 'suppressed', { flag: 'wx', mode: 0o600 }); imported.push({ id: 'suppressed', status: 'suppressed' }); continue; }
      const received = splitInboxText(mail.body).map((text, index) => {
        const partId = \`\${id}:\${index}\`;
        return listItems(home).find(i => i.forwardPartId === partId || (index === 0 && i.forwardMailId === id && !i.forwardPartId)) ?? (() => {
          const item = create(home, { kind, text, from: mail.from, source: 'fleet-mail', forwardMailId: id });
          return update(home, item.id, current => { current.forwardPartId = partId; });
        })();
      });
      const item = received[0];
`
);

// Fix 7: selectContext conflict - priority sorting vs unseenFirst/urgent
src = src.replace(
  /<<<<<<< HEAD\n  const priority = item => own\(item\) \? 0 : item\.kind === 'ask' \? 1 : isHighInfo\(item\) \? 2 : 3;\n  const candidates = pending\.sort\(\(a, b\) => Number\(a\.shownCount > 0\) - Number\(b\.shownCount > 0\)\n    \|\| priority\(a\) - priority\(b\) \|\| newestFirst\(a, b\)\);\n  for \(const item of candidates\) \{\n    const repeat = item\.shownSessions\.includes\(sessionId\);\n    const body = repeat && !\(item\.kind === 'ask' && \/\^\(\?:\^C\\d\{4,\}\|\d\{6\}\[A-Z\]\{2,6\}\)\s\/\.test\(item\.text\)\) \? item\.text\.split\(\/\\r?\\n\/\)\[0\]\.slice\(0, 120\) : item\.text;\n=======\n  const unseenFirst = \(a, b\) => Number\(a\.shownCount > 0\) - Number\(b\.shownCount > 0\) \|\| newestFirst\(a, b\);\n  let urgentText = '';\n  for \(const item of allAsks\.filter\(i => i\.urgent\)\.sort\(unseenFirst\)\.slice\(0, 5\)\) \{\n    const heading = clean\(\`■ 🔴急ぎ ask \$\{item\.id\} \(from=\$\{item\.from\} source=\$\{item\.source\}\)\`\)\.slice\(0, 220\);\n    urgentText \+= \`\$\{heading\}\\n\$\{clean\(item\.text\)\.slice\(0, 600\)\}\\n→ kim に提示して返答をもらい: node tools\/kim-inbox\.mjs --answer \$\{item\.id\} --body-file <返答ファイル>\\n\`;\n    item\.shownSessions = \[\.\.\.new Set\(\[\.\.\.item\.shownSessions, sessionId\]\)\];\n    item\.shownCount\+\+; item\.lastShownAt = new Date\(now\)\.toISOString\(\);\n  \}\n  const sessionInfos = infos\.filter\(own\)\.sort\(unseenFirst\);\n  const highInfos = infos\.filter\(i => !own\(i\) && isHighInfo\(i\)\)\.sort\(unseenFirst\);\n  const otherInfos = infos\.filter\(i => !own\(i\) && !isHighInfo\(i\)\)\.sort\(newestFirst\);\n  const unseenHigh = highInfos\.filter\(i => i\.shownCount === 0\)\.slice\(0, 3\);\n  const laterHigh = highInfos\.filter\(i => !unseenHigh\.includes\(i\)\)\.slice\(0, Math\.max\(0, 5 - unseenHigh\.length\)\);\n  const selected = deadlines\.length \? \[\.\.\.asks\.slice\(0, 5\), \.\.\.\[\.\.\.sessionInfos, \.\.\.unseenHigh, \.\.\.laterHigh, \.\.\.otherInfos\]\.slice\(0, 3\)\] : \[\.\.\.sessionInfos, \.\.\.unseenHigh, \.\.\.asks\.slice\(0, 5\), \.\.\.laterHigh, \.\.\.otherInfos\.slice\(0, 2\)\];\n  for \(const item of selected\) \{\n    if \(otherInfos\.includes\(item\) && \[\.\.\.sessionInfos, \.\.\.highInfos\]\.some\(i => i\.shownCount === 0\)\) break;\n    const repeat = item\.shownSessions\.includes\(sessionId\);\n    const compact = unseenHigh\.includes\(item\) \|\| laterHigh\.includes\(item\);\n    const body = repeat \? item\.text\.split\(\/\\r?\\n\/\)\[0\]\.slice\(0, 120\)\n      : compact \? item\.text\.replace\(\/\^【\[\^\\r\\n\]\*】\\r?\\n\/, ''\)\.slice\(0, 240\) : item\.text\.slice\(0, 600\);\n/,
  `  const unseenFirst = (a, b) => Number(a.shownCount > 0) - Number(b.shownCount > 0) || newestFirst(a, b);
  // 急ぎは通常の CONTEXT_LIMIT と別枠で確保し、期限・進捗よりも先頭に出す。
  let urgentText = '';
  for (const item of allAsks.filter(i => i.urgent).sort(unseenFirst).slice(0, 5)) {
    const heading = clean(\`■ 🔴急ぎ ask \${item.id} (from=\${item.from} source=\${item.source})\`).slice(0, 220);
    urgentText += \`\${heading}\\n\${clean(item.text).slice(0, 600)}\\n→ kim に提示して返答をもらい: node tools/kim-inbox.mjs --answer \${item.id} --body-file <返答ファイル>\\n\`;
    item.shownSessions = [...new Set([...item.shownSessions, sessionId])];
    item.shownCount++; item.lastShownAt = new Date(now).toISOString();
  }
  const sessionInfos = infos.filter(own).sort(unseenFirst);
  const highInfos = infos.filter(i => !own(i) && isHighInfo(i)).sort(unseenFirst);
  const otherInfos = infos.filter(i => !own(i) && !isHighInfo(i)).sort(newestFirst);
  const unseenHigh = highInfos.filter(i => i.shownCount === 0).slice(0, 3);
  const laterHigh = highInfos.filter(i => !unseenHigh.includes(i)).slice(0, Math.max(0, 5 - unseenHigh.length));
  const selected = deadlines.length ? [...asks.slice(0, 5), ...[...sessionInfos, ...unseenHigh, ...laterHigh, ...otherInfos].slice(0, 3)] : [...sessionInfos, ...unseenHigh, ...asks.slice(0, 5), ...laterHigh, ...otherInfos.slice(0, 2)];
  for (const item of selected) {
    if (otherInfos.includes(item) && [...sessionInfos, ...highInfos].some(i => i.shownCount === 0)) break;
    const repeat = item.shownSessions.includes(sessionId);
    const compact = unseenHigh.includes(item) || laterHigh.includes(item);
    const body = repeat ? item.text.split(/\\r?\\n/)[0].slice(0, 120)
      : compact ? item.text.replace(/^【[^\\r\\n]*】\\r?\\n/, '').slice(0, 240) : item.text.slice(0, 600);
`
);

// Remove any remaining conflict markers
src = src.replace(/<<<<<<< HEAD\n?/g, '').replace(/\n?=======\n?/g, '\n').replace(/\n?>>>>>>> origin\/main\n?/g, '\n');

fs.writeFileSync('tools/kim-inbox.mjs', src, 'utf8');

// =========================================================
// 3. notify-kim.mjs - strip markers
// =========================================================
src = fs.readFileSync('tools/notify-kim.mjs', 'utf8');

// Fix: case-progress-digest check + isInboxNoise check - keep both
src = src.replace(
  /<<<<<<< HEAD\n  if \(options\.source === 'case-progress-digest'\) return deliverKim\(text, \{ \.\.\.options, plainJa: false \}\);\n=======\n  if \(isInboxNoise\(\{ \.\.\.options, text: String\(text \?\? ''\) \}\)\) return \{ delivered: 'suppressed', reason: 'fleet-ledger-or-gate-statistics' \};\n/,
  `  if (options.source === 'case-progress-digest') return deliverKim(text, { ...options, plainJa: false });
  if (isInboxNoise({ ...options, text: String(text ?? '') })) return { delivered: 'suppressed', reason: 'fleet-ledger-or-gate-statistics' };
`
);

// Fix: second conflict - deliveryKey + addItem vs allowedForKim + persistKim
src = src.replace(
  /<<<<<<< HEAD\n  if \(source === 'case-progress-digest' \|\| \(\(userId == null \|\| String\(userId\)\.trim\(\) === '' \|\| String\(resolvedUserId\) === KIM_DISCORD_USER_ID\) && !discordAllowed\(String\(body\) \+ suffix, \{ home, allowlist, repoRoot \}\)\.allowed\)\) \{\n    const item = await addItem\(home, \{ kind, text: String\(body\) \+ suffix, source, signal, deliveryKey \}\);\n    return \{ delivered: item\.forwardError \? 'none' : 'session-inbox', id: item\.id, kind: item\.kind, status: item\.status, reason: item\.forwardError \|\| undefined \};\n=======\n  const allowedForKim = discordAllowed\(String\(text \?\? ''\) \+ suffix, \{ home, allowlist, repoRoot \}\)\.allowed\n    \|\| discordAllowed\(String\(body\) \+ suffix, \{ home, allowlist, repoRoot \}\)\.allowed;\n  if \(\(userId == null \|\| String\(userId\)\.trim\(\) === '' \|\| String\(resolvedUserId\) === KIM_DISCORD_USER_ID\) && !allowedForKim\) \{\n    return persistKim\(home, \{ kind, text: String\(body\) \+ suffix, source, signal \}\);\n/,
  `  // 許可判定は平易化前の原文でも行う（origin/main）
  const allowedForKim = discordAllowed(String(text ?? '') + suffix, { home, allowlist, repoRoot }).allowed
    || discordAllowed(String(body) + suffix, { home, allowlist, repoRoot }).allowed;
  if (source === 'case-progress-digest' || ((userId == null || String(userId).trim() === '' || String(resolvedUserId) === KIM_DISCORD_USER_ID) && !allowedForKim)) {
    const item = await addItem(home, { kind, text: String(body) + suffix, source, signal, deliveryKey });
    return { delivered: item.forwardError ? 'none' : 'session-inbox', id: item.id, kind: item.kind, status: item.status, reason: item.forwardError || undefined };
`
);

// Remove any remaining markers
src = src.replace(/<<<<<<< HEAD\n?/g, '').replace(/\n?=======\n?/g, '\n').replace(/\n?>>>>>>> origin\/main\n?/g, '\n');

fs.writeFileSync('tools/notify-kim.mjs', src, 'utf8');

console.log('All files processed');