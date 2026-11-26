import test from 'node:test'; import assert from 'node:assert/strict';
import { parseTemplate, detectMessages } from './discord-appointment-capture.mjs';
test('澤山さん定型から会社・担当・メール・日時を抽出',()=>{const x=parseTemplate('企業名：不二化成株式会社\nアポ取得日：2026/12/8 14:00\nご担当者：森様\nメールアドレス：n-mori@fuji-kasei.com\nヒアリング内容：他社事例');assert.equal(x.client,'不二化成株式会社');assert.equal(x.email,'n-mori@fuji-kasei.com');assert.match(x.appointment,/12\/8/);});
test('全種類のDiscordチャットから送付依頼を検出',()=>{const chats=[{id:'guild'},{id:'group'},{id:'dm'}], h=new Map(chats.map(c=>[c.id,[{id:c.id,text:'URLの送付お願い',timestamp:'2026-11-26T00:00:00Z'}]]));assert.equal(detectMessages(chats,h,Date.parse('2026-11-25')).length,3);});
