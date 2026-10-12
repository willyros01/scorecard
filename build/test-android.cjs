#!/usr/bin/env node
'use strict';
// Scorecard Android adapter regression suite: deliberately uses shipped code.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const platform=fs.readFileSync('platform.js','utf8');
const app=fs.readFileSync('app.js','utf8');
const native=fs.readFileSync('build/android-native.sh','utf8');
new vm.Script(platform.replace(/^export\s+/gm,''),'Scorecard platform.js');
function harness(os,hasNative=true,failed=false){
  const calls={downloads:[],external:[],shares:[],alerts:[],files:[]};
  const Plugins={
    Filesystem:{
      writeFile:async data=>{calls.files.push(data);return {uri:'content://cache/scorecard.txt'};},
      readFile:async data=>({data:'SAMPLE_BACKUP_JSON'}),
      getUri:async data=>({uri:'content://cache/scorecard.txt'})
    },
    Share:{share:async data=>{calls.shares.push(data);}},
    AppLauncher:{openUrl:async data=>{calls.external.push(data);}}
  };
  if(hasNative)Plugins.ScorecardAndroid={
    saveToDownloads:async data=>{calls.downloads.push(data);if(failed)throw Error('Downloads unavailable');return {saved:true,location:'Downloads',fileName:data.fileName};},
    openExternal:async data=>{calls.external.push(data);if(failed)throw Error('Silk unavailable');return {};}
  };
  const Cap={isNativePlatform:()=>os!=='web',getPlatform:()=>os,Plugins};
  const ctx={window:{Capacitor:os==='web'?null:Cap},navigator:{},
    localStorage:{getItem:()=>null,setItem:()=>{}},URL,Date,Promise,Set};
  vm.createContext(ctx);
  const transformed=platform.replace(/^export\s+/gm,'');
  vm.runInContext(transformed+'\nthis.api={isAndroid,saveFile,openExternal,isApp,guideUrl,joinBase};',ctx);
  return {api:ctx.api,calls};
}
async function run(){
  assert(app.includes('platform.isAndroid()'), 'Android-specific truthfulness missing');
  assert(app.includes('Backup saved to Downloads on this device.'), 'Android backup confirmation missing');
  let h=harness('android');
  const result=await h.api.saveFile('sc-backup.txt','SAMPLE_BACKUP_JSON','Scorecard backup');
  assert.equal(result.saved,true);assert.equal(result.location,'Downloads');
  assert.equal(h.calls.downloads.length,1);assert.equal(h.calls.downloads[0].fileName,'sc-backup.txt');
  assert.equal(h.calls.shares.length,0);
  console.log('PASS: Android backup writes directly to Downloads without Share');
  h=harness('android',false);
  await assert.rejects(()=>h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON'),/Downloads service is unavailable/);
  assert.equal(h.calls.shares.length,0);
  console.log('PASS: unavailable native Downloads service never silently shares');
  h=harness('android',true,true);
  await assert.rejects(()=>h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON'),/Downloads unavailable/);
  assert.equal(h.calls.shares.length,0);
  console.log('PASS: failed Android save reports an error rather than success');
  h=harness('android');
  await h.api.openExternal('https://www.cuberoot-systems.com/scorecard/guide/');
  assert.equal(h.calls.external.length,1);assert.equal(h.calls.external[0].url,'https://www.cuberoot-systems.com/scorecard/guide/');
  console.log('PASS: Android external links use native OS rather than AppLauncher preflight');
  h=harness('ios');
  await h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON');
  assert.equal(h.calls.files.length,1);assert.equal(h.calls.shares.length,1);
  assert.equal(h.calls.downloads.length,0);
  console.log('PASS: existing iOS file Share workflow remains intact');
  h=harness('web');
  assert.equal(h.api.isApp(),false);assert.equal(h.api.isAndroid(),false);
  console.log('PASS: web platform detection remains unchanged');
  assert(native.includes('getContext().startActivity(intent)'), 'Android must launch external app directly');
  assert(!native.includes('if (intent.resolveActivity('), 'No unreliable Fire OS preflight');
  assert(native.includes('MediaStore.Downloads.EXTERNAL_CONTENT_URI'), 'Must save into public Downloads');
  assert(native.includes('IS_PENDING'), 'Must finalize Android 10+ backup write');
  assert(native.includes('ActivityNotFoundException'), 'Must catch real missing browser');
  console.log('PASS: native launch and Downloads APIs have safe failure handling');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
