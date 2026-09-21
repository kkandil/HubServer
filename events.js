'use strict';
const { randomUUID } = require('node:crypto');

const key = t => JSON.stringify([t.homeName, t.deviceID, t.varName]);
function home(input) {
  if (!input || typeof input.homeName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.homeName)) throw new Error('Select a home');
}
function equal(actual, expected, type) {
  if (actual === undefined || actual === null) return false;
  if (['int', 'float'].includes(type)) return String(actual).trim() !== '' && Number.isFinite(Number(actual)) && Number(actual) === Number(expected);
  if (['bool', 'boolean'].includes(type)) {
    const normalize = v => ['1', 'true'].includes(String(v)) ? true : ['0', 'false'].includes(String(v)) ? false : null;
    return normalize(actual) !== null && normalize(actual) === normalize(expected);
  }
  return String(actual) === expected;
}
function matches(rule, values) {
  // AND binds within a group; OR separates alternative groups.
  let group = true, result = false;
  for (let i = 0; i < rule.conditions.length; i++) {
    const c = rule.conditions[i];
    if (i && c.join === 'OR') { result = result || group; group = true; }
    group = group && equal(values.get(key({ ...c, homeName: rule.homeName })), c.varValue, c.varType);
  }
  return result || group;
}

class EventEngine {
  constructor(sql, { resolveTarget, dispatch, catalog, onChange = () => {}, clock = () => new Date() }) {
    Object.assign(this, { sql, resolveTarget, dispatch, catalog, onChange, clock });
    this.values = new Map();
    this.queue = Promise.resolve();
    sql.exec(`CREATE TABLE IF NOT EXISTS conditional_events (
      id TEXT PRIMARY KEY, home TEXT NOT NULL, body TEXT NOT NULL,
      matched INTEGER NOT NULL DEFAULT 0, last_run TEXT);
      CREATE INDEX IF NOT EXISTS event_home ON conditional_events(home);`);
  }
  serial(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(error => console.error('Events:', error.message));
    return result;
  }
  rows(homeName) {
    return homeName === undefined ? this.sql.prepare('SELECT * FROM conditional_events ORDER BY rowid').all()
      : this.sql.prepare('SELECT * FROM conditional_events WHERE home=? ORDER BY rowid').all(homeName);
  }
  list(input) {
    home(input);
    return this.rows(input.homeName).map(row => ({ ...JSON.parse(row.body), lastRun: row.last_run ? JSON.parse(row.last_run) : null }));
  }
  async seed(rule) {
    for (const c of rule.conditions) {
      const target = { ...c, homeName: rule.homeName };
      const variable = await this.resolveTarget(target);
      this.values.set(key(target), variable?.Value);
    }
  }
  async start() {
    for (const row of this.rows()) {
      const rule = JSON.parse(row.body);
      await this.seed(rule);
      // Restarting never replays actions for an already matching condition.
      this.sql.prepare('UPDATE conditional_events SET matched=? WHERE id=?').run(+matches(rule, this.values), row.id);
    }
  }
  async validateItem(item, homeName, condition, index) {
    if (!item || !Number.isSafeInteger(item.deviceID) || item.deviceID <= 0
        || typeof item.varName !== 'string' || !item.varName || item.varName.length > 128) throw new Error('Choose a device and variable');
    const target = await this.resolveTarget({ ...item, homeName });
    if (!target) throw new Error('A selected device or variable no longer exists');
    const type = target.Type;
    if (!['int', 'float', 'string', 'bool', 'boolean'].includes(type)) throw new Error('Unsupported variable type');
    const value = item.varValue;
    if (typeof value !== 'string' || value.length > 1024) throw new Error('Enter a value of at most 1024 characters');
    if (type === 'int' && !/^[+-]?\d+$/.test(value)) throw new Error('Enter a whole number');
    if (['int', 'float'].includes(type) && (!value.trim() || !Number.isFinite(Number(value)))) throw new Error('Enter a valid number');
    if (['bool', 'boolean'].includes(type) && !['0', '1', 'true', 'false'].includes(value)) throw new Error('Select ON or OFF');
    if (condition && index > 0 && !['AND', 'OR'].includes(item.join)) throw new Error('Choose AND or OR');
    return { deviceID: item.deviceID, deviceName: target.deviceName || String(item.deviceID), varName: item.varName,
      varType: type, varValue: value, ...(condition ? { join: index ? item.join : 'AND' } : {}) };
  }
  checkCycles(rule) {
    if (!rule.enabled) return;
    const rules = this.list(rule).filter(r => r.enabled && r.id !== rule.id).concat(rule);
    const graph = new Map();
    for (const r of rules) for (const c of r.conditions) {
      const source = key({ ...c, homeName: r.homeName });
      if (!graph.has(source)) graph.set(source, new Set());
      for (const a of r.actions) graph.get(source).add(key({ ...a, homeName: r.homeName }));
    }
    const visiting = new Set(), visited = new Set();
    const visit = node => {
      if (visiting.has(node)) throw new Error('These enabled events form a loop. Change an action or disable a conflicting event.');
      if (visited.has(node)) return;
      visiting.add(node);
      for (const next of graph.get(node) || []) visit(next);
      visiting.delete(node); visited.add(node);
    };
    for (const node of graph.keys()) visit(node);
  }
  save(input) { return this.serial(async () => {
    home(input);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new Error('Enter an event name (up to 80 characters)');
    if (typeof input.enabled !== 'boolean') throw new Error('Choose whether the event is enabled');
    for (const field of ['conditions', 'actions']) if (!Array.isArray(input[field]) || !input[field].length || input[field].length > 32)
      throw new Error('Add at least one condition and one action (maximum 32 each)');
    if (input.id && (typeof input.id !== 'string' || !this.sql.prepare('SELECT id FROM conditional_events WHERE id=? AND home=?').get(input.id, input.homeName))) throw new Error('Event not found');
    const rule = { id: input.id || randomUUID(), homeName: input.homeName, name: input.name.trim(), enabled: input.enabled, conditions: [], actions: [] };
    for (let i = 0; i < input.conditions.length; i++) rule.conditions.push(await this.validateItem(input.conditions[i], rule.homeName, true, i));
    for (const a of input.actions) rule.actions.push(await this.validateItem(a, rule.homeName, false, 0));
    this.checkCycles(rule);
    await this.seed(rule);
    this.sql.prepare(`INSERT INTO conditional_events(id,home,body,matched) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, matched=excluded.matched`)
      .run(rule.id, rule.homeName, JSON.stringify(rule), +matches(rule, this.values));
    this.onChange(rule);
    return rule;
  }); }
  toggle(input) { return this.serial(async () => {
    home(input);
    if (typeof input.enabled !== 'boolean' || typeof input.id !== 'string') throw new Error('Invalid event');
    const rule = this.list(input).find(r => r.id === input.id);
    if (!rule) throw new Error('Event not found');
    delete rule.lastRun;
    rule.enabled = input.enabled;
    this.checkCycles(rule);
    await this.seed(rule);
    this.sql.prepare('UPDATE conditional_events SET body=?,matched=? WHERE id=?').run(JSON.stringify(rule), +matches(rule, this.values), rule.id);
    this.onChange(rule);
    return rule;
  }); }
  remove(input) { return this.serial(() => {
    home(input);
    if (typeof input.id !== 'string' || !this.sql.prepare('DELETE FROM conditional_events WHERE id=? AND home=?').run(input.id, input.homeName).changes) throw new Error('Event not found');
    this.onChange(input);
  }); }
  removeTarget(homeName, deviceID, varName) { return this.serial(() => {
    for (const row of this.rows(homeName)) {
      const rule = JSON.parse(row.body);
      if (deviceID === undefined || [...rule.conditions, ...rule.actions].some(t => t.deviceID === deviceID && (varName === undefined || t.varName === varName))) {
        this.sql.prepare('DELETE FROM conditional_events WHERE id=?').run(row.id);
        this.onChange(rule);
      }
    }
  }); }
  changed(target) { return this.serial(async () => {
    this.values.set(key(target), target.varValue);
    for (const row of this.rows(target.homeName)) {
      const rule = JSON.parse(row.body);
      if (!rule.enabled || !rule.conditions.some(c => c.deviceID === target.deviceID && c.varName === target.varName)) continue;
      const matched = matches(rule, this.values);
      // Claim the transition durably before sending commands (no repeat on echo).
      this.sql.prepare('UPDATE conditional_events SET matched=? WHERE id=?').run(+matched, row.id);
      if (!matched || row.matched) continue;
      const at = this.clock().toISOString();
      const results = [];
      // A short cooldown also limits loops involving firmware-derived variables.
      const previous = row.last_run && JSON.parse(row.last_run);
      if (previous && Date.parse(at) - Date.parse(previous.at) < 5000) continue;
      this.sql.prepare('UPDATE conditional_events SET last_run=? WHERE id=?').run(JSON.stringify({ at, status: 'running', results: [] }), row.id);
      for (const action of rule.actions) {
        let status;
        try { status = await this.dispatch({ ...action, homeName: rule.homeName }); }
        catch (error) { status = 'failed'; console.error('Event action:', error.message); }
        results.push({ deviceID: action.deviceID, varName: action.varName, status });
      }
      const status = results.every(r => r.status === 'sent') ? 'sent' : results.some(r => r.status === 'sent') ? 'partial' : 'not_sent';
      this.sql.prepare('UPDATE conditional_events SET last_run=? WHERE id=?').run(JSON.stringify({ at, status, results }), row.id);
      console.log(`Event ${rule.id}: ${status}`);
      this.onChange(rule);
    }
  }); }
  attach(socket) {
    for (const event of ['GetEvents', 'SaveEvent', 'DeleteEvent', 'SetEventEnabled', 'GetEventVariables']) socket.on(event, async input => {
      const requestId = typeof input?.requestId === 'string' ? input.requestId : null;
      try {
        home(input);
        let result = {};
        if (event === 'GetEvents') result = { events: this.list(input) };
        if (event === 'SaveEvent') result = { event: await this.save(input) };
        if (event === 'DeleteEvent') await this.remove(input);
        if (event === 'SetEventEnabled') result = { event: await this.toggle(input) };
        if (event === 'GetEventVariables') result = { devices: await this.catalog(input.homeName) };
        socket.emit(event, { requestId, status: 'OK', ...result });
      } catch (error) { socket.emit(event, { requestId, status: 'Error', message: error.message }); }
    });
  }
}
module.exports = { EventEngine, equal, matches, key };
