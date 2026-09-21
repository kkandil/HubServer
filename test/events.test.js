'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { EventEngine, key, matches, equal } = require('../events');
const h = { homeName: 'TestHome' };
const item = (varName, varValue = '1', join = 'AND') => ({ deviceID: 1, varName, varValue, join });
const input = (conditions = [item('a')], actions = [item('out')]) => ({ ...h, name: 'Test event', enabled: true, conditions, actions });
function setup(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const values = new Map(['a', 'b', 'c', 'out', 'out2'].map(v => [v, { Type: 'int', Value: '0', deviceName: 'Test' }]));
  let now = new Date('2026-09-21T12:00:00Z');
  const sent = [];
  let offline = false;
  const options = { resolveTarget: async x => values.get(x.varName), clock: () => now, dispatch: async x => { sent.push(x); return offline ? 'skipped_offline' : 'sent'; } };
  let engine = new EventEngine(sql, options);
  return { get engine() { return engine; }, sent, values,
    advance() { now = new Date(now.getTime() + 6000); }, offline() { offline = true; },
    async change(name, value) { values.get(name).Value = value; await engine.changed({ ...h, ...item(name, value) }); },
    async restart() { engine = new EventEngine(sql, options); await engine.start(); } };
}
test('AND precedence and OR alternatives, numeric/bool normalization and exact text', () => {
  const rule = input([item('a'), item('b'), item('c','1','OR')]);
  rule.conditions.forEach(c => c.varType='int');
  const values = new Map(['a','b','c'].map(v => [key({ ...h, ...item(v) }), '0']));
  assert.equal(matches(rule,values),false);
  values.set(key({ ...h,...item('a') }),'1'); assert.equal(matches(rule,values),false);
  values.set(key({ ...h,...item('b') }),'1.0'); assert.equal(matches(rule,values),true);
  values.set(key({ ...h,...item('a') }),'0'); values.set(key({ ...h,...item('c') }),'1'); assert.equal(matches(rule,values),true);
  assert.equal(equal('true','1','bool'),true); assert.equal(equal('','0','float'),false);
  assert.equal(equal('ON','on','string'),false); assert.equal(equal(null,'','string'),false);
});
test('rising edge only, multiple actions, persistence, disabled and enable baseline', async t => {
  const f=setup(t), rule=await f.engine.save(input([item('a'),item('b')],[item('out'),item('out2')]));
  await f.change('a','1'); assert.equal(f.sent.length,0);
  await f.change('b','1'); assert.equal(f.sent.length,2);
  await f.change('b','1'); assert.equal(f.sent.length,2);
  await f.restart(); await f.change('a','1'); assert.equal(f.sent.length,2);
  f.advance(); await f.change('a','0'); await f.change('a','1'); assert.equal(f.sent.length,4);
  await f.engine.toggle({ ...h, id:rule.id, enabled:false }); f.advance();
  await f.change('a','0'); await f.change('a','1'); assert.equal(f.sent.length,4);
  await f.engine.toggle({ ...h, id:rule.id, enabled:true }); await f.change('a','1'); assert.equal(f.sent.length,4);
  await f.change('a','0'); await f.change('a','1'); assert.equal(f.sent.length,6);
  await f.change('a','0'); await f.change('a','1'); assert.equal(f.sent.length,8);
  assert.equal(f.engine.list(h)[0].lastRun.status,'sent');
});
test('offline actions record skipped result, save does not run, deletes are scoped', async t => {
  const f=setup(t); f.values.get('a').Value='1';
  const rule=await f.engine.save(input()); await f.change('a','1'); assert.equal(f.sent.length,0);
  f.offline(); await f.change('a','0'); await f.change('a','1');
  assert.equal(f.engine.list(h)[0].lastRun.results[0].status,'skipped_offline');
  await assert.rejects(f.engine.remove({ homeName:'Other',id:rule.id }),/not found/);
  await f.engine.remove({ ...h,id:rule.id }); assert.equal(f.engine.list(h).length,0);
});
test('validation, loops including enabling a dormant loop, and target cleanup', async t => {
  const f=setup(t);
  await assert.rejects(f.engine.save(input([],[])),/at least/);
  await assert.rejects(f.engine.save(input([item('a','bad')])),/whole number/);
  await assert.rejects(f.engine.save(input([item('missing')])),/no longer exists/);
  await assert.rejects(f.engine.save(input([item('a')],[item('a')])),/loop/);
  const first=await f.engine.save(input());
  await assert.rejects(f.engine.save(input([item('out')],[item('a')])),/loop/);
  const second=await f.engine.save({ ...input([item('out')],[item('a')]),enabled:false });
  await assert.rejects(f.engine.toggle({ ...h,id:second.id,enabled:true }),/loop/);
  await assert.rejects(f.engine.save({ ...first,homeName:'Other' }),/not found/);
  await f.engine.removeTarget(h.homeName,1,'out'); assert.equal(f.engine.list(h).length,0);
});
test('queued rapid reports preserve both edges', async t => {
  const f=setup(t); await f.engine.save(input());
  await Promise.all([f.change('a','1'),f.change('a','0')]);
  assert.equal(f.sent.length,1); f.advance(); await f.change('a','1'); assert.equal(f.sent.length,2);
  await f.engine.removeTarget(h.homeName); assert.equal(f.engine.list(h).length,0);
});
test('one failed action does not prevent other actions and partial result is persisted', async t => {
  const f=setup(t); let called=0;
  f.engine.dispatch=async () => { if (++called===1) throw new Error('Device failure'); return 'sent'; };
  await f.engine.save(input([item('a')],[item('out'),item('out2')])); await f.change('a','1');
  assert.equal(called,2); const last=f.engine.list(h)[0].lastRun;
  assert.equal(last.status,'partial'); assert.deepEqual(last.results.map(r=>r.status),['failed','sent']);
});

