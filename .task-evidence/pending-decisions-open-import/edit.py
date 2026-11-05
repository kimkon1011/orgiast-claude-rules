from pathlib import Path
root=Path('.wt/pending-decisions-open-import/tools')
p=root/'pending-decisions.mjs'
s=p.read_text()
s=s.replace('export function listDecisions(', "// Legacy producers used open for the same unbatched state as pending.\n// Keep all other states distinct so completed/invalid records are not imported.\nexport function normalizeDecisionStatus(status) {\n  return status === 'open' ? 'pending' : status;\n}\n\nexport function listDecisions(")
s=s.replace('record.status === status', 'normalizeDecisionStatus(record?.status) === normalizeDecisionStatus(status)')
p.write_text(s)
p=root/'pending-decisions.test.mjs'
s=p.read_text()+'''

test('pending and legacy open share a filter without rewriting stored status', t => {
  const dir = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = ['pending', 'open', 'batched', 'resolved', 'closed', 'done', 'cancelled', 'invalid', '', null].map((status, i) => ({ id: String(i), status, text: 'decision' }));
  records.push({ id: 'missing', text: 'no status' });
  fs.mkdirSync(path.dirname(queuePath({ home: dir })), { recursive: true });
  const original = records.map(r => JSON.stringify(r)).join('\\n') + '\\n';
  fs.writeFileSync(queuePath({ home: dir }), original);
  for (const status of ['pending', 'open']) {
    assert.deepEqual(listDecisions({ home: dir, status }).map(r => r.id), ['0', '1']);
  }
  assert.equal(listDecisions({ home: dir, status: 'resolved' })[0].id, '3');
  assert.deepEqual(listDecisions({ home: dir }), records);
  assert.equal(fs.readFileSync(queuePath({ home: dir }), 'utf8'), original);
});
'''
p.write_text(s)
p=root/'morning-batch.test.mjs'
s=p.read_text()+'''

test('October 9 legacy open decisions reach kim-inbox once and dry-run preserves the queue', async t => {
  const dir = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capturedAt = '2026-10-09T06:00:00.000Z';
  const open = Array.from({ length: 5 }, (_, i) => ({
    id: `20261009060000000-00${i + 1}`, status: 'open', capturedAt,
    source: 'fleet-mail:nishi-PC', text: `legacy decision ${i + 1}`,
  }));
  const excluded = ['batched', 'resolved', 'closed', 'done', 'cancelled', 'invalid'].map(status => ({
    id: status, status, capturedAt, text: `excluded ${status}`,
  }));
  const pending = { id: 'new-pending', status: 'pending', capturedAt, text: 'new pending' };
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\\n');
  const queue = path.join(dir, '.claude', 'pending-decisions.jsonl');
  const original = [...open, pending, ...excluded].map(r => JSON.stringify(r)).join('\\n') + '\\n';
  fs.writeFileSync(queue, original);
  const options = { home: dir, intakeImpl: emptyIntake, fetchImpl: async () => assert.fail('unexpected network request') };
  const preview = await runMorning({ ...options, dryRun: true });
  assert.equal(preview.count, 6);
  assert.equal(fs.readFileSync(queue, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'kim-inbox')), false);
  const result = await runMorning(options);
  assert.equal(result.count, 6);
  assert.equal(result.sent, true);
  const inbox = path.join(dir, '.claude', 'kim-inbox');
  const files = fs.readdirSync(inbox).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const item = JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf8'));
  const handoff = fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8');
  for (const row of open) {
    assert.ok(item.text.includes(row.text));
    assert.ok(handoff.includes(row.id));
  }
  assert.doesNotMatch(item.text, /excluded/);
  const records = listDecisions({ home: dir });
  assert.ok(records.slice(0, 6).every(r => r.status === 'batched'));
  assert.deepEqual(records.slice(6), excluded);
  assert.equal((await runMorning(options)).count, 0);
  assert.equal(fs.readdirSync(inbox).filter(f => f.endsWith('.json')).length, 1);
});
'''
p.write_text(s)
