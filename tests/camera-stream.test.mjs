import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {CameraStreams} from '../dist/printers/camera-stream.js';
import {openTcpCameraSource, openRtspCameraSource, mjpegParser} from '../dist/printers/camera-sources.js';
import {BambuImplementation} from '../dist/printers/bambu.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const picture = value => sharp({create: {width: 640, height: 360, channels: 3, background: {r:value,g:value,b:value}}}).jpeg().toBuffer();
const until = async check => { for(let i=0;i<400;i++){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw Error('timed out'); };
function fixture(t, {skipFirstFrame=false, idleTimeoutMs=10000, open}={}) {
  let now=1000, opened=0, closed=0, handlers;
  const streams=new CameraStreams(()=>now);
  t.after(()=>streams.stopAll());
  const options={transport:'tcp-6000',fps:2,idleTimeoutMs,skipFirstFrame,open:open??(h=>{opened++;handlers=h;return {close(){closed++;}};})};
  const {stream}=streams.start('one',options);
  return {streams,stream,options,get opened(){return opened},get closed(){return closed},get handlers(){return handlers},
    async put(bytes){now+=501;handlers.onFrame(bytes);await new Promise(r=>setTimeout(r,15));}};
}

test('one source per printer, stable unchanged cursor beyond16 frames, resize, and restart sequence',async t=>{
  const f=fixture(t);
  assert.equal(f.streams.start('one',f.options).status,'running');assert.equal(f.opened,1);
  const first=await picture(10), changed=await picture(160);
  await f.put(first);
  const one=await f.stream.frame({maxWidth:300});
  assert.deepEqual([one.status,one.width,one.height],['frame',300,169]);
  for(let i=0;i<25;i++)await f.put(first);
  const same=await f.stream.frame({sinceSeq:one.seq,waitMs:5});
  assert.deepEqual([same.status,same.seq,same.base64],['unchanged',one.seq,undefined]);
  const pending=f.stream.frame({sinceSeq:one.seq,waitMs:1000});
  await f.put(changed);
  const two=await pending;assert.equal(two.status,'frame');assert.ok(two.seq>one.seq);assert.ok(two.change>.5);
  f.streams.stop('one');assert.equal(f.closed,1);assert.equal((await f.stream.frame()).status,'stopped');
  const restart=f.streams.start('one',f.options);assert.equal(restart.status,'started');
  await f.put(changed);assert.ok((await restart.stream.frame()).seq>two.seq);
});

test('P1/A1 repeated stale buffered frame is skipped before the live image',async t=>{
  const f=fixture(t,{skipFirstFrame:true});const old=await picture(10),live=await picture(90);
  await f.put(old);await f.put(old);assert.equal((await f.stream.frame()).status,'unchanged');
  await f.put(live);assert.equal((await f.stream.frame()).status,'frame');
});

test('idle closes source and wakes a blocked viewer; other printer stays open',async t=>{
  const f=fixture(t,{idleTimeoutMs:40});
  const other=f.streams.start('two',{...f.options,idleTimeoutMs:10000});
  const pending=f.stream.frame({waitMs:1000});
  assert.equal((await pending).status,'stopped');assert.equal(f.closed,1);assert.equal(other.stream.stopped,false);
});

test('one reconnect, no auth retry, and synchronous source failure cannot leak a handle',async t=>{
  const f=fixture(t);f.handlers.onError(Error('connection dropped'));assert.equal(f.opened,2);
  f.handlers.onEnd();assert.equal((await f.stream.frame()).reason,'unreachable');assert.equal(f.closed,2);
  let closed=0,opened=0;
  const auth=fixture(t,{open:h=>{opened++;h.onError(Error('authentication failed'));return {close(){closed++;}};}});
  assert.equal((await auth.stream.frame()).reason,'auth');assert.equal(opened,1);assert.equal(closed,1);
});

test('abort only cancels its viewer; explicit stop releases every waiter',async t=>{
  const f=fixture(t),controller=new AbortController();
  const waiting=f.stream.frame({waitMs:1000,signal:controller.signal});controller.abort();
  await assert.rejects(waiting,{name:'AbortError'});assert.equal(f.closed,0);
  const others=[f.stream.frame({waitMs:1000}),f.stream.frame({waitMs:1000})];f.stream.stop();
  assert.deepEqual((await Promise.all(others)).map(x=>x.status),['stopped','stopped']);assert.equal(f.closed,1);
});

test('camera_snapshot reuses an active stream and never opens its snapshot transport',async t=>{
  const b=new BambuImplementation();t.after(()=>b.cameraStreams.stopAll());
  let handlers;
  b.cameraStreams.start(JSON.stringify(['dummy','serial']),{transport:'tcp-6000',fps:1,idleTimeoutMs:10000,skipFirstFrame:false,open:h=>{handlers=h;return {close(){}};}});
  b.fetchTcpCameraFrame=async()=>assert.fail('second connection');
  b.fetchRtspCameraFrame=async()=>assert.fail('second process');
  const jpeg=await picture(10);handlers.onFrame(jpeg);
  const frame=await b.cameraSnapshot('dummy','serial','dummy',{bambuModel:'p1s'});
  assert.equal(frame.base64,jpeg.toString('base64'));
});

test('TLS source reuses the existing framed decoder and one authenticated connection',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'camera-stream-tls-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=printer','-days','1','-keyout',path.join(dir,'key'),'-out',path.join(dir,'cert')]);
  if(cert.status!==0)return t.skip('openssl unavailable');
  const jpeg=await picture(40),header=Buffer.alloc(16);header.writeUInt32LE(jpeg.length);
  let connections=0,auth;
  const server=tls.createServer({key:fs.readFileSync(path.join(dir,'key')),cert:fs.readFileSync(path.join(dir,'cert'))},socket=>{
    connections++;socket.once('data',packet=>{auth=packet;const wire=Buffer.concat([header,jpeg,header,jpeg]);for(let offset=0;offset<wire.length;offset+=17)socket.write(wire.subarray(offset,offset+17));});socket.on('error',()=>{});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const frames=[],source=openTcpCameraSource('127.0.0.1','DUMMY_TOKEN',{onFrame:b=>frames.push(b),onError:e=>assert.fail(e.message),onEnd(){}},server.address().port);t.after(()=>source.close());
  await until(()=>frames.length===2);assert.equal(connections,1);assert.equal(auth.length,80);assert.equal(auth.subarray(48,59).toString(),'DUMMY_TOKEN');assert.deepEqual(frames,[jpeg,jpeg]);source.close();
});

