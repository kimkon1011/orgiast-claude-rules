const base='https://rebooth-lp.vercel.app';
const paths=['/','/a','/b','/a/thanks','/b/thanks','/c','/_verify/a-mobile-375.png','/_verify/b-mobile-375.png','/_verify/a-thanks-mobile-375.png','/_verify/a-desktop-1280.png'];
for(const p of paths){
  const r=await fetch(base+p,{redirect:'manual'});
  const buf=Buffer.from(await r.arrayBuffer());
  const t=buf.toString('utf8');
  const title=(t.match(/<title>([^<]*)/)||[])[1]||'';
  const h1=((t.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)||[])[1]||'').replace(/<[^>]+>/g,'');
  const tel=(t.match(/tel:0120487121/g)||[]).length;
  const bad=(t.match(/Re[:：]ブース/g)||[]).length;
  console.log(JSON.stringify({p,status:r.status,loc:r.headers.get('location'),type:r.headers.get('content-type'),bytes:buf.length,title,h1,tel,bad,noindex:/noindex/.test(t)}));
}
