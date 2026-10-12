#!/usr/bin/env node
'use strict';
// Scorecard Android adapter regression suite: deliberately uses shipped code.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const platform=fs.readFileSync('platform.js','utf8');
const app=fs.readFileSync('app.js','utf8');
const native=fs.readFileSync('build/android-native.sh','utf8');
new vm.Script(platform.replace(/^export\s+/gm,''),'Scorecard platform.js');
function harness(os,hasNative=true,failed=false,opts={}){
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
  if(hasNative && os==='android')Plugins.ScorecardAndroid={
    saveToDownloads:async data=>{calls.downloads.push(data);if(failed)throw Error('Downloads unavailable');return {saved:true,location:'Downloads',fileName:data.fileName};},
    openExternal:async data=>{calls.external.push(data);if(failed)throw Error('Silk unavailable');return {};}
  };
  const Cap={isNativePlatform:()=>os!=='web',getPlatform:()=>opts.platformReported||os,Plugins};
  if (opts.noGetPlatform) delete Cap.getPlatform;
  const ctx={window:{__SCORECARD_NATIVE_ANDROID__:opts.nativeFlag===true,
    Capacitor:opts.injectLater?null:(os==='web'?null:Cap),
      location:opts.androidHost?{hostname:'localhost',protocol:'http:'}:undefined},
    navigator:{userAgent:opts.androidHost?'Mozilla/5.0 (Linux; Android 11; Fire HD 8)':'Browser'},
    localStorage:{getItem:()=>null,setItem:()=>{}},URL,Date,Promise,Set};
  vm.createContext(ctx);
  const transformed=platform.replace(/^export\s+/gm,'');
  vm.runInContext(transformed+'\nthis.api={isAndroid,saveFile,openExternal,isApp,guideUrl,joinBase};',ctx);
  return {api:ctx.api,calls,inject:()=>{ctx.window.Capacitor=Cap;}};
}
// Exercise the real backup sheet and saveBackup handler, not just platform.saveFile.
// The Fire HD 8 reported that tapping "Save it somewhere" opened Share.
async function actualBackupScenario(android, fail=false) {
  const start=app.indexOf("function openBackupSheet() {");
  const stop=app.indexOf("/* Lets the person choose where it goes",start);
  const saveStart=app.indexOf("async function saveBackup() {",stop);
  const saveStop=app.indexOf("function downloadBackup() {",saveStart);
  assert(start>=0 && stop>start && saveStart>stop && saveStop>saveStart,
    'Could not find actual backup handlers for behavioral test');
  const nativeCalls=[];
  const shareCalls=[];
  const messages=[];
  const status={hidden:true,textContent:''};
  const sheet={
    hidden:true,
    dataset:{},
    innerHTML:'',
    querySelector:()=>status
  };
  const api={
    isAndroid:()=>android,
    isApp:()=>true,
    canShare:()=>true,
    saveFile:async (...args)=>{
      nativeCalls.push(args);
      if(fail) throw Error('Downloads service unavailable');
      if(android) return {saved:true,location:'Downloads',fileName:args[0]};
      shareCalls.push(args); return undefined;
    }
  };
  const ctx={platform:api,sheetEl:sheet,
    backupData:()=>({kind:'scorecard-backup',group:'TEST',rounds:[{id:'fixture'}]}),
    backupFilename:()=> 'scorecard-TEST-2026-10-12.txt',
    rounds:[{id:'fixture'}],golfers:[{id:'golfer'}],courses:[{id:'course'}],
    flashMsg:s=>messages.push(s),render:()=>{},
    navigator:{share:async data=>{shareCalls.push(data);throw Error('Share must not be called from Android Save');}},
    window:{},Promise};
  vm.createContext(ctx);
  vm.runInContext(app.slice(start,stop)+app.slice(saveStart,saveStop),ctx);
  ctx.openBackupSheet();
  await ctx.saveBackup();
  return {nativeCalls,shareCalls,messages,status,sheet};
}
async function run(){
  assert(app.includes('platform.isAndroid()'), 'Android-specific truthfulness missing');
  assert(app.includes('Backup saved to Downloads:'), 'Android backup confirmation missing');
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
  h=harness('android',true,false,{noGetPlatform:true});
  assert.equal(h.api.isAndroid(),true,'Native plugin should identify Android even when getPlatform is absent');
  await h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON');
  assert.equal(h.calls.downloads.length,1);assert.equal(h.calls.shares.length,0);
  console.log('PASS: missing getPlatform never routes Android to iOS Share');
  h=harness('android',true,false,{platformReported:'web'});
  assert.equal(h.api.isAndroid(),true);
  await h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON');
  assert.equal(h.calls.shares.length,0);
  console.log('PASS: registered Android plugin takes priority over stale web platform value');
  h=harness('android',true,false,{injectLater:true});
  assert.equal(h.api.isAndroid(),false,'No native bridge before injection');
  h.inject();
  assert.equal(h.api.isAndroid(),true,'Live bridge should be detected after first import');
  await h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON');
  assert.equal(h.calls.shares.length,0);
  console.log('PASS: late Capacitor bridge injection cannot strand native app on web Share');
  h=harness('android',false,false,{injectLater:true,nativeFlag:true});
  assert.equal(h.api.isAndroid(),true,'Packaged native flag must identify Android without Capacitor');
  await assert.rejects(()=>h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON'),/Downloads service is unavailable/);
  assert.equal(h.calls.shares.length,0);
  console.log('PASS: deterministic Android APK identity never falls back to Share when bridge is absent');
  assert(fs.readFileSync('build/android-build.sh','utf8').includes('window.__SCORECARD_NATIVE_ANDROID__=true;'));
  assert(!fs.readFileSync('index.html','utf8').includes('window.__SCORECARD_NATIVE_ANDROID__=true;'),
    'Web/iOS source bootstrap must not contain Android-only marker');
  console.log('PASS: Android-only packaging marker leaves web and iOS entry point untouched');
  h=harness('android',false,false,{injectLater:true,androidHost:true});
  assert.equal(h.api.isAndroid(),true,'Native Android localhost must fail closed');
  await assert.rejects(()=>h.api.saveFile('sc.txt','SAMPLE_BACKUP_JSON'),/Downloads service is unavailable/);
  assert.equal(h.calls.shares.length,0);
  console.log('PASS: Android native localhost with missing bridge does not silently Share');

  let backup=await actualBackupScenario(true);
  assert(backup.sheet.innerHTML.includes('Save backup to Downloads'), 'Fire Android backup button not explicit');
  assert(!backup.sheet.innerHTML.includes('Save it somewhere'), 'Fire Android must not show ambiguous iOS save label');
  assert.equal(backup.nativeCalls.length,1);
  assert.equal(backup.shareCalls.length,0);
  assert.equal(backup.sheet.hidden,true);
  assert.match(backup.messages.join(' '),/Backup saved to Downloads: scorecard-/);
  console.log('PASS: real Android backup UI saves directly to Downloads and confirms exact file');
  backup=await actualBackupScenario(true,true);
  assert.equal(backup.nativeCalls.length,1);
  assert.equal(backup.shareCalls.length,0);
  assert.equal(backup.sheet.hidden,false);
  assert.match(backup.status.textContent,/Backup was NOT saved: Downloads service unavailable/);
  console.log('PASS: real Android backup UI shows visible failure without Share');
  backup=await actualBackupScenario(false);
  assert(backup.sheet.innerHTML.includes('Save it somewhere'));
  assert.equal(backup.shareCalls.length,1);
  console.log('PASS: iOS backup UI preserves existing Save to Files Share route');
  assert(native.includes('getContext().startActivity(intent)'), 'Android must launch external app directly');
  assert(!native.includes('if (intent.resolveActivity('), 'No unreliable Fire OS preflight');
  assert(native.includes('MediaStore.Downloads.EXTERNAL_CONTENT_URI'), 'Must save into public Downloads');
  assert(native.includes('IS_PENDING'), 'Must finalize Android 10+ backup write');
  assert(native.includes('ActivityNotFoundException'), 'Must catch real missing browser');
  console.log('PASS: native launch and Downloads APIs have safe failure handling');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