test('RTSP source keeps one process for several frames, and stop kills that process',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'camera-stream-rtsp-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const jpeg=await picture(80),script=path.join(dir,'ffmpeg'),pidfile=path.join(dir,'pid');
  fs.writeFileSync(script,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));const b=Buffer.from(${JSON.stringify(jpeg.toString('base64'))},'base64');setInterval(()=>process.stdout.write(b),20);\n`,{mode:0o755});
  const frames=[],source=openRtspCameraSource('dummy','private-token',1,{onFrame:b=>frames.push(b),onError:e=>assert.fail(e.message),onEnd(){}},script);t.after(()=>source.close());
  await until(()=>frames.length>=3);assert.deepEqual(frames[0],jpeg);
  const pid=Number(fs.readFileSync(pidfile));source.close();await until(()=>{try{process.kill(pid,0);return false}catch{return true}});
});

test('MJPEG parser bounds an unterminated image and splits arbitrary chunks',async()=>{
  const jpeg=await picture(80),frames=[],errors=[];const parse=mjpegParser(b=>frames.push(b),e=>errors.push(e.message));
  const wire=Buffer.concat([jpeg,jpeg]);for(let i=0;i<wire.length;i+=3)parse(wire.subarray(i,i+3));assert.deepEqual(frames,[jpeg,jpeg]);
  parse(Buffer.concat([Buffer.from([0xff,0xd8]),Buffer.alloc(5_000_000)]));assert.equal(errors.length,1);
});

test('public stream tools validate limits, report stopped, and advertise capability without camera traffic',async t=>{
  const fixtureDir=fs.mkdtempSync(path.join(os.tmpdir(),'camera-wire-budget-'));
  t.after(()=>fs.rmSync(fixtureDir,{recursive:true,force:true}));
  const base64=(await picture(90)).toString('base64');
  const preload=path.join(fixtureDir,'fixture.mjs');
  fs.writeFileSync(preload, `import {BambuImplementation} from ${JSON.stringify(new URL('../dist/printers/bambu.js',import.meta.url).href)};
