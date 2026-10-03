import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync('app.js', 'utf8');
const body = source.slice(source.indexOf('let flashTimer;'), source.indexOf('/* ================= joining'));
let now = 0, next = 0;
const timers = new Map();
const c = vm.createContext({ flash:null, render(){},
  setTimeout(fn, ms){ const id = ++next; timers.set(id,{fn,at:now+ms}); return id; },
  clearTimeout(id){ timers.delete(id); } });
vm.runInContext(body, c);
c.flashMsg('Earlier message'); now = 3100; c.flashMsg('Approval completed'); now = 3200;
for (const [id,t] of timers) if(t.at <= now){ timers.delete(id); t.fn(); }
assert.equal(c.flash, 'Approval completed', 'an older timer erased the newer approval confirmation');
now = 13099;
for (const [id,t] of timers) if(t.at <= now){ timers.delete(id); t.fn(); }
assert.equal(c.flash, 'Approval completed', 'confirmation vanished before its full display interval');
now = 13100;
for (const [id,t] of timers) if(t.at <= now){ timers.delete(id); t.fn(); }
assert.equal(c.flash, null);
console.log('PASS: previous notice cannot erase the new approval confirmation; full display interval verified');
