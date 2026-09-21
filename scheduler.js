'use strict';
const { randomUUID } = require('node:crypto');

function validateTarget(input) {
  if (!input || typeof input.homeName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.homeName)
      || !Number.isSafeInteger(input.deviceID) || input.deviceID <= 0
      || typeof input.varName !== 'string' || !input.varName || input.varName.length > 128) {
    throw new Error('Invalid schedule target');
  }
}
function validate(input) {
  validateTarget(input);
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('Select a valid time');
  if (!Array.isArray(input.days) || !input.days.length || input.days.length > 7
      || input.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Select at least one day');
  if (typeof input.timeZone !== 'string' || input.timeZone.length > 80) throw new Error('Invalid time zone');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(); }
  catch { throw new Error('Unknown time zone'); }
  if (typeof input.varValue !== 'string' || input.varValue.length > 1024) throw new Error('Invalid value');
  if (!['int', 'float', 'string', 'bool', 'boolean'].includes(input.varType)) throw new Error('Unsupported variable type');
  if (input.varType === 'int' && !/^[+-]?\d+$/.test(input.varValue)) throw new Error('Enter a whole number');
  if (['int', 'float'].includes(input.varType)
      && (!input.varValue.trim() || !Number.isFinite(Number(input.varValue)))) throw new Error('Enter a valid number');
  if (['bool', 'boolean'].includes(input.varType) && !['0', '1', 'true', 'false'].includes(input.varValue)) throw new Error('Enter 0, 1, true or false');
}

class Scheduler {
  constructor(sql, { resolveTarget, dispatch, onChange = () => {}, clock = () => new Date() }) {
    this.sql = sql;
    this.resolveTarget = resolveTarget;
    this.dispatch = dispatch;
    this.onChange = onChange;
    this.clock = clock;
    this.formatters = new Map();
    sql.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, home TEXT NOT NULL, device INTEGER NOT NULL, variable TEXT NOT NULL,
      body TEXT NOT NULL, eligible_after INTEGER NOT NULL, last_key TEXT, last_run TEXT);
      CREATE INDEX IF NOT EXISTS schedule_target ON schedules(home,device,variable);`);
  }
  list(target) {
    validateTarget(target);
    return this.sql.prepare('SELECT * FROM schedules WHERE home=? AND device=? AND variable=? ORDER BY id')
      .all(target.homeName, target.deviceID, target.varName).map(row => ({ ...JSON.parse(row.body), lastRun: row.last_run ? JSON.parse(row.last_run) : null }));
  }
  async save(input) {
    validate(input);
    const target = await this.resolveTarget(input);
    if (!target) throw new Error('Device or variable not found');
    if (target.Type && target.Type !== input.varType) throw new Error('Variable type changed; reopen widget settings');
    const id = input.id || randomUUID();
    if (typeof id !== 'string' || id.length > 80) throw new Error('Invalid schedule ID');
    if (input.id && !this.sql.prepare('SELECT id FROM schedules WHERE id=? AND home=? AND device=? AND variable=?')
      .get(id, input.homeName, input.deviceID, input.varName)) throw new Error('Schedule not found');
    const schedule = { id, homeName: input.homeName, deviceID: input.deviceID, varName: input.varName,
      time: input.time, days: [...new Set(input.days)].sort(), timeZone: input.timeZone,
      varType: input.varType, varValue: input.varValue,
      valueLabel: ['ON', 'OFF'].includes(input.valueLabel) ? input.valueLabel : '' };
    // Saving during a matching minute never triggers an immediate surprise command.
    const eligible = (Math.floor(this.clock().getTime() / 60000) + 1) * 60000;
    this.sql.prepare(`INSERT INTO schedules(id,home,device,variable,body,eligible_after) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, eligible_after=excluded.eligible_after`)
      .run(id, input.homeName, input.deviceID, input.varName, JSON.stringify(schedule), eligible);
    this.onChange(schedule);
    return schedule;
  }
  remove(input) {
    validateTarget(input);
    if (typeof input.id !== 'string') throw new Error('Invalid schedule ID');
    const result = this.sql.prepare('DELETE FROM schedules WHERE id=? AND home=? AND device=? AND variable=?')
      .run(input.id, input.homeName, input.deviceID, input.varName);
    if (!result.changes) throw new Error('Schedule not found');
    this.onChange(input);
  }
  removeTarget(home, device, variable) {
    let query = 'DELETE FROM schedules WHERE home=?';
    const params = [home];
    if (device !== undefined) { query += ' AND device=?'; params.push(device); }
    if (variable !== undefined) { query += ' AND variable=?'; params.push(variable); }
    this.sql.prepare(query).run(...params);
  }
  localTime(now, zone) {
    if (!this.formatters.has(zone)) this.formatters.set(zone, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }));
    const p = Object.fromEntries(this.formatters.get(zone).formatToParts(now).map(p => [p.type, p.value]));
    return { time: `${p.hour}:${p.minute}`, day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
      key: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` };
  }
  async tick(now = this.clock()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const row of this.sql.prepare('SELECT * FROM schedules WHERE eligible_after<=? ORDER BY id').all(now.getTime())) {
        if(process.env.HUB_HOME && row.home!==process.env.HUB_HOME) continue;
        const schedule = JSON.parse(row.body);
        const local = this.localTime(now, schedule.timeZone);
        if (local.time !== schedule.time || !schedule.days.includes(local.day) || row.last_key === local.key) continue;
        // Claim before dispatch: at most once per local date/time, including DST repetition and restarts.
        const claimed = this.sql.prepare(`UPDATE schedules SET last_key=? WHERE id=? AND body=? AND (last_key IS NULL OR last_key<>?)`)
          .run(local.key, row.id, row.body, local.key);
        if (!claimed.changes) continue;
        let status = 'failed';
        try { status = await this.dispatch(schedule); }
        catch (error) { console.error('Schedule dispatch failed:', row.id, error.message); }
        const lastRun = { at: now.toISOString(), status };
        this.sql.prepare('UPDATE schedules SET last_run=? WHERE id=?').run(JSON.stringify(lastRun), row.id);
        console.log(`Schedule ${row.id}: ${status} (${schedule.homeName}/${schedule.deviceID}/${schedule.varName})`);
        this.onChange(schedule);
      }
    } finally { this.running = false; }
  }
  start() {
    this.timer = setInterval(() => this.tick().catch(error => console.error('Scheduler:', error.message)), 1000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  attach(socket) {
    for (const event of ['GetSchedules', 'SaveSchedule', 'DeleteSchedule']) socket.on(event, async input => {
      const requestId = typeof input?.requestId === 'string' ? input.requestId : null;
      try {
        let result = {};
        if (event === 'GetSchedules') result = { schedules: this.list(input) };
        if (event === 'SaveSchedule') result = { schedule: await this.save(input) };
        if (event === 'DeleteSchedule') this.remove(input);
        socket.emit(event, { requestId, status: 'OK', ...result });
      } catch (error) { socket.emit(event, { requestId, status: 'Error', message: error.message }); }
    });
  }
}
module.exports = { Scheduler, validate };
