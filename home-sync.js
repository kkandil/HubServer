'use strict';
const {matches}=require('./events');
class HomeSync {
  constructor({client,events,scheduler,connections,homeName,token}) {
    Object.assign(this,{client,events,scheduler,connections,homeName,token});
    client.sql.exec('CREATE TABLE IF NOT EXISTS home_sync (home TEXT PRIMARY KEY, revision INTEGER NOT NULL)');
  }
  async apply(doc) {
    if(doc._id!==this.homeName || !Number.isSafeInteger(doc.revision) || !Array.isArray(doc.devices) || !Array.isArray(doc.events)) throw new Error('Invalid home configuration');
    return this.events.serial(async()=>{
      const sql=this.client.sql, current=sql.prepare('SELECT revision FROM home_sync WHERE home=?').get(this.homeName)?.revision||0;
      if(doc.revision<=current) return {homeName:this.homeName,revision:current};
      const changed=[];
      sql.exec('BEGIN IMMEDIATE');
      try {
        const previous=sql.prepare("SELECT body FROM documents WHERE db=? AND collection='Devices'").all(this.homeName).map(r=>JSON.parse(r.body));
        const newIds=new Set(doc.devices.map(d=>d.id));
        for(const device of previous) if(!newIds.has(device.id)) {
          sql.prepare('DELETE FROM collections WHERE db=? AND name=?').run(this.homeName,'Var_'+device.Name);
          this.scheduler.removeTarget(this.homeName,device.id);
        }
        sql.prepare("INSERT OR IGNORE INTO collections(db,name) VALUES(?,'Devices')").run(this.homeName);
        sql.prepare("DELETE FROM documents WHERE db=? AND collection='Devices'").run(this.homeName);
        for(const device of doc.devices) {
          const old=previous.find(d=>d.id===device.id);
          sql.prepare("INSERT INTO documents(db,collection,body) VALUES(?,'Devices',?)").run(this.homeName,JSON.stringify({...old,id:device.id,Name:device.Name,Status:old?.Status||'Not_Connected'}));
          const col='Var_'+device.Name;
          const variables=sql.prepare('SELECT body FROM documents WHERE db=? AND collection=?').all(this.homeName,col).map(r=>JSON.parse(r.body));
          sql.prepare('INSERT OR IGNORE INTO collections(db,name) VALUES(?,?)').run(this.homeName,col);
          sql.prepare('DELETE FROM documents WHERE db=? AND collection=?').run(this.homeName,col);
          for(const v of variables) if(!device.variables.some(n=>n.VarName===v.VarName)) this.scheduler.removeTarget(this.homeName,device.id,v.VarName);
          for(const v of device.variables) {
            const old=variables.find(o=>o.VarName===v.VarName && o.Type===v.Type);
            sql.prepare('INSERT INTO documents(db,collection,body) VALUES(?,?,?)').run(this.homeName,col,JSON.stringify({...v,Value:old?old.Value:v.Value}));
          }
        }
        const oldRules=this.events.rows(this.homeName);
        for(const row of oldRules) if(!doc.events.some(r=>r.id===row.id)) sql.prepare('DELETE FROM conditional_events WHERE id=?').run(row.id);
        for(const rule of doc.events) {
          const body=JSON.stringify(rule), old=oldRules.find(r=>r.id===rule.id);
          if(old?.body===body) continue;
          sql.prepare('INSERT INTO conditional_events(id,home,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(rule.id,this.homeName,body); changed.push(rule);
        }
        if(doc.deleted) {this.scheduler.removeTarget(this.homeName);sql.prepare('DELETE FROM collections WHERE db=?').run(this.homeName);}
        sql.prepare('INSERT INTO home_sync(home,revision) VALUES(?,?) ON CONFLICT(home) DO UPDATE SET revision=excluded.revision').run(this.homeName,doc.revision);
        sql.exec('COMMIT');
      } catch(e) {sql.exec('ROLLBACK');throw e;}
      for(const rule of changed) {await this.events.seed(rule);sql.prepare('UPDATE conditional_events SET matched=? WHERE id=?').run(+matches(rule,this.events.values),rule.id);}
      for(const [key,connection] of this.connections) if(connection.HomeName===this.homeName && !doc.devices.some(d=>key.endsWith('|'+d.id))) {this.connections.delete(key);connection.Socket.disconnect(true);}
      return {homeName:this.homeName,revision:doc.revision};
    });
  }
  async runtime() {
    const devices=await this.client.db(this.homeName).collection('Devices').find().toArray();
    const schedules=this.client.sql.prepare('SELECT body,last_run FROM schedules WHERE home=?').all(this.homeName).map(r=>({...JSON.parse(r.body),lastRun:r.last_run?JSON.parse(r.last_run):null}));
    return {homeName:this.homeName,devices,schedules,events:this.events.list?this.events.list({homeName:this.homeName}).map(r=>({id:r.id,lastRun:r.lastRun})):[]};
  }
  attach(socket) {
    const allowed=()=>socket.handshake.query.syncToken===this.token;
    socket.on('ApplyHomeConfig',async(doc,ack)=>{if(!allowed() || typeof ack!=='function')return;try{ack({status:'OK',...await this.apply(doc)});}catch(e){ack({status:'Error',message:e.message});}});
    socket.on('ReadHomeRuntime',async(_input,ack)=>{if(allowed() && typeof ack==='function')ack(await this.runtime());});
  }
}
module.exports={HomeSync};
