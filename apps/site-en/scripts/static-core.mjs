import {tokens,segments,decode,escape,hasJa} from './lib.mjs';
export const SITES={rebooth:'https://rebooth.co.jp',orgiast:'https://www.orgiast.jp'};
export function assertOutputPath(p){
 if(typeof p!=='string'||p.includes('\\')||/[\x00-\x1f?#%]/.test(p)||!p.startsWith('en/')||p.split('/').some(x=>x==='.'||x==='..'||!x))throw Error('Unsafe output path');
 if(/^en\/(?:expo-apply|en)(?:\/|$)/i.test(p))throw Error('Protected en/expo-apply or nested en path');
 if(!p.endsWith('/index.html')&&p!=='en/sitemap.xml'&&p!=='en/index.html')throw Error('Non-generated output path');
 return p;
}
export function outputPath(url){const p=new URL(url).pathname.replace(/^\/+|\/+$/g,'');return assertOutputPath('en/'+(p?p+'/':'')+'index.html');}
export const enUrl=url=>new URL('/'+outputPath(url).replace(/index\.html$/,''),url).href;
export function allSegments(html){
 const out=segments(html);
 for(const t of tokens(html))if(/^<meta\b/i.test(t.raw)&&/\b(?:name|property)\s*=\s*["'](?:description|og:title|og:description|twitter:title|twitter:description)["']/i.test(t.raw)){
  const m=t.raw.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);if(m){const start=t.index+m.index+m[0].indexOf(m[1])+1;out.push({start,end:start+m[2].length,text:decode(m[2]).trim(),attribute:'content'});}
 }
 return out.sort((a,b)=>a.start-b.start);
}
export function translateHtml(html,map){for(const s of allSegments(html).reverse()){if(map.has(s.text))html=html.slice(0,s.start)+escape(map.get(s.text)).replace(/'/g,'&#39;')+html.slice(s.end);}return html;}
const attr=(tag,name)=>decode(tag.match(new RegExp('\\s'+name+'\\s*=\\s*(["\'])(.*?)\\1','i'))?.[2]||'');
function setAttr(tag,name,value){const re=new RegExp('(\\s'+name+'\\s*=\\s*)(["\'])(.*?)\\2','i');return re.test(tag)?tag.replace(re,(_,prefix)=>prefix+'"'+escape(value)+'"'):tag.replace(/\s*\/?>$/,m=>' '+name+'="'+escape(value)+'"'+m);}
export function rewriteLinks(html,pageUrl){
 const origin=new URL(pageUrl).origin;
 return tokens(html).map(t=>{
  let tag=t.raw;if(!/^<[a-z]/i.test(tag)||/^<(script|style|noscript)\b/i.test(tag))return tag;
  if(/^<a\b/i.test(tag)){
   const href=attr(tag,'href');if(!href||/^(?:#|mailto:|tel:|javascript:|data:)/i.test(href))return tag;
   const u=new URL(href,pageUrl);
   if(u.origin===origin&&!/^\/(?:en(?:\/|$)|wp(?:\/|$)|wp-|\.well-known)/i.test(u.pathname)&&! /\.[a-z0-9]{1,8}$/i.test(u.pathname))tag=setAttr(tag,'href','/en'+u.pathname.replace(/\/$/,'')+'/'+u.search+u.hash);
   else if(/^\//.test(href)&&!href.startsWith('//')&&!u.pathname.startsWith('/en/'))tag=setAttr(tag,'href',u.href);
  }
  // Assets must continue resolving against the Japanese page, including relative URLs.
  for(const name of ['src','poster',...(/^<link\b/i.test(tag)?['href']:[])]){const v=attr(tag,name);if(v&&!/^(data:|#|https?:)/i.test(v))tag=setAttr(tag,name,new URL(v,pageUrl).href);}
  const srcset=attr(tag,'srcset');if(srcset&&!srcset.startsWith('data:'))tag=setAttr(tag,'srcset',srcset.split(',').map(v=>{const [url,...rest]=v.trim().split(/\s+/);return [new URL(url,pageUrl).href,...rest].join(' ');}).join(', '));
  return tag;
 }).join('').replace(/(<script\b[^>]*\bsrc\s*=\s*)(["'])(.*?)\2/gi,(_,b,q,v)=>b+'"'+escape(new URL(decode(v),pageUrl).href)+'"');
}
export function injectMetaTags(html,pageUrl,noindex=true){
 const english=enUrl(pageUrl);
 html=html.replace(/<html\b[^>]*>/i,t=>setAttr(t,'lang','en'));
 html=html.replace(/<meta\b[^>]*>/gi,t=>/^(robots|googlebot|bingbot)$/i.test(attr(t,'name'))?'':attr(t,'property')==='og:url'?setAttr(t,'content',english):attr(t,'property')==='og:locale'?setAttr(t,'content','en_US'):t);
 html=html.replace(/<link\b[^>]*>/gi,t=>attr(t,'rel')==='canonical'||attr(t,'hreflang')?'':t);
 const head=[noindex?'<meta name="robots" content="noindex,nofollow">':'',`<link rel="canonical" href="${escape(english)}">`,...['ja','en','x-default'].map(lang=>`<link rel="alternate" hreflang="${lang}" href="${escape(lang==='en'?english:pageUrl)}">`)].join('\n');
 html=html.replace(/<\/head\s*>/i,head+'\n</head>');
 return html.replace(/<body\b[^>]*>/i,t=>t+`\n<div id="site-en-language" style="position:absolute;top:0;right:0;z-index:9999;background:white;padding:3px 8px;font-size:12px"><a lang="ja" hreflang="ja" href="${escape(pageUrl)}">日本語</a></div>`);
}
export function replaceForms(html,endpoint=''){
 if(endpoint&&!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint))throw Error('Unexpected GAS endpoint');
 let replaced=false;
 html=html.replace(/<form\b[\s\S]*?<\/form\s*>/gi,form=>{if(!/wpcf7|mw_wp_form|contact/i.test(form))return form;replaced=true;
  if(!endpoint)return '<section class="site-en-contact"><h2>Contact us</h2><p>Please email <a href="mailto:seisaku-team@orgiast.jp">seisaku-team@orgiast.jp</a> or call <a href="tel:0120487121">0120-487-121</a>.</p></section>';
  return '<form class="site-en-gas-contact" action="'+escape(endpoint)+'" method="post">'+[['companyName','Company'],['country','Country'],['contactPerson','Name'],['email','Email'],['exhibitionName','Exhibition / event']].map(([name,label])=>'<label>'+label+'<input required name="'+name+'" type="'+(name==='email'?'email':'text')+'"></label>').join('')+'<label>Message<textarea name="message"></textarea></label><input name="honeypot" tabindex="-1" autocomplete="off" style="display:none"><button type="submit">Send</button><p role="status"></p></form>';
 });
 if(replaced)html=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,s=>/getElementById\(['"]js-form['"]\)|wpcf7mailsent/.test(s)?'':s);
 if(replaced&&endpoint)html=html.replace(/<\/body>/i,`<script>document.querySelectorAll('.site-en-gas-contact').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button'),status=form.querySelector('[role="status"]');button.disabled=true;status.textContent='Sending…';try{const data=Object.fromEntries(new FormData(form));data.lang='en';const response=await fetch(form.action,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(data)});const result=await response.json();if(!result.ok)throw new Error();status.textContent='Thank you. Your message has been sent.';form.reset();}catch{status.textContent='Sending could not be confirmed. Please email seisaku-team@orgiast.jp or call 0120-487-121.';}finally{button.disabled=false;}}));</script></body>`);
 return html;
}
export function residual(html){const text=allSegments(html).map(s=>s.text).join(' ');const count=(text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length;return {characters:count,total:[...text].length,rate:100*count/Math.max(1,[...text].length),samples:[...new Set(allSegments(html).filter(s=>hasJa(s.text)).map(s=>s.text))]};}
