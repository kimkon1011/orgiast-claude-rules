# AIコスト改善仕様: cost-work-loop timeout / 019 PC

## 計測事実
- 対象: cost-work-loop.mjs が Windows PC(019) で毎回 300 秒を超え ETIMEDOUT
- ファイル数: `~/.claude/projects/**/*.jsonl` が 1431 ファイル
- 失敗パターン: cron-liveness-check.mjs の子プロセスが gh コマンドでハング、burden/rework 関数が独立 walk でファイル再読込

## 原因
4つのボトルネック:

### A) cron-liveness-check.mjs の spawnSync に timeout が無い（最重要）
cost-work-loop.mjs L117: `spawnSync(process.execPath, [..., 'cron-liveness-check.mjs'], ...)` に timeout が無い。cron-liveness-check.mjs は内部で `gh run list` を最大3回呼び、それぞれ timeout 無し。gh が未認証・ネットワーク障害でハングすると cost-work-loop.mjs 全体が止まる。

### B) collectUserBurdenMetrics / collectUserReworkStats が独立して projects/ を walk する
usage-stats.mjs の claudeFiles() は projects/ を一回 walk して parse 結果をキャッシュするが、lib/user-burden-metrics.mjs と lib/user-rework-stats.mjs は独立した walk + readFileSync を行う。parseClaudeFile は既に raw text を読んでいるが、キャッシュに含めていないため burden/rework が再読取を強いられる。

### C) bulkStat の子プロセスに timeout が無い
usage-stats.mjs L84: 64ファイル以上の bulkStat は Node.js 子プロセスを spawn するが timeout が無い。

### D) runJsonTool の timeout が30秒と長い
cost-work-loop.mjs L202: claude-plan-usage.mjs / budget-status.mjs の timeout が 30000ms。15秒に短縮可能。

## 修正内容（4ファイル）

### 変更1: tools/usage-stats.mjs

#### a) parseClaudeFile に rawText を含める（L119）
```js
// 変更前（L119）:
return { records, commands, firstUser, firstCwd };
// 変更後:
return { records, commands, firstUser, firstCwd, rawText: raw };
```
これで cachedFile が rawText をキャッシュする。burden/rework 関数が rawText を再利用できる。

#### b) claudeFiles の結果を rawText 付きで返す export 関数を追加
cachedFile が rawText を含むようになったので、claudeFiles の結果で rawText が利用可能になる。
cost-work-loop.mjs が burden/rework 関数へ渡せるよう、claudeFiles を import 可能にする。

以下の export 関数を追加:
```js
export function collectClaudeFileList({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, now = Date.now() } = {}) {
  const cutoff = now - days * DAY;
  const files = claudeFiles(home, cutoff);
  return files.map(({ file, st, parsed }) => ({ file, rawText: parsed.rawText || '' }));
}
```

#### c) bulkStat の子プロセスに timeout を追加（L84）
```js
// 変更前（L84）:
const run = spawnSync(process.execPath, ['--input-type=module', '-e', program], { windowsHide: true, input: JSON.stringify(files), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
// 変更後:
const run = spawnSync(process.execPath, ['--input-type=module', '-e', program], { windowsHide: true, input: JSON.stringify(files), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15000 });
```

### 変更2: tools/lib/user-burden-metrics.mjs

#### collectUserBurdenMetrics に files パラメータを追加（L14）
既存の walk に加え、外部から pre-walk された file リストを受け取れるようにする。

変更後:
```js
export function collectUserBurdenMetrics({ home, days = 7, transcriptPath = '', files = null }) {
  const metrics = { sessions: 0, roundTripsPerObjective: 0, maxRoundTrips: 0, maxRoundTripsSession: '', stopBlocks: 0, stopBlocksPerSession: 0, repeatComplaints: 0, current: null };
  let trips = 0;
  const cutoff = Date.now() - days * 86400000;
  
  function visit(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'subagents' && !entry.name.startsWith('_deleted-backup')) visit(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      processFile(file);
    }
  }
  
  function processFile(file) {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) return;
      // files パラメータが与えられた場合は rawText を使う（再読取回避）
      const text = typeof file === 'object' ? file.rawText : fs.readFileSync(file, 'utf8');
      const burden = sessionBurden(text);
      if (!burden.humanTurns) return;
      metrics.sessions++; trips += burden.roundTrips;
      metrics.stopBlocks += burden.stopBlocks; metrics.repeatComplaints += burden.repeatComplaints;
      if (!metrics.maxRoundTripsSession || burden.roundTrips > metrics.maxRoundTrips) { metrics.maxRoundTrips = burden.roundTrips; metrics.maxRoundTripsSession = (typeof file === 'object' ? path.basename(file.file, '.jsonl') : path.basename(file, '.jsonl')).slice(0, 8); }
    } catch {}
  }
  
  // files パラメータ（claudeFiles キャッシュ由来の生テキスト）があればそれを優先
  if (Array.isArray(files)) {
    for (const entry of files) processFile(entry);
  } else {
    visit(path.join(home, '.claude', 'projects'));
  }
  
  if (metrics.sessions) { ... }
  if (transcriptPath) try { metrics.current = sessionBurden(fs.readFileSync(transcriptPath, 'utf8')); } catch {}
  return metrics;
}
```
注: sessionBurden の呼出に fs.readFileSync の代わりに既に読まれている rawText 文字列を直接渡す。

### 変更3: tools/lib/user-rework-stats.mjs

#### collectUserReworkStats に files パラメータを追加（L44）

