import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
const load = async () => {
  const module = await import('../../dist/safety/print-file.js').catch(() => ({}));
  assert.equal(typeof module.inspectPrintFile, 'function', 'print artifact inspection must exist'); return module;
};
const header = (model='P1S', material='PLA', nozzle='0.4') => `; printer_model = Bambu Lab ${model}\n; nozzle_diameter = ${nozzle}\n; filament_type = ${material}\n`;
async function fixture(t, text, entries) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bambu-file-safety-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,entries ? 'job.gcode.3mf' : 'job.gcode');let bytes=text;
  if(entries) {const zip=new JSZip();for(const [key,value] of Object.entries(entries)) zip.file(key,typeof value==='string'?value:JSON.stringify(value));bytes=await zip.generateAsync({type:'nodebuffer'});}
  await fs.writeFile(filename,bytes); return filename;
}
async function inspect(t,text,options={model:'p1s'},entries) {const {inspectPrintFile}=await load(); return inspectPrintFile(await fixture(t,text,entries),options);}
test('valid raw Bambu G-code returns identity, materials, peaks and exact artifact hash',async t=>{
  const source=header()+'M104 S250\nM109 R220\nM140 S60\nG1 X20 Y20 E1\nM104 S0\n';const r=await inspect(t,source);
  assert.equal(r.model,'p1s');assert.deepEqual(r.nozzleDiameters,[0.4]);assert.deepEqual(r.materials,['PLA']);assert.deepEqual(r.usedFilamentPositions,[0]);
  assert.equal(r.maxNozzleTemperature,250);assert.equal(r.maxBedTemperature,60);assert.equal(r.sha256,crypto.createHash('sha256').update(source).digest('hex'));
});
test('all late, reordered, numbered and commented heater targets are inspected',async t=>{
  for(const command of ['M104 S400','M109 R400','M104 T0 S400','N123 M109 (wait) R400','m104s400','M140 S101','M190 R101','M104 S220 R400','M104 S220\n'+('G1 X1\n'.repeat(10000))+'M104 S400'])
    await assert.rejects(inspect(t,header()+command+'\n'),/temperature|limit|target/i,command);
});
test('malformed, nonfinite, dynamic and negative thermal targets cannot authorize heat',async t=>{
  for(const command of ['M104 SNaN','M104 SInfinity','M104 S-1','M104 S','M104 S1e309','M104 S{nozzle_temperature}','M109 R[temperature]','M104 S220 S400','M104 S220foo','G1 X0 M104 S400','M104.1 S400','SET_HEATER_TEMPERATURE HEATER=extruder TARGET=400','M303 S400','M145 S0 H400','M149 F','G10 P0 S400'])
    await assert.rejects(inspect(t,header()+command+'\n'),/temperature|unsupported|syntax|target|parameter|command|dynamic/i,command);
});
test('comments cannot authorize heat and ordinary vendor commands survive inspection',async t=>{
  const r=await inspect(t,header()+'; M104 S400\n(M109 S400)\nM1002 gcode_claim_action : 0\nM960 S5 P1\nM400 U1\nG28\nG1 X-20 Y265\nM104 S250 ; M104 S400\nM142 P1 R35 S40\n');assert.equal(r.maxNozzleTemperature,250);
});
test('credible model nozzle and material metadata are mandatory and contradictions reject',async t=>{
  for(const source of ['M104 S220',header().replace(/; printer_model[^\n]*\n/,''),header().replace(/; nozzle_diameter[^\n]*\n/,''),header().replace(/; filament_type[^\n]*\n/,''),header('H2D'),header()+ '; printer_model = A1\n',header('P1S','UnknownBlend')])
    await assert.rejects(inspect(t,source+'\nM104 S220\n'),/metadata|model|material|nozzle|contradict|unknown/i);
  await assert.rejects(inspect(t,header()+'M104 S220\n',{model:'p1s',nozzleDiameters:[0.6]}),/nozzle/i);
  await assert.rejects(inspect(t,header()+'; curr_bed_type = Textured PEI Plate\nM104 S220\n',{model:'p1s',bedType:'Smooth PEI Plate'}),/bed/i);
});
test('selected plate alone is inspected before dispatch and project metadata can supply headers',async t=>{
  const entries={'Metadata/project_settings.config':{printer_model:'Bambu Lab P1S',nozzle_diameter:['0.4'],filament_type:['PLA','PETG']},'Metadata/plate_1.gcode':header()+'M104 S400\n','Metadata/plate_2.gcode':'T1\nM104 S250\nM140 S60\n','Metadata/plate_2.json':{filament_ids:[1]}};
  const r=await inspect(t,'',{model:'p1s',plateIndex:1},entries);assert.equal(r.plateInternalPath,'Metadata/plate_2.gcode');assert.deepEqual(r.usedFilamentPositions,[1]);
  await assert.rejects(inspect(t,'',{model:'p1s',plateIndex:2},entries),/plate.*3|selected plate/i);
  await assert.rejects(inspect(t,'',{model:'p1s',plateIndex:-1},entries),/plate/i);
  await assert.rejects(inspect(t,'',{model:'p1s'},{...entries,'Metadata/project_settings.config':{printer_model:'A1',nozzle_diameter:['0.4'],filament_type:['PLA']}}),/model|contradict/i);
});
test('checksum artifacts and unsliced archives are never printable',async t=>{
  const {inspectPrintFile}=await load();const file=await fixture(t,'d41d8cd98f00b204e9800998ecf8427e');await fs.rename(file,file+'.md5');
  await assert.rejects(inspectPrintFile(file+'.md5',{model:'p1s'}),/checksum|printable/i);
  await assert.rejects(inspect(t,'',{model:'p1s'},{'Metadata/plate_1.gcode.md5':'d41d8cd98f00b204e9800998ecf8427e'}),/selected plate|printable/i);
  await assert.rejects(inspect(t,header()),/command|empty|printable/i);
});
test('independent material ceilings override editable self-reported maxima',async t=>{
  for(const temp of [300,400]) await assert.rejects(inspect(t,header('H2D')+'; nozzle_temperature_range_high = 500\nM104 S'+temp+'\n',{model:'h2d'}),/material|PLA|temperature/i);
  const r=await inspect(t,header('X1E')+'M109 S290 ; official common flush\n',{model:'x1e'});assert.equal(r.maxNozzleTemperature,290);
});
test('tool changes and Bambu purge parameters retain positional material ceilings',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T0\nM104 S320\n',{model:'h2d'}),/PLA|material/i);
  const r=await inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S320\nM620.10 A1 F100 L40 H0.4 T330 P320\n',{model:'h2d'});assert.equal(r.maxNozzleTemperature,330);assert.deepEqual(r.usedFilamentPositions,[1]);
  for(const command of ['T9\nM104 S220','M620.1 E F100 T400','M620.10 A0 F100 L40 H0.4 T400 P220','M620.10 A1 F100 L40 H0.4 T250 P400']) await assert.rejects(inspect(t,header()+command+'\n'),/material|filament|temperature|tool|target|limit/i);
});
test('declared object bounds reject oversize objects while wipe motion is not treated as geometry',async t=>{
  const valid=header('A1 mini')+'; MINX: 10\n; MINY: 10\n; MINZ: 0.2\n; MAXX: 170\n; MAXY: 170\n; MAXZ: 150\nG1 X-12 Y185\nM104 S220\n';await inspect(t,valid,{model:'a1mini'});
  await assert.rejects(inspect(t,valid.replace('MAXX: 170','MAXX: 200'),{model:'a1mini'}),/bounds|volume/i);
});
test('manual temperature validation uses machine component limits and finite numeric targets',async()=>{
  await load();const {validateTemperature,normalizeModel,normalizeMaterial}=await import('../../dist/safety/limits.js');
  assert.equal(normalizeModel('Bambu Lab A1 mini'),'a1mini');assert.equal(normalizeModel('X1 Carbon'),'x1c');assert.equal(normalizeModel('unknown'),undefined);assert.equal(normalizeMaterial('Bambu PLA Basic'),'PLA');assert.equal(normalizeMaterial('PA6-CF'),'PA');
  for(const [model,component,value] of [['p1s','bed',101],['a1mini','bed',81],['h2d','bed',121],['x1c','bed',111],['x1e','chamber',61],['p1s','chamber',1],['p1s','nozzle',301]]) assert.throws(()=>validateTemperature(component,value,model,['PA']),/limit|temperature|chamber/i);
  for(const target of [NaN,Infinity,-1,'NaN','',null,true,{},'2e2']) assert.throws(()=>validateTemperature('nozzle',target,'p1s',['PLA']),/temperature|number|finite|target/i);
  assert.throws(()=>validateTemperature('nozzle',220,'p1s'),/material/i);assert.equal(validateTemperature('nozzle',0,'p1s'),0);assert.equal(validateTemperature('bed','60','p1s'),60);
});
test('H2D vendor startup flags, heater-off targets and unload sentinels remain usable',async t=>{
  const source=header('H2D','PLA','0.4;0.4')+'M620 M\nM620.10 A0 F74.8347 H0.4 T270 P220 S1\nM620 S0A\nT0\nM621 S0A\nM109 S140 A\nM104 S220 A\nM620 S65535\nT65535\nM621 S65535\nM620 S65279\nT65279\nM621 S65279\nM104 S0 T0\nM104 S0 T1\n';
  const result=await inspect(t,source,{model:'h2d',nozzleDiameters:[0.4]});assert.equal(result.maxNozzleTemperature,270);assert.equal(result.selectsAms,true);
});
test('explicit physical heater targets cannot silently select a different filament material',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'M104 T1 S330\n',{model:'h2d'}),/PLA|material|mapping/i);
});
test('switching to a low-temperature material cannot inherit an unsafe high-temperature target',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S330\nT0\nG1 E10\n',{model:'h2d'}),/PLA|material|temperature/i);
});
test('official installed startup and end routines retain parsed static vendor syntax',async t=>{
  const base='/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/machine/';
  for(const model of ['P1S','H2D','X1E']) {
    let profile;try {profile=JSON.parse(await fs.readFile(path.join(base,`Bambu Lab ${model} 0.4 nozzle.json`),'utf8'));}catch {t.skip('installed BambuStudio profiles unavailable');return;}
    const replace=expression=> /(?:extruder|filament_id|first.*filaments)/.test(expression)&&!/(?:temp|speed|diameter)/.test(expression)?'0':/chamber_temperature/.test(expression)?'40':/bed_temperature/.test(expression)?'60':/nozzle_diameter/.test(expression)?'0.4':/nozzle_temperature_range_high/.test(expression)?'270':/temp/.test(expression)?'220':'1';
    const routine=[profile.machine_start_gcode,profile.machine_end_gcode].filter(Boolean).join('\n').replace(/^[ \t]*\{[\s\S]*?\}[^\n]*$/gm,'').replace(/\{[^{}]*\}/g,replace).replace(/\[[^\[\]]*\]/g,replace);
    await inspect(t,header(model,'PLA',model==='H2D'?'0.4;0.4':'0.4')+routine,{model:model.toLowerCase()});
  }
});
test('zero-padded heater commands and concatenated commands cannot bypass inspection',async t=>{
  for(const command of ['M0104 S400','N5M00109 R400','G1X0M104S400','M00104.0 S400','M620.99 T400']) await assert.rejects(inspect(t,header()+command+'\n'),/temperature|unsupported|command|limit/i);
});
test('physical heater targeting cannot borrow a previously selected high-temperature filament',async t=>{
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S320\nM104 T0 S330\n',{model:'h2d'}),/PLA|material|mapping/i);
});
test('optional nozzle type and flow declarations retain per-nozzle positions',async t=>{
  const source=header('H2D','PLA','0.4;0.4')+'; nozzle_type = hardened_steel;stainless_steel\n; nozzle_flow = standard;high_flow\nM104 S220\n';
  const result=await inspect(t,source,{model:'h2d'});assert.deepEqual(result.nozzleTypes,['hardened_steel','stainless_steel']);assert.deepEqual(result.nozzleFlows,['standard','high_flow']);
  await assert.rejects(inspect(t,source.replace('hardened_steel;stainless_steel','hardened_steel'),{model:'h2d'}),/nozzle.*type|metadata/i);
});
test('recognized support-material names remain valid after normalization',async t=>{
  const result=await inspect(t,header('P1S','Support for PLA/PETG')+'M104 S250\n');assert.deepEqual(result.materials,['SUPPORT-PLA']);
});
test('Bambu plate JSON object bounds and bed contradictions are checked',async t=>{
  const entries={'Metadata/plate_1.gcode':header('A1 mini')+'M104 S220\n','Metadata/plate_1.json':{filament_ids:[0],bbox_all:[10,10,200,150],bed_type:'textured_plate'}};
  await assert.rejects(inspect(t,'',{model:'a1mini'},entries),/bounds|volume/i);
  entries['Metadata/plate_1.json'].bbox_all=[10,10,150,150];
  await inspect(t,'',{model:'a1mini',bedType:'textured_plate'},entries);
  await assert.rejects(inspect(t,'',{model:'a1mini',bedType:'hot_plate'},entries),/bed/i);
  entries['Metadata/plate_1.json'].bbox_objects=[{bbox:[0,0,250,100]}];
  await assert.rejects(inspect(t,'',{model:'a1mini'},entries),/bounds|volume/i);
});
test('vendor probing and all-nozzle heating cannot bypass material limits',async t=>{
  await assert.rejects(inspect(t,header()+'G383 O0 M2 T400\n'),/temperature|limit/i);
  await assert.rejects(inspect(t,header('H2D','PLA;PA-CF','0.4;0.4')+'T1\nM104 S330 A\n',{model:'h2d'}),/PLA|material/i);
  await assert.rejects(inspect(t,header('H2D','PA-CF;PLA','0.4;0.4')+'T0\nM104 S220\nT1\nM620.10 A0 F100 L40 H0.4 T320 P220\n',{model:'h2d'}),/PLA|material/i);
});
test('Bambu nozzle_volume_type is retained and conflicting flow aliases reject',async t=>{
  const entries={'Metadata/plate_1.gcode':header('H2D','PLA','0.4;0.4')+'; nozzle_flow = high_flow;High-Flow\nM104 S220\n','Metadata/project_settings.config':{nozzle_volume_type:['High Flow','high_flow']}};
  const result=await inspect(t,'',{model:'h2d'},entries);assert.deepEqual(result.nozzleFlows,['high_flow','high_flow']);
  entries['Metadata/project_settings.config'].nozzle_volume_type=['Standard','High Flow'];
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/nozzle.*flow|contradict/i);
});
test('selected plate nozzle diameters must match project metadata with float precision tolerance',async t=>{
  const entries={'Metadata/plate_1.gcode':header('H2D','PLA','0.4;0.4')+'M104 S220\n','Metadata/plate_1.json':{nozzle_diameter:0.4000000059604645}};
  await inspect(t,'',{model:'h2d'},entries);
  entries['Metadata/plate_1.json'].nozzle_diameter=0.8;
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/plate.*nozzle|nozzle.*contradict/i);
  entries['Metadata/plate_1.json'].nozzle_diameter=[0.4,0.6];
  await assert.rejects(inspect(t,'',{model:'h2d'},entries),/plate.*nozzle|nozzle.*contradict/i);
});
