#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { kit, detectKind, gasRoot, files, readJson, writeJson, registryPath, repoRoot } from './common.mjs';

function originRepo(root) {
  const p = spawnSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', windowsHide: true });
  return (p.stdout || '').trim().match(/(?:github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] || '';
}
function source(file) { return fs.readFileSync(file, 'utf8'); }
// Replace complete modal elements, including nested divs; never delete the surrounding app.
export function replaceLegacyModals(html) {
  const pattern = /<(div|dialog|section)\b[^>]*\bid\s*=\s*["'](?:feedback[-_]?modal|fbModal|feedbackDialog)["'][^>]*>/ig;
  let match;
  while ((match = pattern.exec(html))) {
    const tags = new RegExp(`<(/?)${match[1]}\\b[^>]*>`, 'ig'); tags.lastIndex = pattern.lastIndex;
    let depth = 1, end;
    while ((end = tags.exec(html))) { depth += end[1] ? -1 : 1; if (!depth) break; }
    if (depth) throw new Error('既存 feedback modal の閉じタグを特定できません');
    const inner = '<button type="button" onclick="this.parentElement.style.display=\'none\'">閉じる</button><iframe title="不具合・要望" data-feedback-kit-frame style="width:100%;height:80vh;border:0"></iframe>';
    html = html.slice(0, pattern.lastIndex) + inner + html.slice(end.index);
    pattern.lastIndex += inner.length + end[0].length;
  }
  return html;
}
function integration(appName, hasOriginal) {
  return `// feedback-kit ${kit.version}: generated integration (no credentials)
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.form === 'feedback') return FeedbackRelay_serveForm({app: ${JSON.stringify(appName)}, src: params.src || ''});
  ${hasOriginal ? "var output = FeedbackKit_originalDoGet(e);\n  if (!output || typeof output.append !== 'function') return output;" : `var output = FeedbackRelay_serveForm({app: ${JSON.stringify(appName)}});`}
  var template = HtmlService.createTemplateFromFile('FeedbackKitLauncher');
  template.feedbackHtml = FeedbackRelay_serveForm({app: ${JSON.stringify(appName)}}).getContent();
  output.append(template.evaluate().getContent());
  return output;
}
`;
}
const launcher = `<button id="feedbackKitOpen" type="button" style="position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:12px;border-radius:24px">🐛 不具合・要望</button>
<dialog id="feedbackKitDialog" style="box-sizing:border-box;width:calc(100% - 24px);max-width:500px;padding:8px;border:0;border-radius:12px">
<button type="button" onclick="document.getElementById('feedbackKitDialog').close()">閉じる</button>
<iframe title="不具合・要望フォーム" data-feedback-kit-frame style="width:100%;height:75vh;border:0"></iframe></dialog>
<input type="hidden" id="feedbackKitHtml" value="<?= feedbackHtml ?>">
<script>(function(){var html=document.getElementById('feedbackKitHtml').value;document.querySelectorAll('[data-feedback-kit-frame]').forEach(function(f){f.srcdoc='<script>var google=parent.google;<'+ '/script>'+html;});document.getElementById('feedbackKitOpen').onclick=function(){document.getElementById('feedbackKitDialog').showModal();};})();</script>
`;

export function installApp({ app, name, upgrade = false, dryRun = false, registryFile = registryPath, appsFile = path.join(repoRoot, 'tools/feedback-apps.json'), localFile = path.join(path.dirname(registryFile), '.feedback-zero-local.json') }) {
  const root = fs.realpathSync(path.resolve(app));
  const kind = detectKind(root);
  if (!kind) throw new Error('GAS / Next.js アプリを判定できません');
  const metaFile = path.join(root, '.feedback-kit.json');
  const previous = readJson(metaFile, {});
  const appName = name || previous.appName || path.basename(root);
  const key = 'FEEDBACK_' + createHash('sha256').update(appName).digest('hex').slice(0,12).toUpperCase();
  const registry = readJson(registryFile, { version: 1, apps: [] });
  if (!Array.isArray(registry.apps)) throw new Error('registry.apps が配列ではありません');
  const oldEntry = registry.apps.find(e => e.appName === appName);
  const apps = readJson(appsFile, {});
  const repo = apps[appName] || originRepo(root);
  const entry = oldEntry || { appName, kind, intake: 'relay', refs: { url: 'FEEDBACK_RELAY_URL', secret: 'FEEDBACK_RELAY_SECRET', repo: key + '_REPO', appDir: key + '_APP_DIR' } };
  const writes = new Map();
  if (kind === 'gas') {
    const base = gasRoot(root);
    const existing = files(base);
    for (const name of ['FeedbackForm.html', 'FeedbackRelay.js']) {
      const canonical = source(path.join(repoRoot, 'tools/feedback-kit/gas/templates', name));
      const matches = existing.filter(f => name === 'FeedbackRelay.js' ? /(?:^|[\\/])FeedbackRelay\.(gs|js)$/i.test(f) : path.basename(f).toLowerCase() === name.toLowerCase());
      if (name === 'FeedbackRelay.js' && matches.length > 1) throw new Error('FeedbackRelay が重複しています。単一の定義に整理してください');
      for (const dest of matches.length ? matches : [path.join(base, name)]) writes.set(dest, canonical);
    }
    let original = false;
    for (const f of existing.filter(f => /\.(gs|js)$/.test(f) && path.basename(f) !== 'FeedbackKitIntegration.gs')) {
      let text = source(f);
      if (/function\s+FeedbackKit_originalDoGet\s*\(/.test(text)) original = true;
      const matches = [...text.matchAll(/function\s+doGet\s*\(/g)];
      if (matches.length) {
        if (original || matches.length !== 1) throw new Error('doGet が複数あります。安全に統合できません');
        original = true; text = text.replace(/function\s+doGet\s*\(/, 'function FeedbackKit_originalDoGet('); writes.set(f, text);
      }
    }
    for (const f of existing.filter(f => /\.html$/i.test(f) && !/Feedback(Form|KitLauncher)\.html$/i.test(f))) {
      const before = source(f), after = replaceLegacyModals(before);
      if (after !== before) writes.set(f, after);
    }
    writes.set(path.join(base, 'FeedbackKitIntegration.gs'), integration(appName, original));
    writes.set(path.join(base, 'FeedbackKitLauncher.html'), launcher);
  }
  const changes = [...writes].filter(([f, text]) => !fs.existsSync(f) || source(f) !== text);
  const widgetFiles = kind === 'next' ? files(root).filter(f => /Feedback(Widget|TriggerButton)|[/\\](layout\.(tsx|jsx)|api[/\\]feedback[/\\].*|feedback[/\\]page\.tsx|list-feedback\.mjs)$/.test(f)) : [];
  const overwrite = changes.some(([f]) => fs.existsSync(f) && /FeedbackForm|FeedbackRelay|\.html$/i.test(f)) || widgetFiles.some(f => /FeedbackWidget/.test(path.basename(f)));
  if (overwrite && !previous.kitVersion && !upgrade) throw new Error('既存フォームがあります。--upgrade を指定してください（変更前にバックアップします）');
  if (previous.kitVersion && previous.kitVersion !== kit.version && !upgrade) throw new Error('版の更新には --upgrade が必要です');
  const backup = f => {
    if (!fs.existsSync(f)) return;
    const bytes = fs.readFileSync(f);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0,16);
    const dest = path.join(root, '.feedback-kit-backup', digest, path.relative(root, f));
    if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); }
  };
  if (dryRun) return { dryRun: true, appName, kind, files: changes.map(([f]) => path.relative(root, f)), delegate: kind === 'next' ? 'widget/install.mjs --files-only' : null, registration: entry };
  if (kind === 'next') {
    for (const f of widgetFiles) backup(f);
    for (const f of files(path.join(root, 'supabase'), /\.sql$/)) backup(f);
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'tools/feedback-kit/widget/install.mjs'), '--target', root, '--app-name', appName, '--files-only', '--force'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('feedback-widget 導入失敗: ' + result.stderr);
  }
  for (const [f, text] of changes) { backup(f); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  registry.apps = [...registry.apps.filter(e => e.appName !== appName), entry];
  writeJson(registryFile, registry);
  if (repo) { apps[appName] = repo; writeJson(appsFile, apps); }
  const local = readJson(localFile, {});
  local[entry.refs.appDir] = root;
  if (repo) local[entry.refs.repo] = repo;
  writeJson(localFile, local);
  writeJson(metaFile, { kitVersion: kit.version, kind, appName, installedAt: previous.installedAt || new Date().toISOString() });
  const ignoreFile = path.join(root, '.gitignore');
  let ignores = fs.existsSync(ignoreFile) ? source(ignoreFile) : '';
  for (const line of ['.feedback-kit-backup/', '.env.local']) if (!ignores.split(/\r?\n/).includes(line)) ignores += (ignores.endsWith('\n') || !ignores ? '' : '\n') + line + '\n';
  fs.writeFileSync(ignoreFile, ignores);
  return { appName, kind, kitVersion: kit.version, files: changes.map(([f]) => path.relative(root, f)), registration: entry };
}

export function parseArgs(args) {
  const out = {};
  for (let i=0;i<args.length;i++) {
    const a=args[i];
    if (a === '--upgrade') out.upgrade=true;
    else if (a === '--dry-run') out.dryRun=true;
    else if (['--app','--name'].includes(a) && args[i+1] && !args[i+1].startsWith('--')) out[a.slice(2)] = args[++i];
    // 登録先の差し替え（検証・テスト用。通常は正本の tools/ 配下の既定値を使う）
    else if (['--registry','--apps','--local'].includes(a) && args[i+1] && !args[i+1].startsWith('--')) out[{'--registry':'registryFile','--apps':'appsFile','--local':'localFile'}[a]] = path.resolve(args[++i]);
    else throw new Error('不明または値のない引数: '+a);
  }
  if (!out.app) throw new Error('--app <dir> が必要です');
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(installApp(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode=1; }
}
