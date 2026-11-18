import test from 'node:test';
import assert from 'node:assert/strict';
import {textIssues} from './validation.mjs';
test('compound Japanese quantities accept only arithmetic-equivalent English values',()=>{
 for(const [ja,en] of [['4億1,900万人','419 million people'],['5兆2923億円','JPY 5.2923 trillion'],['174億7,533万ドル','17.47533 billion dollars'],['60,000万点','600 million items']])assert.deepEqual(textIssues(ja,en),[]);
 assert.ok(textIssues('60,000万点','60 million items').some(x=>x.startsWith('extra numbers')));
 assert.ok(textIssues('2026年11月のIPOは８社上場です','2026年11月のIPOは８社上場です').length);
 assert.deepEqual(textIssues('2026年11月のIPOは８社上場です','8 companies are listing through IPOs in November 2026.'),[]);
});
