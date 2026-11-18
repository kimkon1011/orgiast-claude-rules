import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,mainContent,segments,applySegments,visible} from './lib.mjs';
import {validate,textIssues,numbers} from './validation.mjs';
test('nested div extraction retains final paragraphs, even with stray div closures',()=>{
 assert.equal(mainContent('<body><div id="contentsArea"><div>会社</div><p>最後</p></div><footer>x</footer></body>','orgiast'),'<div id="contentsArea"><div>会社</div><p>最後</p></div>');
 assert.equal(mainContent('<body><div><main><div>先</div></div><p>最後</p></main></body>','rebooth'),'<main><div>先</div></div><p>最後</p></main>');
});
test('text nodes, trailing text and attributes translate without touching URLs/scripts',()=>{
 const ja='<p title="会社">前<a class="x" href="/日本/">中</a>後<img src="x" alt="画像"></p><script>const x="日本";</script>';
 const en=applySegments(ja,new Map([['会社','Company'],['前','Before'],['中','Inside'],['後','After'],['画像','Image']]));
 assert.equal(visible(en),'Company Before Inside After Image');
 assert.ok(en.includes('href="/日本/"'));assert.ok(en.includes('<script>const x="日本";</script>'));
});
test('tag count is exact; numeric strings in class/src cannot authorize new claims',()=>{
 const source={title:'',content_html:'<a href="/12/">会社</a><img src="3.png">',_source_hash:'x'};
 const en={title:'',content_html:'<a href="/12/">Company 12</a><img src="3.png">',_source_hash:'x'};
 assert.ok(validate(source,en).issues.some(s=>s.includes('extra numbers')));
 en.content_html='<a href="/12/">Company</a>';assert.ok(validate(source,en).issues.includes('img count mismatch'));
});
test('equivalent numeric notation, explicit name policy and source-attested glosses',()=>{
 assert.ok(numbers('８割、500万円').includes('80'));assert.ok(numbers('500万円').includes('5000000'));
 assert.deepEqual(textIssues('株式会社架空','Kabushiki Kaisha Kakuu (株式会社架空)'),[]);
 assert.deepEqual(textIssues('金功勇','金功勇 (Representative Director & President)'),[]);
 assert.ok(textIssues('金功勇','Koyu Kim').length);
 assert.ok(textIssues('会社です','会社です').length);
 assert.ok(textIssues('実績','Over 100 projects').length);
});
test('source hash invalidation prevents stale translation reuse',()=>{
 assert.ok(validate({title:'',content_html:'',_source_hash:'new'},{title:'',content_html:'',_source_hash:'old'}).issues.includes('source hash mismatch'));
});

