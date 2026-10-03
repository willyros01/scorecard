import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const script=path.resolve('test/review/query-indexes.mjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scorecard-query-'));
try {
  fs.mkdirSync(path.join(dir,'build'));
  const run=(write=false)=>spawnSync(process.execPath,[script,...(write?['--write']:[])],{cwd:dir,encoding:'utf8'});
  fs.writeFileSync(path.join(dir,'store.js'),'query(collectionGroup(fb.db, "members"), where("uid", "==", uid), where("role", "==", role), orderBy("joinedAt", "desc"))');
  assert.equal(run(true).status,0);
  const q=JSON.parse(fs.readFileSync(path.join(dir,'build/query-indexes.json'))).queries[0];
  assert.equal(q.structuredQuery.where.compositeFilter.filters.length,2);assert.equal(q.structuredQuery.orderBy[0].direction,'DESCENDING');assert.equal(q.structuredQuery.from[0].allDescendants,true);
  assert.equal(run().status,0); console.log('PASS composite query probe retains every filter and sort');
  fs.appendFileSync(path.join(dir,'store.js'),'\nquery(col("golfers"), where("linkedUid", "==", uid))');
  assert.notEqual(run().status,0); console.log('PASS unregistered application query blocks verification');
  assert.equal(run(true).status,0);
  fs.writeFileSync(path.join(dir,'new-tool.html'),'query(collection(db, "associations"), where("ownerUid", "==", uid))');
  assert.notEqual(run().status,0);console.log('PASS new maintenance-page query also blocks verification');
  fs.writeFileSync(path.join(dir,'new-tool.html'),'query(col("associations", aid, "rounds"), where("golferId", "==", id))');
  assert.equal(run(true).status,0);
  const nested=JSON.parse(fs.readFileSync(path.join(dir,'build/query-indexes.json'))).queries.find(q=>q.collectionId==='rounds');
  assert.ok(nested.parent.split('/').every(id=>!/^__.*__$/.test(id)));
  console.log('PASS nested query probes never use Google-reserved document IDs');
  fs.writeFileSync(path.join(dir,'new-tool.html'),'query(collection(db, "associations"), where(dynamicField, "==", uid))');
  assert.notEqual(run(true).status,0);console.log('PASS dynamic constraints demand an explicit reviewed probe');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
