import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyItems, extractReferences, extractQuestionPart } from '../tools/kim-inbox-triage.mjs';

describe('kim-inbox-triage', () => {
  describe('extractQuestionPart', () => {
    it('should include first line and last asking line from multi-line text', () => {
      const text = 'PR #123 の対応を完了しました。\n--apply を実行してもいいですか？';
      const result = extractQuestionPart(text);
      assert.ok(result.includes('PR #123 の対応を完了しました。'));
      assert.ok(result.includes('--apply を実行してもいいですか？'));
    });

    it('should return first and last line when no asking markers found', () => {
      const text = 'PR #123 がマージされました。\n特に問題はありません。';
      const result = extractQuestionPart(text);
      assert.ok(result.includes('PR #123 がマージされました。'));
      assert.ok(result.includes('特に問題はありません。'));
    });

    it('should return first line plus last 2 asking lines when multiple exist', () => {
      const text = 'PR #123 はどうしましょうか。\n--apply を実行してよいですか？\n承認をお願いします。';
      const result = extractQuestionPart(text);
      // first line is always included
      assert.ok(result.includes('PR #123 はどうしましょうか。'));
      // last 2 asking lines
      assert.ok(result.includes('--apply を実行してよいですか？'));
      assert.ok(result.includes('承認をお願いします。'));
    });

    it('should handle empty text', () => {
      assert.equal(extractQuestionPart(''), '');
      assert.equal(extractQuestionPart(null), '');
      assert.equal(extractQuestionPart(undefined), '');
    });

    it('should always include the first line in the result', () => {
      const text = 'タイトル行：問いの本体です。\nこれは説明文です。\n承認をお願いします。';
      const result = extractQuestionPart(text);
      assert.ok(result.includes('タイトル行'));
      assert.ok(result.includes('承認をお願いします。'));
    });
  });

  describe('classifyItems', () => {
    it('should classify item with MERGED PR and approval terms as C', () => {
      const items = [{
        id: 'test-id',
        text: 'PR #123 がマージされたので、--apply を実行して良いか確認してください。',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map([['#123', { state: 'MERGED' }]]),
        branchStates: new Map()
      };

      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'C');
    });

    it('should classify item with MERGED PR and no approval terms as A', () => {
      const items = [{
        id: 'test-id',
        text: 'PR #123 がマージされました。',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map([['#123', { state: 'MERGED' }]]),
        branchStates: new Map()
      };

      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'A');
    });

    it('should NOT block A on weak approval term "承認" alone', () => {
      const items = [{
        id: 'test-id-3',
        text: 'PR #123 の承認をお願いしていた件です。\nPR #123 がマージされました。',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map([['#123', { state: 'MERGED' }]]),
        branchStates: new Map()
      };

      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'A');
    });

    it('should NOT block A when strong term appears in body but not question', () => {
      const items = [{
        id: 'test-id-4',
        text: 'PR #123 の進捗報告です。\n前回 --apply を実行しました。\nPR #123 がマージされました。',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map([['#123', { state: 'MERGED' }]]),
        branchStates: new Map()
      };

      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'A');
    });

    it('should route to groupRule B when no MERGED evidence exists', () => {
      const items = [{
        id: 'test-id-5',
        text: 'PR #999 のマージ承認をお願いします。',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map(), // empty — no gh data for #999
        branchStates: new Map()
      };

      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'B');
      assert.equal(result.items[0].groupKey, 'pr-merge-approval');
    });

    // Regression: error 1 — ki-20261123182122-4aa0: first line contains the actual question
    it('should classify as C when first line asks approval question even with MERGED PR', () => {
      const items = [{
        id: 'ki-20261123182122-4aa0',
        text: 'kim-inbox の「判断不要な完了通知 29件」を自動クローズしてよいか（--apply の実行可否）\n\nPR #2661 で着地させました。\nこの 29 件を自動で「確認済み」にする仕組みです。\n「やって」と返していただければ実行して結果を報告します。',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map([['#2661', { state: 'MERGED' }]]),
        branchStates: new Map()
      };
      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'C');
    });

    // Regression: error 2 — ki-20261122181843-aebd: "〜してよいですか" pattern in body
    it('should classify as C when body asks "してよいですか" even with MERGED PR', () => {
      const items = [{
        id: 'ki-20261122181843-aebd',
        text: '【kim-inbox の未回答 180件を、1回の返信で 76件 減らす承認のお願い】\n\n対象の PR #814 は既にマージ済みです。\n1. 上の「もう答えなくてよい 33件」を、こちらでまとめて完了にしてよいですか（はい／いいえ）',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map([['#814', { state: 'MERGED' }]]),
        branchStates: new Map()
      };
      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'C');
    });

    // Anti-regression: A should still remain for truly done items with approval-context words
    it('should keep A when "承認" appears only in past-tense context with MERGED PR', () => {
      const items = [{
        id: 'anti-regression-1',
        text: 'PR #814 がマージされました。承認をお願いしていた件は完了です。',
        createdAt: '2026-11-23T18:21:22.721Z'
      }];
      const evidence = {
        prStates: new Map([['#814', { state: 'MERGED' }]]),
        branchStates: new Map()
      };
      const result = classifyItems(items, evidence);
      assert.equal(result.items[0].classification, 'A');
    });
  });
});