import test from 'node:test';
import assert from 'node:assert/strict';
import { addRules, PROD_RULES, READ_RULES } from './add-permission-rules.mjs';

test('不足分だけ追記し、既存の allow と重複させない', () => {
  const settings = { permissions: { allow: ['Bash(git *)', READ_RULES[0]] } };
  const added = addRules(settings, READ_RULES);
  assert.equal(added.length, READ_RULES.length - 1);
  assert.equal(settings.permissions.allow.length, READ_RULES.length + 1);
  assert.deepEqual(addRules(settings, READ_RULES), []);
});

test('permissions が無い settings にも A+B の15行を追加できる', () => {
  const settings = {};
  addRules(settings, [...PROD_RULES, ...READ_RULES]);
  assert.equal(settings.permissions.allow.length, 15);
});
