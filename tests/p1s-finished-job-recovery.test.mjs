import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePrinterState} from '../dist/safety/printer-state.js';
import {BambuImplementation} from '../dist/printers/bambu.js';
const serial='01PTEST000000';
const raw=(overrides={})=>({model:'p1s',gcode_state:'FAILED',print_type:'idle',print_error:0,hms:[],subtask_name:'previous',gcode_file:'cache/previous.3mf',task_id:'1',nozzle_diameter:'0.4',nozzle_type:'hardened_steel',...overrides});
const status=(overrides={})=>({connected:true,serial,model:'p1s',raw:raw(overrides),observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now()}});
const requirements={model:'p1s',nozzleDiameters:[0.4],verifyMaterials:false};
const inspection={...requirements,materials:['PLA'],maxNozzleTemperature:250,maxBedTemperature:55,maxChamberTemperature:0,sha256:'a'.repeat(64)};
test('a named P1S terminal job explicitly reporting clean idle passes readiness; active and unknown states stay blocked',()=>{
 assert.doesNotThrow(()=>validatePrinterState(status(),requirements));
 for(const change of [{print_type:'local'},{print_type:undefined},{print_error:1},{print_error:undefined},{hms:undefined},{hms:[{attr:1,code:0x20001}]},{subtask_name:'',gcode_file:''},{gcode_state:'PAUSE'},{gcode_state:'RUNNING'},{nozzle_diameter:'0.6'}]) assert.throws(()=>validatePrinterState(status(change),requirements),JSON.stringify(change));
 const stale=status();stale.observation.requestedAt-=60000;assert.throws(()=>validatePrinterState(stale,requirements),/fresh|stale/);
});
test('P1S failed-bed clearance requires a person even with ordinary confirmations disabled',async t=>{
 const previous=process.env.BAMBU_REQUIRE_CONFIRMATION;process.env.BAMBU_REQUIRE_CONFIRMATION='0';
 t.after(()=>{if(previous===undefined)delete process.env.BAMBU_REQUIRE_CONFIRMATION;else process.env.BAMBU_REQUIRE_CONFIRMATION=previous;});
 let question='';const impl=new BambuImplementation(async message=>{question=message;return false;});
 await assert.rejects(impl.confirmPrintPreflight(serial,status(),inspection),/confirmation.*declined/);
 assert.match(question,/previous P1S job.*FAILED.*Remove the previous part/);
});
test('the human clearance cannot authorize a different failed P1S job',async()=>{
 const impl=new BambuImplementation(async()=>true);const approved=await impl.confirmPrintPreflight(serial,status(),inspection);
 assert.doesNotThrow(()=>impl.assertBedClearance(status(),approved));
 assert.doesNotThrow(()=>impl.assertBedClearance(status({gcode_state:'IDLE'}),approved));
 for(const change of [{task_id:'2'},{subtask_name:'new'},{gcode_file:'cache/new.3mf'},{gcode_state:'IDLE',task_id:'2'},{gcode_state:'IDLE',subtask_name:'new'}]) assert.throws(()=>impl.assertBedClearance(status(change),approved),/newly finished job/);
});
