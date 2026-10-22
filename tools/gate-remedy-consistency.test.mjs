import assert from 'node:assert/strict';
import test from 'node:test';
import { REMEDY_EXAMPLES as accountExamples, judge as judgeUrlAccount } from './url-account-gate.mjs';
import { REMEDY_EXAMPLES as formatExamples, findBrokenRawUrl } from './url-format-guard.mjs';

const legacyAccountRemedy = 'https://github.com/org/repo（**kim の GitHub アカウント** で開く）';

test('修正前のURLアカウント見本がURL形式ゲートと矛盾することを再現', () => {
  assert.equal(findBrokenRawUrl(legacyAccountRemedy).decision, 'block');
});

test('各StopゲートのREMEDY_EXAMPLESは他のURL系Stopゲートを通る', () => {
  for (const example of accountExamples) {
    assert.equal(findBrokenRawUrl(example).decision, 'pass', example);
    assert.deepEqual(judgeUrlAccount(example).missing, [], example);
  }
  for (const example of formatExamples) assert.equal(findBrokenRawUrl(example).decision, 'pass', example);
});
