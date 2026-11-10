import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('reddit-monitor', () => {
  it('should match booth keywords in Japanese text', async () => {
    const { matchBoothKeywords, BOOTH_KEYWORDS } = await import('../tools/reddit-monitor.mjs');
    assert.ok(Array.isArray(BOOTH_KEYWORDS), 'BOOTH_KEYWORDS is an array');
    assert.ok(BOOTH_KEYWORDS.length >= 5, 'BOOTH_KEYWORDS has enough keywords');

    // 展示会関連の投稿がマッチする
    const boothPost = { title: '大阪で展示会ブース制作会社を探しています', selftext: '来月出展予定で施工会社を選んでいます' };
    const matched = matchBoothKeywords(boothPost);
    assert.ok(matched.length >= 2, 'should match 展示会 and ブース');
    assert.ok(matched.includes('展示会'), 'should match 展示会');
    assert.ok(matched.includes('ブース'), 'should match ブース');
  });

  it('should not match unrelated posts', async () => {
    const { matchBoothKeywords } = await import('../tools/reddit-monitor.mjs');
    const unrelatedPost = { title: '東京のラーメン屋おすすめ', selftext: '今日は新宿で美味しいラーメンを食べました' };
    const matched = matchBoothKeywords(unrelatedPost);
    assert.equal(matched.length, 0, 'should not match unrelated posts');
  });

  it('should generate blog ideas from booth-related posts', async () => {
    const { generateBlogIdeas } = await import('../tools/reddit-monitor.mjs');
    const posts = [
      { id: 'abc123', title: '展示会ブースの費用相場は？初めてで不安', selftext: '初めて展示会に出展します。ブース制作の費用相場を教えてください。', subreddit: 'japanlife', url: 'https://reddit.com/r/japanlife/test', score: 5, numComments: 3, createdUtc: Math.floor(Date.now() / 1000), createdDate: '2026-11-11', isQuestion: true },
    ];
    const ideas = generateBlogIdeas(posts);
    assert.ok(Array.isArray(ideas), 'returns an array');
    assert.equal(ideas.length, 1, 'generates one blog idea');
    assert.ok(ideas[0].suggestedTitle, 'has suggested title');
    assert.ok(ideas[0].targetKeyword, 'has target keyword');
    assert.ok(ideas[0].redditPost, 'has reddit URL');
  });

  it('should handle empty posts gracefully', async () => {
    const { generateBlogIdeas } = await import('../tools/reddit-monitor.mjs');
    const ideas = generateBlogIdeas([]);
    assert.equal(ideas.length, 0, 'no ideas for empty posts');
  });
});