test('opposite events preserve repeated ON/OFF transitions without a cooldown', async t => {
  const f = setup(t);
  await f.engine.save(input([item('a', '1')], [item('out', '1')]));
  await f.engine.save(input([item('a', '0')], [item('out', '0')]));
  // All reports occur at the same clock time, including duplicate device echoes.
  const reports = ['1', '1', '0', '0', '1', '0', '1', '0'];
  await Promise.all(reports.map(value => f.change('a', value)));
  assert.deepEqual(f.sent.map(x => x.varValue), ['1', '0', '1', '0', '1', '0']);
});

test('10 simultaneous events and subsequent transitions survive a busy dispatcher', async t => {
  const f = setup(t);
  for (let i = 0; i < 10; i++) {
    await f.engine.save({ ...input([item('a')], [item('out', String(i))]), name: `Event ${i}` });
  }
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.engine.dispatch = async target => {
    f.sent.push(target);
    if (f.sent.length === 1) { entered(); await blocked; }
    return 'sent';
  };
  const first = f.change('a', '1');
  await started;
  // Incoming reports queue while the first of ten actions is still in progress.
  const pending = ['0', '1', '1', '0', '1'].map(value => f.change('a', value));
  release();
  await Promise.all([first, ...pending]);
  assert.deepEqual(f.sent.map(x => x.varValue), Array.from({ length: 3 }, () =>
    Array.from({ length: 10 }, (_, i) => String(i))).flat());
  assert.ok(f.engine.list(h).every(rule => rule.lastRun.status === 'sent'));
});

test('a failed event does not discard other simultaneous events or subsequent triggers', async t => {
  const f = setup(t);
  for (let i = 0; i < 10; i++) await f.engine.save(input([item('a')], [item('out', String(i))]));
  f.engine.dispatch = async target => {
    f.sent.push(target);
    if (target.varValue === '0') throw new Error('Test dispatch failure');
    return 'sent';
  };
  await Promise.all(['1', '0', '1'].map(value => f.change('a', value)));
  assert.equal(f.sent.length, 20);
  assert.deepEqual(f.engine.list(h).map(rule => rule.lastRun.status),
    ['not_sent', ...Array(9).fill('sent')]);
});
