'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { SQLiteClient } = require('../sqlite-store');
const { Scheduler } = require('../scheduler');

const target = { homeName: 'Home_Germany', deviceID: 1007, varName: 'power' };
const rule = { ...target, time: '19:30', days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Europe/Berlin', varType: 'int', varValue: '1', valueLabel: 'ON' };
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'schedule-test-'));
  let store = new SQLiteClient(path.join(dir, 'db.sqlite'));
  let now = new Date('2026-09-20T17:29:00Z');
  const deliveries = [];
  let online = true;
  function create() { return new Scheduler(store.sql, { resolveTarget: async () => ({ Type: 'int' }),
    clock: () => now, dispatch: async value => { if (!online) return 'skipped_offline'; deliveries.push(value); return 'sent'; } }); }
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { create, deliveries, setTime(value) { now = new Date(value); }, setOnline(value) { online = value; },
    async reopen() { await store.close(); store = new SQLiteClient(path.join(dir, 'db.sqlite')); return create(); } };
}
test('weekly time zone execution, no duplicates, survives restart, edit/delete and scoped access', async t => {
  const f = fixture(t); let scheduler = f.create();
  const saved = await scheduler.save(rule);
  await scheduler.tick(new Date('2026-09-20T17:29:59Z')); assert.equal(f.deliveries.length, 0);
  await scheduler.tick(new Date('2026-09-20T17:30:00Z')); assert.equal(f.deliveries.length, 1);
  await scheduler.tick(new Date('2026-09-20T17:30:20Z')); assert.equal(f.deliveries.length, 1);
  scheduler = await f.reopen();
  await scheduler.tick(new Date('2026-09-20T17:30:30Z')); assert.equal(f.deliveries.length, 1);
  assert.equal(scheduler.list(target)[0].lastRun.status, 'sent');
  await assert.rejects(scheduler.save({ ...saved, homeName: 'Other' }), /not found/);
  assert.throws(() => scheduler.remove({ ...target, deviceID: 999, id: saved.id }), /not found/);
  f.setTime('2026-09-20T17:31:00Z');
  await scheduler.save({ ...saved, time: '19:32', days: [1], varValue: '0' });
  await scheduler.tick(new Date('2026-09-20T17:32:00Z')); assert.equal(f.deliveries.length, 1);
  await scheduler.tick(new Date('2026-09-21T17:32:00Z')); assert.equal(f.deliveries.length, 2);
  scheduler.remove({ ...target, id: saved.id }); assert.equal(scheduler.list(target).length, 0);
  await scheduler.tick(new Date('2026-09-28T17:32:00Z')); assert.equal(f.deliveries.length, 2);
});
test('offline occurrence skipped without changing values or replaying; new saves wait for next minute', async t => {
  const f = fixture(t), scheduler = f.create();
  await scheduler.save(rule); f.setOnline(false);
  await scheduler.tick(new Date('2026-09-20T17:30:00Z'));
  assert.equal(scheduler.list(target)[0].lastRun.status, 'skipped_offline');
  f.setOnline(true); await scheduler.tick(new Date('2026-09-20T17:30:40Z')); assert.equal(f.deliveries.length, 0);
  await scheduler.tick(new Date('2026-09-21T17:31:00Z')); assert.equal(f.deliveries.length, 0);
  await scheduler.tick(new Date('2026-09-22T17:30:00Z')); assert.equal(f.deliveries.length, 1);
  f.setTime('2026-09-23T17:30:10Z'); await scheduler.save({ ...rule, varName: 'other' });
  await scheduler.tick(new Date('2026-09-23T17:30:30Z'));
  assert.equal(f.deliveries.filter(x => x.varName === 'other').length, 0);
});
test('DST repeated time runs once; missing local time is skipped', async t => {
  const f = fixture(t), scheduler = f.create();
  f.setTime('2026-03-28T00:00:00Z');
  await scheduler.save({ ...rule, time: '02:30', days: [0] });
  await scheduler.tick(new Date('2026-03-29T00:30:00Z'));
  await scheduler.tick(new Date('2026-03-29T01:30:00Z')); assert.equal(f.deliveries.length, 0);
  await scheduler.tick(new Date('2026-10-25T00:30:00Z'));
  await scheduler.tick(new Date('2026-10-25T01:30:00Z')); assert.equal(f.deliveries.length, 1);
});
test('reject malformed rules and clean up deleted target schedules', async t => {
  const f = fixture(t), scheduler = f.create();
  for (const invalid of [{ time: '24:10' }, { days: [] }, { days: [7] }, { timeZone: 'Mars/Base' },
    { varValue: 'NaN' }, { varValue: '1.5' }, { deviceID: '1007' }, { varType: 'other' }]) {
    await assert.rejects(scheduler.save({ ...rule, ...invalid }));
  }
  await scheduler.save(rule); await scheduler.save({ ...rule, varName: 'other' });
  scheduler.removeTarget(target.homeName, target.deviceID, target.varName);
  assert.equal(scheduler.list(target).length, 0);
  assert.equal(scheduler.list({ ...target, varName: 'other' }).length, 1);
  scheduler.removeTarget(target.homeName);
  assert.equal(scheduler.list({ ...target, varName: 'other' }).length, 0);
});
