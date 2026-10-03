import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync('store.js','utf8');
const start = source.indexOf('export async function checkPendingDeletion()');
const end = source.indexOf('\n/* Rounds still waiting', start);
assert(start > 0 && end > start);
const body = source.slice(start,end).replace('export async','async');
function device({fail=false,pending=false,note=null}={}) {
  const timers = new Map(), events=[]; let next=0;
  const c=vm.createContext({uid:'account-A',fb:{mod:{store:{getDocFromServer:async()=>({exists:()=>pending})}}},
    deletionPendingFlag:false,deletionCheckUnknown:false,deletionRetryTimer:null,lastError:null,
    deletionNote:()=>note,clearDeletionNote(){note=null;},ref:(...p)=>p,
    withTimeout:async (p,ms)=>{ assert.equal(ms,6000); if(fail)throw Error('timeout'); return p; },
    setTimeout(fn,ms){assert.equal(ms,15000);const id=++next;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
    setError(short,full){c.lastError={short,full};},clearError(){c.lastError=null;},emit(patch){events.push(patch);}});
  vm.runInContext(body,c);return {c,timers,events,recover(){fail=false;pending=true;}};
}
let d=device(); assert.equal(await d.c.checkPendingDeletion(),false);assert.equal(d.c.deletionCheckUnknown,false);
console.log('PASS confirmed active account is not marked unknown');
d=device({pending:true}); assert.equal(await d.c.checkPendingDeletion(),true);assert.equal(d.c.deletionCheckUnknown,false);
console.log('PASS confirmed deletion blocks account opening');
d=device({fail:true});assert.equal(await d.c.checkPendingDeletion(),false);assert.equal(d.c.deletionCheckUnknown,true);assert.equal(d.timers.size,1);assert.match(d.c.lastError.full,/timeout does not confirm/);
await d.c.checkPendingDeletion();assert.equal(d.timers.size,1);
console.log('PASS timeout is unknown and schedules one retry, never confirmed active');
d.recover();await [...d.timers.values()][0]();assert.equal(d.c.deletionCheckUnknown,false);assert.equal(d.events[0].deletionDetected,true);
console.log('PASS retry detects deletion and requests sign-out');
d=device({fail:true,note:{uid:'account-A'}});assert.equal(await d.c.checkPendingDeletion(),true);assert.equal(d.c.deletionCheckUnknown,false);assert.equal(d.timers.size,0);
console.log('PASS local deletion request remains blocked during timeout');
d=device({fail:true});await d.c.checkPendingDeletion();d.c.uid='account-B';d.recover();await [...d.timers.values()][0]();assert.equal(d.events.length,0);
console.log('PASS old account retry cannot sign out a different account');
