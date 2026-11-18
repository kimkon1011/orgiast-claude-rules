import test from 'node:test';
import assert from 'node:assert/strict';
import {assertOutputPath,outputPath,rewriteLinks,injectMetaTags,translateHtml,allSegments,residual,replaceForms} from './static-core.mjs';
import {verifyOwnership,chooseRoot,assertSnapshot} from './deploy-ftp.mjs';
import {changedPages} from './regen.mjs';
import {textIssues} from './validation.mjs';
test('numeric validation accepts source lists and padded dates, but rejects invented quantities',()=>{
 assert.deepEqual(textIssues('1，2，3部、2019年10月05日','Parts 1, 2 and 3; October 5, 2019'),[]);
 assert.deepEqual(textIssues('最大高3,600mm','Maximum height 3,600 mm'),[]);
 assert.deepEqual(textIssues('2万8,000名','28,000 employees'),[]);
 assert.deepEqual(textIssues('Q2.2021年度','Q2. Fiscal year 2021'),[]);
 assert.deepEqual(textIssues('②①を踏まえた経営ビジョン','② Management vision based on ①'),[]);
 assert.ok(textIssues('2017年6月に誕生した','Opened in June 2017 on the 38th floor').some(x=>x.includes('38')));
});
test('rewrite absolute, relative and root links while preserving query/hash and protected assets',()=>{
 const html='<a href="../company?ref=1#x">a</a><a href="/services">b</a><a href="https://www.orgiast.jp/wp/wp-admin/">admin</a><a href="/wp/wp-content/a.pdf">pdf</a><a href="/en/expo-apply/">expo</a><a href="#local">local</a><a href="https://example.com/">external</a><img src="../logo.png"><script src="/app.js"></script>';
 const out=rewriteLinks(html,'https://www.orgiast.jp/services/flow');
 assert.ok(out.includes('href="/en/company/?ref=1#x"'));assert.ok(out.includes('href="/en/services/"'));assert.ok(out.includes('href="https://www.orgiast.jp/wp/wp-admin/"'));assert.ok(out.includes('href="https://www.orgiast.jp/wp/wp-content/a.pdf"'));assert.ok(out.includes('href="/en/expo-apply/"'));assert.ok(out.includes('href="#local"'));assert.ok(out.includes('src="https://www.orgiast.jp/logo.png"'));assert.ok(out.includes('src="https://www.orgiast.jp/app.js"'));assert.ok(!out.includes('/en/en/'));
});
test('all path encodings and traversal variants are rejected before FTP mutation',()=>{
 for(const p of ['en/expo-apply/index.html','en/EXPO-APPLY/a/index.html','en/expo-apply','en/en/expo-apply/wp/index.html','en/%65xpo-apply/index.html','en/../wp/index.html','en/a/../../x/index.html','en\\expo-apply\\index.html','../en/index.html','en//index.html'])assert.throws(()=>assertOutputPath(p));
 assert.equal(assertOutputPath('en/about/index.html'),'en/about/index.html');assert.equal(outputPath('https://rebooth.co.jp/'),'en/index.html');
});
test('replace conflicting robots and canonical, add three language alternates; index flag removes robots',()=>{
 const input='<html lang="ja"><head><meta content="index,follow" name="robots"><meta name="googlebot" content="index"><link href="wrong" rel="canonical"></head><body>text</body></html>';
 const out=injectMetaTags(input,'https://rebooth.co.jp/about/');assert.ok(out.includes('<html lang="en">'));assert.equal((out.match(/name="robots"/g)||[]).length,1);assert.ok(out.includes('noindex,nofollow'));assert.ok(!out.includes('index,follow'));assert.ok(out.includes('href="https://rebooth.co.jp/en/about/"'));assert.equal((out.match(/hreflang="x-default"/g)||[]).length,1);assert.ok(out.includes('>日本語</a>'));assert.ok(!injectMetaTags(input,'https://rebooth.co.jp/',false).includes('name="robots"'));
});
test('translations preserve markup, script and machine values but replace meta and submit value',()=>{
 const html='<title>会社</title><meta name="description" content="会社"><img alt="会社" src="/日本.jpg"><input type="hidden" value="会社"><input type="submit" value="送信"><p title=\'会社\'>会社</p><script>const a="会社";</script>';
 const out=translateHtml(html,new Map([['会社',"Company's"],['送信','Send']]));assert.ok(out.includes('content="Company&#39;s"'));assert.ok(out.includes('value="Send"'));assert.ok(out.includes('type="hidden" value="会社"'));assert.ok(out.includes('src="/日本.jpg"'));assert.ok(out.includes('const a="会社"'));assert.equal(allSegments(out).filter(s=>s.text==='会社').length,0);
});
test('Japanese rate measures text/accessible attributes, excluding scripts/URLs',()=>{
 assert.equal(residual('<p>English</p><script>日本語</script><img src="日本.jpg">').characters,0);assert.equal(residual('<p>日本語</p>').characters,3);assert.equal(residual('<img alt="会社">').characters,2);
});
test('unconfigured contact forms become working mail and phone links, no WP submit',()=>{
 const out=replaceForms('<form class="wpcf7-form" action="/contact"><input type="submit"></form>');assert.ok(!out.includes('<form'));assert.ok(out.includes('mailto:seisaku-team@orgiast.jp'));assert.ok(out.includes('0120-487-121'));
});
test('deployment fails closed for foreign or modified files, ambiguous docroots and changed protected sizes',()=>{
 assert.throws(()=>verifyOwnership('en/index.html',true,'abc',null));assert.throws(()=>verifyOwnership('en/index.html',true,'abc',{sha256:'def'}));assert.doesNotThrow(()=>verifyOwnership('en/index.html',true,'abc',{sha256:'abc'}));assert.doesNotThrow(()=>verifyOwnership('en/index.html',false,null,null));
 assert.throws(()=>chooseRoot([{root:'/web',matches:['one']}]));assert.equal(chooseRoot([{root:'/web',matches:['one','two']}]),'/web');assert.throws(()=>chooseRoot([{root:'/web',matches:['one','two']},{root:'/other',matches:['one','two']}]));assert.throws(()=>assertSnapshot([{name:'index.html',size:2}],[{name:'index.html',size:3}]));
});
test('incremental lastmod checks include new pages with empty lastmod',()=>{
 const pages=[{url:'https://example.com/a/',lastmod:''},{url:'https://example.com/b/',lastmod:'new'}];assert.equal(changedPages(pages,{}).length,2);assert.equal(changedPages(pages,{'https://example.com/a':'','https://example.com/b':'old'}).length,1);
});
