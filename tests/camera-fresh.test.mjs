import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CameraFrameReader } from '../dist/camera-frame.js';
import { BambuImplementation } from '../dist/printers/bambu.js';
const jpeg=value=>Buffer.from([255,216,value,255,217]);
const packet=image=>{ const header=Buffer.alloc(16);header.writeUInt32LE(image.length);return Buffer.concat([header,image]); };
test('fresh camera rejects cached initial and repeated identical frames, then accepts changed live bytes',()=> {
 const reader=new CameraFrameReader();assert.equal(reader.push(packet(jpeg(1))),undefined);
 assert.equal(reader.push(packet(jpeg(1))),undefined);assert.deepEqual(reader.push(packet(jpeg(2))),jpeg(2));
 assert.equal(reader.framesObserved,3);
});
test('fresh camera parses fragmented and coalesced frames without returning the first buffered frame',()=> {
 const reader=new CameraFrameReader(),data=Buffer.concat([packet(jpeg(1)),packet(jpeg(2))]);
 assert.equal(reader.push(data.subarray(0,18)),undefined);assert.deepEqual(reader.push(data.subarray(18)),jpeg(2));
});
test('explicit preview can return the initial frame without claiming fresh confirmation',()=> {
 const reader=new CameraFrameReader(false);assert.deepEqual(reader.push(packet(jpeg(1))),jpeg(1));
});
test('failed fresh acquisition never reads or returns an existing cached save file',async t=> {
 const directory=mkdtempSync(join(tmpdir(),'fresh-camera-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const savePath=join(directory,'cached.jpg');writeFileSync(savePath,jpeg(1));const printer=new BambuImplementation(async()=>true);
 printer.fetchTcpCameraFrame=async(_host,_token,_timeout,requireFresh)=>{assert.equal(requireFresh,true);throw Error('fresh capture unavailable; refusing cached fallback');};
 await assert.rejects(printer.cameraSnapshot('test.invalid','test','test',{bambuModel:'p1s',savePath}),/fresh capture unavailable/);
 assert.deepEqual(readFileSync(savePath),jpeg(1));
});
test('successful fresh capture records acquisition interval and live source separately from file mtime',async()=> {
 const printer=new BambuImplementation(async()=>true);printer.fetchTcpCameraFrame=async(_host,_token,_timeout,requireFresh)=>{assert.equal(requireFresh,true);return jpeg(2);};
 const started=Date.now();const result=await printer.cameraSnapshot('test.invalid','test','test',{bambuModel:'p1s'});
 assert.equal(result.freshness,'live-stream-changed-after-initial-frame');assert.equal(result.transport,'tcp-6000');
 assert.ok(Date.parse(result.acquisitionStartedAt)>=started);assert.ok(Date.parse(result.acquiredAt)>=Date.parse(result.acquisitionStartedAt));
 assert.equal(result.base64,jpeg(2).toString('base64'));
});

test('actual acquisition times out on repeated cached frames without silently returning one',async()=> {
 const { EventEmitter }=await import('node:events');const { readLiveCameraFrame }=await import('../dist/camera-frame.js');
 const socket=new EventEmitter();let destroyed=false;socket.destroy=()=>{destroyed=true;};socket.write=()=>{};
 const capture=readLiveCameraFrame(socket,Buffer.alloc(80),15);
 socket.emit('secureConnect');socket.emit('data',packet(jpeg(1)));socket.emit('data',packet(jpeg(1)));
 await assert.rejects(capture,/fresh capture unavailable.*refusing cached fallback/);assert.equal(destroyed,true);
});
