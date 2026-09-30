import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createLegacySource } from './relay.mjs';

export const CAPABILITIES = Object.freeze({bambu:'mqtt'});
const KEYS=['PRINTER_TYPE','PRINTER_HOST','PRINTER_PORT','API_KEY','BAMBU_SERIAL','BAMBU_TOKEN','BAMBU_MODEL'];
export function printerConfiguration(filename, inherited=process.env, capabilities=CAPABILITIES) {
  const entries=filename ? (()=> {
    if(!isAbsolute(filename)) throw new Error('Printer configuration must be an absolute private path');
    if(process.platform!=='win32' && (statSync(filename).mode & 0o077)) throw new Error('Printer configuration must be readable only by its owner');
    return JSON.parse(readFileSync(filename,'utf8'));
  })() : [{id:'default',type:inherited.PRINTER_TYPE??'bambu',environment:Object.fromEntries(KEYS.filter(key=>inherited[key]!==undefined).map(key=>[key,inherited[key]]))}];
  if(!Array.isArray(entries)||!entries.length||entries.length>100) throw new Error('Configure 1–100 printers');
  const ids=new Set();
  return entries.map(entry=> {
    if(!entry || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Printer aliases must be unique and contain only letters, digits, hyphen or underscore');
    ids.add(entry.id);
    if(!Object.hasOwn(capabilities,entry.type)||capabilities[entry.type]==='unsupported') throw new Error(`Native completion events are unavailable for backend ${entry.type}`);
    if(!entry.environment || Object.entries(entry.environment).some(([key,value])=>!KEYS.includes(key)||typeof value!=='string')) throw new Error('Invalid private printer environment');
    if(entry.type==='bambu' && (!entry.environment.BAMBU_SERIAL?.trim() || !entry.environment.BAMBU_TOKEN?.trim())) throw new Error('Each Bambu printer needs its existing serial and access code');
    if(!entry.environment.PRINTER_HOST?.trim()) throw new Error('Each printer needs its explicit host');
    const env={...inherited};for(const key of KEYS) delete env[key];
    // Empty values override dotenv, preventing one farm entry from inheriting another printer's credentials.
    for(const key of KEYS)env[key]='';Object.assign(env,entry.environment,{PRINTER_TYPE:entry.type});
    return {id:entry.id,type:entry.type,env};
  });
}
export async function createPrinterSource({entry,cwd,journal,configuration}) {
  return createLegacySource({entry,cwd,journal,printer:configuration.id,env:configuration.env});
}
