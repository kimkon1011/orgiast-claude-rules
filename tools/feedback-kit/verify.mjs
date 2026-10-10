#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { kit, readJson, detectKind, gasRoot, files, atLeast, registryPath } from './common.mjs';

export function verifyApp(app, {registryFile = registryPath} = {}) {
  const root = path.resolve(app), missing = [], details = {};
  let meta = {}, kind, registry;
  try { meta = readJson(path.join(root, '.feedback-kit.json'), {}); kind=detectKind(root); registry=readJson(registryFile, {apps:[]}); }
  catch { return { ok:false, kitVersion:null, missing:['metadata-or-registry-invalid'], details:{} }; }
  if (!kind || meta.kind !== kind || !meta.appName || !meta.installedAt) missing.push('kit-metadata');
  if (!atLeast(meta.kitVersion, kit.version)) missing.push('kit-version');
  let all=[];
  try { all=files(kind === 'gas' ? gasRoot(root) : root); } catch { missing.push('app-root'); }
  const read = f => fs.readFileSync(f, 'utf8');
  const ui = all.filter(f => kind === 'gas' ? /[/\\]FeedbackForm\.html$/i.test(f) : /[/\\]FeedbackWidget\.tsx$/.test(f)).map(read).join('\n');
  const backend = all.filter(f => kind === 'gas' ? /[/\\]FeedbackRelay\.(gs|js)$/i.test(f) : /[/\\]api[/\\]feedback[/\\]route\.ts$/.test(f)).map(read).join('\n');
  const markup = ui.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const inputs = markup.match(/<input\b[^>]*>/g) || [];
  const file = inputs.find(s => /type=["']file["']/.test(s)) || '';
  const imageChecks = {
    fileInput: /\bmultiple\b/.test(file) && /accept=["']image\/\*["']/.test(file),
    paste: /addEventListener\(['"]paste['"]|onPaste=/.test(markup),
    maxImages: /MAX_IMAGES\s*=\s*5\b/.test(markup) && />=\s*MAX_IMAGES/.test(markup),
    maxBytes: /MAX_IMAGE_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/.test(markup) && /file.size\s*>\s*MAX_IMAGE_BYTES/.test(markup),
    preview: /<img\b|createElement\(['"]img['"]\)/.test(markup),
    remove: /削除/.test(markup) && /images\.splice|removeImage\(/.test(markup),
  };
  details['image-attach']=imageChecks;
  const title = inputs.find(s => /(?:name|id)=["']title["']/.test(s)) || '';
  const body = (markup.match(/<textarea\b[^>]*>/g) || []).find(s => /(?:name|id)=["']body["']/.test(s)) || '';
  const entry = registry.apps?.find(e => e.appName === meta.appName);
  const registered = Boolean(entry && ['gas-sheet','supabase','booth-sheet','relay'].includes(entry.intake) && ['url','secret','repo','appDir'].every(k => /^[A-Z][A-Z0-9_]*$/.test(entry.refs?.[k] || '')));
  const checks = {
    'image-attach': Object.values(imageChecks).every(Boolean),
    'kind-toggle': /不具合/.test(markup) && /要望/.test(markup) && /(?:name|id)=["']kind["']/.test(markup),
    'title-optional-body-required': Boolean(title && body && !/\brequired\b/.test(title) && /\brequired\b/.test(body) && /if\s*\(!(?:payload\.)?body\)/.test(backend)),
    'notify-on-submit': /FEEDBACK_OWNER_DISCORD_ID/.test(backend) && /owner_discord_id/.test(backend) && /FEEDBACK_RELAY_URL/.test(backend) && /FEEDBACK_RELAY_SECRET/.test(backend),
    'dm-submitter-on-done': registered && /submitter_discord_id/.test(backend) && /完了/.test(markup),
    'zero-backlog-registered': registered,
  };
  for (const feature of kit.requiredFeatures) if (!checks[feature]) missing.push(feature);
  const integrated = kind === 'gas' ? all.some(f => /FeedbackKitIntegration\.gs$/.test(f) && /function doGet\(/.test(read(f)) && /FeedbackRelay_serveForm/.test(read(f))) : all.some(f => /[/\\]layout\.(tsx|jsx)$/.test(f) && /<FeedbackWidget\b/.test(read(f)) && /import.*FeedbackWidget/.test(read(f)));
  if (!integrated) missing.push('ui-integration');
  return {ok:!missing.length, appName:meta.appName || path.basename(root), kind, kitVersion:meta.kitVersion || null, requiredVersion:kit.version, missing, details};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  try {
    if (![2,4].includes(args.length) || args[0]!=='--app' || (args.length===4 && args[2]!=='--registry')) throw new Error('--app <dir> が必要です');
    const result=verifyApp(args[1], args[3] ? {registryFile:args[3]} : {}); console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1;
  } catch(e) {console.log(JSON.stringify({ok:false,missing:['verification-error'],error:e.message}));process.exitCode=1;}
}
