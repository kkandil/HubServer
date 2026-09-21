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
test('rising edge only, multiple actions, cooldown, persistence, disabled and enable baseline', async t => {
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
  await f.change('a','0'); await f.change('a','1'); assert.equal(f.sent.length,6);
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
test('queued rapid reports preserve both edges and actions continue after a dispatch failure', async t => {
  const f=setup(t); await f.engine.save(input());
  await Promise.all([f.change('a','1'),f.change('a','0')]);
  assert.equal(f.sent.length,1); f.advance(); await f.change('a','1'); assert.equal(f.sent.length,2);
  await f.engine.removeTarget(h.homeName); assert.equal(f.engine.list(h).length,0);
});
