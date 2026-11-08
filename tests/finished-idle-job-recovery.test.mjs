import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePrinterState, FINISHED_WHEN_FAILED_IDLE_MODELS} from '../dist/safety/printer-state.js';
import {BambuImplementation} from '../dist/printers/bambu.js';
// P1S (#87) and A1 (firmware 01.08.01.00, after a user-stopped job) both report this clean terminal state.
const serials={p1s:'01PTEST000000',a1:'039TEST000000'};
const fixtures=model=>{
 const serial=serials[model]??'00MTEST000000';
 const raw=(overrides={})=>({model,gcode_state:'FAILED',print_type:'idle',print_error:0,hms:[],subtask_name:'previous',gcode_file:'cache/previous.3mf',task_id:'1',nozzle_diameter:'0.4',nozzle_type:'hardened_steel',...overrides});
 const status=(overrides={})=>({connected:true,serial,model,raw:raw(overrides),observation:{source:'mqtt',requestedAt:Date.now()-1,receivedAt:Date.now()}});
 const requirements={model,nozzleDiameters:[0.4],verifyMaterials:false};
 const inspection={...requirements,materials:['PLA'],maxNozzleTemperature:250,maxBedTemperature:55,maxChamberTemperature:0,sha256:'a'.repeat(64)};
 return {serial,status,requirements,inspection};
};

test('the finished-idle exception lists exactly the models with hardware evidence',()=>{
 assert.deepEqual([...FINISHED_WHEN_FAILED_IDLE_MODELS].sort(),['a1','p1s']);
});

for (const model of ['p1s','a1']) {
 const {serial,status,requirements,inspection}=fixtures(model);
 const MODEL=model.toUpperCase();
 test(`a named ${MODEL} terminal job explicitly reporting clean idle passes readiness; active and unknown states stay blocked`,()=>{
  assert.doesNotThrow(()=>validatePrinterState(status(),requirements));
  for(const change of [{print_type:'local'},{print_type:undefined},{print_error:1},{print_error:undefined},{hms:undefined},{hms:[{attr:1,code:0x20001}]},{subtask_name:'',gcode_file:''},{gcode_state:'PAUSE'},{gcode_state:'RUNNING'},{nozzle_diameter:'0.6'}]) assert.throws(()=>validatePrinterState(status(change),requirements),JSON.stringify(change));
  const stale=status();stale.observation.requestedAt-=60000;assert.throws(()=>validatePrinterState(stale,requirements),/fresh|stale/);
 });
 test(`${MODEL} prior failed job does not add a separate plate prompt`,async t=>{
  let question='';const impl=new BambuImplementation(async message=>{question=message;return false;});
  await impl.confirmPrintPreflight(serial,status(),inspection);
  assert.equal(question,'');
 });
 test(`the human clearance cannot authorize a different failed ${MODEL} job`,async()=>{
  const impl=new BambuImplementation(async()=>true);const approved=await impl.confirmPrintPreflight(serial,status(),inspection);
  assert.doesNotThrow(()=>impl.assertPrintPreflight(status(),approved));
  assert.doesNotThrow(()=>impl.assertPrintPreflight(status({gcode_state:'IDLE'}),approved));
  for(const change of [{task_id:'2'},{subtask_name:'new'},{gcode_file:'cache/new.3mf'},{gcode_state:'IDLE',task_id:'2'},{gcode_state:'IDLE',subtask_name:'new'}]) assert.throws(()=>impl.assertPrintPreflight(status(change),approved),/job changed during preflight/i);
 });
 test(`${MODEL}: an ordinary preflight does not ask, and the prompt after a hardware clear describes the job without asking for bed clearance`, async () => {
  for (const state of [status({gcode_state:'IDLE'}),status({gcode_state:'FINISH'}),status()]) {
   let message=''; const impl=new BambuImplementation(async text=>{message=text;return true;});
   await impl.confirmPrintPreflight(serial,state,inspection);
   assert.equal(message,'');
   // Only the first print after a hardware clear asks a person.
   impl.clearedErrors.set(serial,['print_error:123']);
   await impl.confirmPrintPreflight(serial,state,inspection);
   assert.match(message,new RegExp(`Start a checked print.*${MODEL}.*PLA`,'s'));
   assert.doesNotMatch(message,/(?:bed|plate).{0,50}clear|remove (?:the previous|every)/i);
   if (state.raw.gcode_state==='FAILED') assert.match(message,/previous job reports FAILED.*No error-reset command/s);
  }
 });
}

test('models without that evidence still refuse the same clean FAILED idle report',()=>{
 for (const model of ['a1mini','p1p','x1c','h2s']) {
  const {status,requirements}=fixtures(model);
  assert.throws(()=>validatePrinterState(status(),requirements),/not safely idle/,model);
 }
});
