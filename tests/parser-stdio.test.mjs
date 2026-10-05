import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
test('3MF parser diagnostics never contaminate stdio protocol output',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bambu-parser-stdio-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'fixture.3mf');const zip=new JSZip();
  zip.file('3D/3dmodel.model','<model unit="millimeter"><resources/><build/></model>');
  zip.file('Metadata/project_settings.config',JSON.stringify({filament_type:['PLA']}));
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  const module=new URL('../dist/3mf_parser.js',import.meta.url).href;
  const output=execFileSync(process.execPath,['--input-type=module','-e',`const {parse3MF}=await import(${JSON.stringify(module)});await parse3MF(process.argv[1]);`,file],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(output,'');
});
