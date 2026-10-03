import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import path from "node:path";

const site = path.resolve(process.argv[2] || ".");
const source = readFileSync(path.join(site, "platform.js"), "utf8");
function harness(saved = new Map(), start = 1000000) {
  let clock = start;
  const context = vm.createContext({
    URL, URLSearchParams, Date: { now: () => clock },
    localStorage: {
      getItem: k => saved.get(k) ?? null,
      setItem: (k, v) => saved.set(k, String(v))
    },
    window: { Capacitor: { isNativePlatform: () => true, Plugins: {
      App: { getLaunchUrl: async () => ({url: "https://www.cuberoot-systems.com/scorecard/join/?join=G1.PRIV01.gL"}) }
    }}},
    location: { search: "", href: "capacitor://localhost/" }
  });
  // Execute the real platform code; expose its public exports to this harness.
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m => m[1]);
  vm.runInContext(source.replace(/\bexport /g, "") + "\n globalThis.api = {" + names.join(",") + "};", context);
  return { api: context.api, advance: ms => { clock += ms; }, saved, now: () => clock };
}
let failed = 0;
async function check(id, title, fn) {
  try { await fn(); console.log("PASS " + id + " " + title); }
  catch (e) { failed++; console.error("FAIL " + id + " " + title + ": " + e.message); }
}
const link = "https://www.cuberoot-systems.com/scorecard/join/?join=G1.PRIV01.gL";
await check("LINK1", "a new invitation is accepted", () => {
  const h = harness(); assert.equal(h.api.takeLink(link), true);
  assert.equal(h.api.linkQuery(), "?join=G1.PRIV01.gL");
});
await check("LINK2", "duplicate native delivery while pending is ignored", () => {
  const h = harness(); h.api.takeLink(link); assert.equal(h.api.takeLink(link), false);
});
await check("LINK3", "successful consumption clears the pending invitation", () => {
  const h = harness(); h.api.takeLink(link); h.api.clearLinkQuery();
  assert.equal(h.api.linkQuery(), "");
});
await check("LINK4", "immediate duplicate after success is ignored", () => {
  const h = harness(); h.api.takeLink(link); h.api.clearLinkQuery();
  assert.equal(h.api.takeLink(link), false);
});
await check("LINK5", "launch URL replay on an immediate reload is ignored", async () => {
  const h = harness(); h.api.takeLink(link); h.api.clearLinkQuery();
  const reloaded = harness(h.saved, h.now()); await reloaded.api.initLinks();
  assert.equal(reloaded.api.linkQuery(), "");
});
await check("LINK6", "a consumed invitation never returns after eleven minutes", async () => {
  const h = harness(); h.api.takeLink(link); h.api.clearLinkQuery(); h.advance(11 * 60 * 1000);
  const reloaded = harness(h.saved, h.now()); await reloaded.api.initLinks();
  assert.equal(reloaded.api.linkQuery(), "", "consumed launch invitation became pending again");
});
await check("LINK7", "a different invitation remains usable after consumption", () => {
  const h = harness(); h.api.takeLink(link); h.api.clearLinkQuery();
  assert.equal(h.api.takeLink(link.replace("gL", "gNew")), true);
});
await check("LINK8", "an unrelated address cannot replace a pending invitation", () => {
  const h = harness(); h.api.takeLink(link);
  assert.equal(h.api.takeLink("https://example.com/"), false);
  assert.equal(h.api.linkQuery(), "?join=G1.PRIV01.gL");
});
await check("LINK9", "a malformed address is ignored", () => {
  assert.equal(harness().api.takeLink("this is not a URL"), false);
});
console.log("RESULT: " + (9-failed) + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;

