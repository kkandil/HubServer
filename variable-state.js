'use strict';
class VariableState {
  constructor(sql) {
    this.sql=sql;
    sql.exec('CREATE TABLE IF NOT EXISTS variable_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO variable_clock VALUES(1,0)');
  }
  snapshot(homeName) {
    if(typeof homeName!=='string'||!/^[A-Za-z0-9_-]+$/.test(homeName))throw new Error('Invalid home');
    if(!this.sql.prepare("SELECT 1 FROM collections WHERE db=? AND name='Devices'").get(homeName))throw new Error('Home not found');
    // Synchronous SQLite reads share one event-loop turn with writes: one coherent snapshot.
    const values=this.sql.prepare(`SELECT d.body AS device,v.body AS variable FROM documents d JOIN documents v
      ON v.db=d.db AND v.collection='Var_'||json_extract(d.body,'$.Name')
      WHERE d.db=? AND d.collection='Devices' ORDER BY d.row_id,v.row_id`).all(homeName).map(row=>{
        const d=JSON.parse(row.device),v=JSON.parse(row.variable);
        return {homeName,deviceID:d.id,varName:v.VarName,varType:v.Type,varValue:v.Value,revision:v.ValueRevision||0};
      });
    return {homeName,revision:this.sql.prepare('SELECT revision FROM variable_clock WHERE id=1').get().revision,values};
  }
  write(homeName,deviceName,varName,varValue) {
    const sql=this.sql;
    const row=sql.prepare("SELECT row_id,body FROM documents WHERE db=? AND collection=? AND json_extract(body,'$.VarName')=?").get(homeName,'Var_'+deviceName,varName);
    const device=sql.prepare("SELECT body FROM documents WHERE db=? AND collection='Devices' AND json_extract(body,'$.Name')=?").get(homeName,deviceName);
    if(!row||!device)throw new Error('Variable or device not found');
    const v=JSON.parse(row.body),d=JSON.parse(device.body);
    sql.exec('BEGIN IMMEDIATE');
    try {
      const {revision}=sql.prepare('UPDATE variable_clock SET revision=revision+1 WHERE id=1 RETURNING revision').get();
      sql.prepare('UPDATE documents SET body=? WHERE row_id=?').run(JSON.stringify({...v,Value:varValue,ValueRevision:revision}),row.row_id);
      sql.exec('COMMIT');return {homeName,deviceID:d.id,varName,varType:v.Type,varValue,revision};
    }catch(e){sql.exec('ROLLBACK');throw e;}
  }
}
module.exports={VariableState};