変更後:
```js
export function collectUserReworkStats({ home = process.env.ORGIAST_HOME || os.homedir(), days = 7, transcriptPath = '', files = null } = {}) {
  let currentSessionCount = 0;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    currentSessionCount = countReworkInFile(transcriptPath);
  }
  let sevenDayCount = 0;
  const projectsDir = path.join(home, '.claude', 'projects');
  const cutoff = Date.now() - days * 864e5;
  
  function walk(dir) {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile() && item.name.endsWith('.jsonl')) {
        processFile(fullPath);
      }
    }
  }
  
  function processFile(filePath) {
    try {
      if (fs.statSync(filePath).mtimeMs >= cutoff) {
        // files パラメータが与えられた場合は rawText を使う
        const text = typeof filePath === 'object' ? filePath.rawText : fs.readFileSync(filePath, 'utf8');
        // countReworkInFile はファイルパスを受け取るので、rawText がある場合はテンポラリで渡す必要がある
        // → countReworkInFile を拡張して文字列も受け取れるようにするか、
        //   ここでインライン処理する
      }
    } catch {}
  }
  
  // ... walk or iterate files ...
```

より簡潔な変更: countReworkInFile は rawText と filePath の両方を扱えるよう修正し、
collectUserReworkStats は files パラメータがある場合はそれを使って独立 walk を回避。

```js
// countReworkInFile の拡張版: text が文字列ならそのまま使う
function countReworkInText(text) {
  let count = 0;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.isSidechain === true) continue;
      if (entry?.type === 'user' && entry?.message?.role === 'user') {
        const msgContent = entry.message.content;
        const msgText = Array.isArray(msgContent) ? msgContent.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : typeof msgContent === 'string' ? msgContent : '';
        if (isHumanMessage(msgText) && USER_REWORK_PATTERN.test(msgText)) count++;
      }
    } catch {}
  }
  return count;
}

// countReworkInFile は countReworkInText を呼ぶよう委譲
function countReworkInFile(filePath) {
  try { return countReworkInText(fs.readFileSync(filePath, 'utf8')); } catch { return 0; }
}
```

### 変更4: tools/cost-work-loop.mjs

#### a) cron-liveness-check.mjs の spawnSync に timeout 追加（L117-119）
```js
// 変更前:
spawnSync(process.execPath, [path.join(...)], { windowsHide: true,
  env: { ...process.env, ORGIAST_HOME: HOME }, stdio: 'ignore',
});
// 変更後:
spawnSync(process.execPath, [path.join(...)], { windowsHide: true,
  env: { ...process.env, ORGIAST_HOME: HOME }, stdio: 'ignore', timeout: 30000,
});
```

#### b) runJsonTool の timeout を 30000→15000 に短縮（L202）
```js
// 変更前:
function runJsonTool(name) { try { const result = spawnSync(process.execPath, [...], { ..., timeout: 30000 }); ... } }
// 変更後:
function runJsonTool(name) { try { const result = spawnSync(process.execPath, [...], { ..., timeout: 15000 }); ... } }
```

#### c) claudeFiles キャッシュを burden/rework 関数へ渡す（L224-226）
collectClaudeCostStats 〜 collectClaudeStats が claudeFiles キャッシュを fill した後、
collectClaudeFileList でファイル一覧＋生テキストを取得し、burden/rework 関数へ渡す。

```js
// L70 付近の isMain ブロック内で: collectClaudeCostStats の直後に以下を追加
// claudeFiles キャッシュを蓄積（後続の burden/rework が独立 walk しないため）
let claudeFileCache = null;

// ... そのまま collectClaudeCostStats / collectCodexUsage / collectClaudeStats ...
// （これらが claudeFiles キャッシュを fill する）

// L224 付近: burden/rework の呼出を変更
const claudeFileList = collectClaudeFileList({ home: HOME, days: DAYS });
const userReworkStats = collectUserReworkStats({ home: HOME, days: DAYS, files: claudeFileList });

// L226 付近:
let burdenLines;
try { 
  const burdenMetrics = collectUserBurdenMetrics({ home: HOME, days: DAYS, files: claudeFileList });
  burdenLines = formatUserBurdenLines(burdenMetrics, DAYS).join('\n');
} catch { burdenLines = '- user の手間: 計測不能'; }
```

#### d) import 追加: collectClaudeFileList を usage-stats.mjs から import
```js
// L22 の import 行に collectClaudeFileList を追加
import { calculateDelegation, calculateLinesDelegation, collectBashProfile, collectClaudeActivityDays, collectClaudeCostStats, collectClaudeStats, collectCodexUsage, collectGitActivity, collectProviderHealth, estimateSpecAuthoringTokens, formatBlockSource, collectClaudeFileList } from './usage-stats.mjs';
```

## 作業範囲と禁止事項
- **変更ファイル**: tools/cost-work-loop.mjs, tools/usage-stats.mjs, tools/lib/user-burden-metrics.mjs, tools/lib/user-rework-stats.mjs
- **禁止**: cost-directive.md 形式変更、.github/workflows 変更、get-doc-permissions.mjs 変更、test-proxy.mjs 変更
- **既存テストを壊さない**: `node --test tools/cost-work-loop.test.mjs` / `node --test tools/cost-improve-loop.test.mjs` を通す
- main へ直接 push しない
- 原因を特定できなければ変更を入れずに報告

## 期待効果
- 修正前: 300秒超（ETIMEDOUT）
- 修正後: 目標 120 秒以内
  - cron-liveness-check が 30s で打ち切られる（-60s〜無限）
  - burden/rework の独立 walk を回避（-10〜30s）
  - runJsonTool の短縮（-15s）
  - bulkStat のハング防止