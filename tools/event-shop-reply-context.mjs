#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCredentials, messageQuery } from './event-shop-inquiry-triage.mjs';
import { isEntry } from './is-entry.mjs';

const aliases = { イントロドン: 'quiz-intro-don', 格付け: 'kakuzuke-check', 縁日: 'ennichi' };
const core = s => String(s).replace(/【[^】]*】/g, '').replace(/[^\p{L}\p{N}]/gu, '');
const cell = s => String(s ?? '').replace(/\|/g, '／').replace(/[\r\n]/g, ' ');
const amounts = s => [...String(s).normalize('NFKC').matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)円/g)].map(m => Number(m[0].replace(/[,円]/g, '')));
const generic = new Set(['イベント', 'ゲーム', '企画', 'スライド', 'セット', 'レンタル', '大会']);
const matches = (text, p, minimum = 4) => {
  const keyword = core(String(p.name).split(/[｜|/／・]/)[0]);
  return (keyword.length >= minimum && !generic.has(keyword) && core(text).includes(keyword)) || Object.entries(aliases).some(([a, slug]) => slug === p.slug && core(text).includes(a));
};
const heading = line => core(String(line).normalize('NFKC').split(/(?:\d{1,3}(?:,\d{3})+|\d+)円/)[0]);
function section(text, n) { return text.match(new RegExp(`^## ${n}\\. [^\\n]*\\n([\\s\\S]*?)(?=^## \\d+\\. |$(?![\\s\\S]))`, 'm'))?.[1] || ''; }
function inquiryFields(payload) {
  const fields = [], excluded = /draft|reply|ai|suggest|generated|下書き|返信/i;
  const walk = (value, keys = []) => {
    if (keys.some(k => excluded.test(k))) return;
    if (typeof value === 'string') {
      if (!/概算のお見積り目安|ご案内いたします/.test(value)) fields.push({ key: keys.at(-1), value });
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, [...keys, key]);
    }
  };
  walk(payload);
  const priorities = ['message', 'inquiry', 'body', 'content', 'detail', 'note', '内容', 'ご相談内容'];
  const longest = list => [...list].sort((a, b) => b.value.length - a.value.length)[0]?.value;
  return { fields, inquiry: priorities.map(key => longest(fields.filter(f => f.key?.toLowerCase() === key))).find(Boolean) || longest(fields) || '' };
}
const sequence = content => {
  const m = String(content || '').match(/【返信案\s*(\d+)\s*[/／]\s*(\d+)】|[（(]\s*(\d+)\s*[/／]\s*(\d+)\s*[)）]|(?:^|\s)(\d+)\s*[/／]\s*(\d+)(?=\s|$)/m);
  if (!m) return null;
  const n = Number(m[1] || m[3] || m[5]), total = Number(m[2] || m[4] || m[6]);
  return n >= 1 && n <= total ? { n, total } : null;
};
function relatedMessages(messages, terms) {
  const seeds = messages.filter(m => terms.some(t => `${m.content || ''} ${(m.attachments || []).map(a => a.filename).join(' ')}`.toLowerCase().includes(t)));
  const sameAuthor = (a, b) => Boolean(a.author?.id && b.author?.id && a.author.id === b.author.id);
  const distance = (a, b) => Math.abs(Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const nearby = messages.filter(m => seeds.includes(m) || seeds.some(seed => sameAuthor(m, seed) && distance(m, seed) <= 15 * 60000));
  const numbered = nearby.filter(m => sequence(m.content));
  return messages.filter(m => nearby.includes(m) || numbered.some(seed => sameAuthor(m, seed) && distance(m, seed) <= 86400000 && sequence(m.content)?.total === sequence(seed.content).total));
}
export function checkDraft(draft, context) {
  const internal = new Set(amounts(section(context, 2)));
  const products = section(context, 4).split('\n').map(l => l.split('|').slice(1, -1).map(s => s.trim())).filter(r => r.length === 4 && /^\d[\d,]*$/.test(r[2])).map(([slug, name, price]) => ({ slug, name, price: Number(price.replaceAll(',', '')) }));
  const byProduct = new Map(), byHeading = new Map();
  const add = (map, key, nums) => map.set(key, new Set([...(map.get(key) || []), ...nums]));
  for (const line of section(context, 2).split(/\r?\n/)) {
    const nums = amounts(line);
    if (!nums.length) continue;
    const ps = products.filter(p => matches(line, p, 1));
    if (ps.length) ps.forEach(p => add(byProduct, p.slug, nums));
    else if (heading(line)) add(byHeading, heading(line), nums);
  }
  let prior = [], subtotal, net, tax;
  return draft.split(/\r?\n/).flatMap((line, i) => {
    const nums = amounts(line);
    if (!nums.length) { prior = []; subtotal = net = tax = undefined; return []; }
    const ps = products.filter(p => matches(line, p, 1));
    const sum = prior.reduce((a, b) => a + b, 0);
    const computed = /小計/.test(line) ? sum : /手数料/.test(line) ? subtotal * .2 : /税抜/.test(line) ? subtotal * 1.2 : /消費税/.test(line) ? net * .1 : /合計|税込/.test(line) ? net + tax : NaN;
    const judgments = nums.map(n => {
      if (ps.length) {
        if (ps.some(p => byProduct.get(p.slug)?.has(n))) return { status: 'OK', reason: '社内返信案と一致' };
        const priced = ps.filter(p => p.price === n);
        const conflicting = priced.flatMap(p => [...(byProduct.get(p.slug) || [])]);
        if (conflicting.length) return { status: 'WARN', reason: `社内返信案では ${[...new Set(conflicting)].map(v => v.toLocaleString('en-US')).join('、')} 円。商品定価と社内判断額が違う` };
        return { status: priced.length || internal.has(n) ? 'OK' : 'NG', reason: priced.length || internal.has(n) ? '社内金額・商品価格・計算値と一致' : '商品価格および社内金額と不一致' };
      }
      const expected = byHeading.get(heading(line));
      if (expected?.has(n)) return { status: 'OK', reason: '社内返信案と一致' };
      if (expected?.size && !internal.has(n) && !(Math.abs(n - computed) < .01)) return { status: 'WARN', reason: `社内返信案では ${[...expected].map(v => v.toLocaleString('en-US')).join('、')} 円。見出し語の金額と不一致` };
      return { status: internal.has(n) || Math.abs(n - computed) < .01 ? 'OK' : 'WARN', reason: internal.has(n) || Math.abs(n - computed) < .01 ? '社内金額・商品価格・計算値と一致' : '社内金額にも計算値にも一致しない' };
    });
    const { status, reason } = judgments.find(r => r.status === 'NG') || judgments.find(r => r.status === 'WARN') || judgments[0];
    if (/小計/.test(line)) subtotal = nums[0];
    else if (/税抜/.test(line)) net = nums[0];
    else if (/消費税/.test(line)) tax = nums[0];
    prior.push(...nums);
    return [{ line: i + 1, text: line, status, reason }];
  });
}
function parse(args) {
  const command = args[0], opts = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === '--no-mail') { opts[key] = true; continue; }
    if (!['--lead', '--email', '--company', '--out', '--days', '--draft', '--context'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || opts[key]) throw Error('引数不正');
    opts[key] = args[++i];
  }
  const allowed = command === 'collect' ? ['--lead','--email','--company','--out','--days','--no-mail'] : ['--draft','--context'];
  if (!['collect','check'].includes(command) || Object.keys(opts).some(k => !allowed.includes(k))) throw Error('引数不正');
  if (command === 'check' ? !opts['--draft'] || !opts['--context'] : ['--lead','--email','--company'].filter(k => opts[k]).length !== 1 || (opts['--lead'] && !/^[a-f\d-]{8,36}$/i.test(opts['--lead'])) || (opts['--days'] && !/^[1-9]\d*$/.test(opts['--days']))) throw Error('引数不正');
  return { command, opts };
}
export async function main({ env = process.env, args = process.argv.slice(2), fetchImpl = globalThis.fetch, spawnSyncImpl = spawnSync, now = new Date(), log = console.log, home = os.homedir() } = {}) {
  let parsed;
  try { parsed = parse(args); } catch { log('引数不正: collect (--lead <prefix>|--email <email>|--company <name>) / check --draft <file> --context <file>'); return 64; }
  const { command, opts } = parsed;
  let secrets = [env.DISCORD_BOT_TOKEN, env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean);
  const safe = v => { let s = String(v ?? ''); for (const secret of secrets) s = s.split(secret).join('[REDACTED]'); return s; };
  try {
    if (command === 'check') {
      const rows = checkDraft(await readFile(opts['--draft'], 'utf8'), await readFile(opts['--context'], 'utf8'));
      rows.forEach(r => log(`${r.line}: ${r.text} | ${r.status} | ${r.reason}`));
      return rows.some(r => r.status === 'NG') ? 1 : 0;
    }
    const credentials = await loadCredentials(env);
    if (!credentials.url || !credentials.key) throw Error('Supabase 資格情報なし');
    secrets.push(credentials.key);
    const request = async (url, init = {}) => {
      const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      return r;
    };
    const db = async q => (await request(`${credentials.url.replace(/\/$/, '')}/rest/v1/${q}`, { headers: { apikey: credentials.key, Authorization: `Bearer ${credentials.key}` } })).json();
    const since = new Date(new Date(now).getTime() - Number(opts['--days'] || 30) * 86400000).toISOString();
    let leads = [], offset = 0;
    while (true) {
      const page = await db(`quote_requests?select=id,company_name,contact_name,email,event_name,preferred_date,created_at,status,raw_payload&source=eq.event-shop.jp&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc,id.asc&limit=1000&offset=${offset}`);
      leads.push(...page); if (page.length < 1000) break; offset += page.length;
    }
    leads = leads.filter(l => opts['--lead'] ? l.id.toLowerCase().startsWith(opts['--lead'].toLowerCase()) : opts['--email'] ? l.email?.toLowerCase() === opts['--email'].toLowerCase() : l.company_name?.includes(opts['--company']));
    if (leads.length !== 1) throw Error(`問合せの一致件数 ${leads.length}。一意に指定してください`);
    const lead = leads[0], out = path.resolve(opts['--out'] || path.join(home, '.claude/event-shop-reply-context', lead.id.slice(0, 8)));
    await mkdir(out, { recursive: true });
    let payload = lead.raw_payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = { message: payload }; } }
    const { fields, inquiry } = inquiryFields(payload);
    const selections = fields.filter(f => /商品|product|select/i.test(f.key || '') && f.value !== inquiry);
    const parts = [`## 1. 問合せ\n\n${Object.entries(lead).filter(([k]) => k !== 'raw_payload').map(([k,v]) => `${k}: ${v ?? ''}`).join('\n')}\n\n${inquiry}\n${selections.map(f => `${f.key}: ${f.value}`).join('\n')}\n\nAI 自動下書き（draft / reply）は参考にしない（過去に誤案あり）。`];
    const notes = [], found = new Map();
    let token = env.DISCORD_BOT_TOKEN;
    if (!token) { try { token = (await readFile(path.join(home,'.claude/orgiast-discord-bot-token.txt'),'utf8')).trim(); } catch {} }
    if (token) secrets.push(token);
    const discord = async (endpoint, body) => (await request(`https://discord.com/api/v10${endpoint}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    let staff = [{name:'kim',id:'715210673642012733'},{name:'森あさ美',id:'1101062205337776138'}];
    try { staff = JSON.parse(await readFile(path.join(home,'.claude/event-shop-staff.json'),'utf8')); } catch (e) { if (e.code !== 'ENOENT') notes.push('未確認（スタッフ設定不正）'); }
    const terms = [lead.company_name,lead.contact_name,lead.email?.split('@')[1],lead.id.slice(0,8)].filter(Boolean).map(s => s.toLowerCase());
    const channels = ['1382885390138216549'];
    if (!token) notes.push('未確認（Discord Bot トークンなし）');
    else {
      for (const person of staff) { try { channels.push((await discord('/users/@me/channels',{recipient_id:person.id})).id); } catch(e) { notes.push(`${person.name}: 未確認（${safe(e.message)}）`); } }
      for (const channel of new Set(channels)) {
        try {
          let before = '';
          const channelMessages = [];
          for (let p=0;p<3;p++) {
            const messages = await discord(`/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ''}`);
            channelMessages.push(...messages);
            if (messages.length < 100) break;
            before = messages.at(-1).id;
          }
          for (const m of relatedMessages(channelMessages, terms)) found.set(m.id, m);
        } catch(e) { notes.push(`${channel}: 未確認（${safe(e.message)}）`); }
      }
    }
    const internal = [];
    for (const m of [...found.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp))) {
      internal.push(`### ${cell(m.author?.username)} / ${new Date(m.timestamp).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} JST\n\n${m.content || ''}`);
      for (const [index,a] of (m.attachments || []).entries()) {
        if (!/\.(txt|md|pdf|png|jpg)$/i.test(a.filename) || a.size > 10*1024*1024) { internal.push('添付保存対象外（拡張子または10MB上限）'); continue; }
        try {
          const r = await request(a.url);
          if (Number(r.headers?.get('content-length')) > 10*1024*1024) throw Error('10MB上限');
          const chunks = []; let size = 0;
          for await (const chunk of r.body) { size += chunk.length; if(size > 10*1024*1024) throw Error('10MB上限'); chunks.push(Buffer.from(chunk)); }
          const data = Buffer.concat(chunks), file = path.join(out,`${String(m.id).replace(/[^\w-]/g,'_')}-${index}-${a.filename.replace(/[^\p{L}\p{N}._-]/gu,'_')}`);
          if (/\.(txt|md)$/i.test(a.filename)) { const content = safe(data.toString('utf8')); await writeFile(file,content); internal.push(`添付: ${file}\n\n${content.slice(0,20000)}`); }
          else { if (secrets.some(s => data.includes(Buffer.from(s)))) throw Error('秘密値を含む添付'); await writeFile(file,data); internal.push(`添付: ${file}`); }
        } catch(e) { internal.push(`添付: 未確認（${safe(e.message)}）`); }
      }
    }
    parts.push(`## 2. 社内の返信案・指示（最優先の材料）\n\n${[...notes,...internal].join('\n\n') || '該当メッセージなし'}`);
    const mail = [];
    let mailCount = 0;
    if (opts['--no-mail']) mail.push('メール検索省略（--no-mail）');
    else {
      try {
        const r = spawnSyncImpl(process.execPath,[fileURLToPath(new URL('./seisaku-mail.mjs',import.meta.url)),'search','--query',`${lead.email} newer_than:60d`,'--max','20','--json'],{shell:false,windowsHide:true,timeout:900000,encoding:'utf8'});
        if(r.error || r.status !== 0) throw Error('メール検索実行失敗');
        const data = JSON.parse(r.stdout); if (!Array.isArray(data.messages)) throw Error('メール検索応答形式不正');
        mailCount = data.messages.length;
        mail.push('| date | from | to | subject | snippet |\n| --- | --- | --- | --- | --- |',...data.messages.map(m=>`| ${['date','from','to','subject','snippet'].map(k=>cell(m[k])).join(' | ')} |`));
      } catch(e) { mail.push(`未確認（${safe(e.message)}）`); }
    }
    let messages = [];
    try { messages = await db(messageQuery(lead).replace('/rest/v1/','')); mail.push(...messages.map(m=>`${m.direction} / ${m.received_at} / ${m.subject}\n\n${String(m.body || '').slice(0,1500)}`)); } catch(e) { mail.push(`未確認（${safe(e.message)}）`); }
    parts.push(`## 3. メール往復（seisaku-team@）\n\n${mail.join('\n\n')}`);
    const products = (await db('products?select=slug,name,price_min,price_max,unit,category&published=eq.true&limit=1000')).filter(p=> matches(`${fields.map(f => f.value).join('\n')}\n${internal.join('\n')}`,p));
    parts.push(`## 4. 商品と正規価格\n\n| slug | name | price | unit |\n| --- | --- | --- | --- |\n${products.map(p=>`| ${cell(p.slug)} | ${cell(p.name)}${!matches(`${inquiry}\n${internal.join('\n')}`, p) ? ' (フォーム選択のみ)' : ''} | ${Number(p.price_min).toLocaleString('en-US')} | ${cell(p.unit)} |`).join('\n')}\n\n価格は商品ごとの price_min を使う。料金ページのカテゴリ要約（例: ゲームスライド 11,000円〜 は汎用商品 game-slide の価格）を個別商品の価格に流用しない。社内の返信案（節2）に金額があればそれを優先し、商品価格と違う場合は返信案の値を使う。`);
    parts.push('## 5. 下書き前チェックリスト\n\n- [ ] 社内返信案の有無を確認した\n- [ ] 金額は節2か節4の値だけ\n- [ ] 見積書式（本体→送料→小計→管理手数料20%→税抜合計→消費税10%→税込合計、倉庫引取=送料0円の併記）\n- [ ] 企画書等の添付は Drive 共有で送付\n- [ ] 送信後は同スレッドの古い下書きを seisaku-mail.mjs delete-draft で消す\n- [ ] 障害時アナログ運営の一文（システムを使う企画の場合）');
    const file = path.join(out,'reply-context.md'); await writeFile(file,safe(parts.join('\n\n')));
    log(safe(`${file}\n問合せ: 1件 / 社内返信案: ${found.size}件 / メール検索: ${mailCount}件 / メールDB: ${messages.length}件 / 商品: ${products.length}件 / チェックリスト: 6件`));
    return 0;
  } catch(e) { log(safe(`エラー: ${e.message}`)); return 1; }
}
if (isEntry(import.meta.url)) { process.exitCode = await main(); }