const original=BambuImplementation.prototype.cameraStreamFrame;
BambuImplementation.prototype.cameraStreamFrame=function(host,...args){return host==='wire-fixture' ? {status:'frame',seq:1,format:'image/jpeg',base64:${JSON.stringify(base64)}} : original.call(this,host,...args);};`);
  const client=new Client({name:'camera-stream-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',preload,'dist/index.js'],env:{...process.env,MCP_TRANSPORT:'stdio',BAMBU_MODEL:'',BAMBU_PRINTER_MODEL:'',BAMBU_TOKEN:'',BAMBU_SERIAL:'',PRINTER_HOST:'127.0.0.1'},stderr:'pipe'});
  transport.stderr?.on('data',()=>{});t.after(()=>client.close());await client.connect(transport);
  const tools=(await client.listTools()).tools.map(t=>t.name);
  for(const name of ['camera_stream_start','camera_frame','camera_stream_stop'])assert.ok(tools.includes(name));
  const delivered=await client.callTool({name:'camera_frame',arguments:{host:'wire-fixture'}});
  assert.equal(delivered.structuredContent.base64,base64);
  assert.equal(JSON.stringify(delivered).split(base64).length-1,1,'MCP transmits the JPEG once, not again in text content');
  const stopped=await client.callTool({name:'camera_frame',arguments:{host:'127.0.0.1',wait_ms:0}});assert.equal(stopped.structuredContent.status,'stopped');
  const bad=await client.callTool({name:'camera_stream_start',arguments:{fps:10,bambu_model:'p1s'}});assert.equal(bad.isError,true);
  for (const max_bytes of [0, 4095, 5000001, 42000.5]) assert.equal((await client.callTool({name:'camera_frame',arguments:{max_bytes}})).isError,true);
  const noModel=await client.callTool({name:'camera_stream_start',arguments:{}});assert.equal(noModel.isError,true);
  const info=await client.callTool({name:'counterpart_printer_info',arguments:{bambu_model:'p1s'}});assert.equal(info.structuredContent.capabilities.cameraStream,true);
  const end=await client.callTool({name:'camera_stream_stop',arguments:{}});assert.equal(end.structuredContent.status,'stopped');
});


test('a high-entropy frame respects the JPEG byte budget with bounded cached adaptive resizing', async t => {
  const f = fixture(t);
  const noisy = await sharp(randomBytes(1280 * 720 * 3), {raw: {width: 1280, height: 720, channels: 3}}).jpeg({quality: 95}).toBuffer();
  await f.put(noisy);
  const normal = await f.stream.frame({maxWidth: 1200});
  assert.ok(Buffer.from(normal.base64, 'base64').length > 42000);
  const limited = await f.stream.frame({maxWidth: 1200, maxBytes: 42000});
  assert.equal(limited.status, 'frame');
  assert.ok(Buffer.from(limited.base64, 'base64').length <= 42000);
  assert.ok(limited.width < 1200);
  assert.ok(limited.base64.length <= 56000, 'leaves 4 KB per two-second result for protocol overhead');
  assert.deepEqual(await f.stream.frame({maxWidth: 1200, maxBytes: 42000}), limited, 'repeat viewers share the cached encoding');
  const smallest = await f.stream.frame({maxBytes: 4096});
  assert.ok(Buffer.from(smallest.base64, 'base64').length <= 4096);
});

test('host overrides with the configured serial keep distinct stream, snapshot, and stop routes',async()=>{
  const b=new BambuImplementation(),streams=new Map();let opened=0;
  b.cameraStreams.start=(key,options)=>{
    let stream=streams.get(key),status='running';
    if(!stream){status='started';opened++;const bytes=Buffer.from(`image-${opened}`);stream={stopped:false,transport:options.transport,fps:options.fps,startedAt:String(opened),frame:async()=>({status:'frame',seq:opened,base64:bytes.toString('base64')}),latest:async()=>bytes};streams.set(key,stream);}
    return {stream,status};
  };
  b.cameraStreams.get=key=>streams.get(key);
  b.cameraStreams.stop=key=>{streams.get(key).stopped=true;};
  const first=b.cameraStreamStart('first.local','configured-serial','token',{bambuModel:'p1s'});
  const other=b.cameraStreamStart('second.local','configured-serial','token',{bambuModel:'p1s'});
  assert.equal(first.status,'started');assert.equal(other.status,'started');assert.equal(opened,2);
  assert.equal((await b.cameraStreamFrame('second.local','configured-serial')).base64,Buffer.from('image-2').toString('base64'));
  assert.equal((await b.cameraSnapshot('second.local','configured-serial','token')).base64,Buffer.from('image-2').toString('base64'));
  b.cameraStreamStop('second.local','configured-serial');
  assert.equal([...streams.values()][0].stopped,false);assert.equal([...streams.values()][1].stopped,true);
});
