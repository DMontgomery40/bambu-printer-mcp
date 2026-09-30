import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {printerConfiguration,CAPABILITIES} from './sources.mjs';
test('Bambu farm configuration isolates existing credentials, aliases and refuses other backends',t=>{
 const dir=mkdtempSync(join(tmpdir(),'bambu-farm-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'printers.json');
 writeFileSync(path,JSON.stringify([{id:'a',type:'bambu',environment:{PRINTER_HOST:'dummy-a',BAMBU_SERIAL:'serial-a',BAMBU_TOKEN:'token-a'}},{id:'b',type:'bambu',environment:{PRINTER_HOST:'dummy-b',BAMBU_SERIAL:'serial-b',BAMBU_TOKEN:'token-b'}}]),{mode:0o600});
 const entries=printerConfiguration(path,{API_KEY:'inherited-secret'});assert.equal(entries[0].env.API_KEY,'');assert.equal(entries[1].env.BAMBU_SERIAL,'serial-b');assert.equal(entries[0].env.BAMBU_TOKEN,'token-a');assert.deepEqual(CAPABILITIES,{bambu:'mqtt'});
 writeFileSync(path,JSON.stringify([{id:'a',type:'klipper',environment:{PRINTER_HOST:'dummy'}}]));assert.throws(()=>printerConfiguration(path),/unavailable/);
});
