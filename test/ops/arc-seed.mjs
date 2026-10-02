/* Seeds the emulators for test/ops/arc-tests.sh. CL5-style; ARC_DUMP=file writes a backup instead. */
const P = process.env.PROJECT || "scorecard-f41b8";
const FS = "http://127.0.0.1:8080/v1";
const DB = `projects/${P}/databases/(default)/documents`;
const H = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const enc = (x) => x == null ? { nullValue: null } : typeof x === "boolean" ? { booleanValue: x }
  : typeof x === "number" ? (Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x })
  : typeof x === "string" ? { stringValue: x } : Array.isArray(x) ? { arrayValue: { values: x.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, enc(v)])) } };
const docs = [];
const put = (path, data) => docs.push({ update: { name: `${DB}/${path}`, fields: enc(data).mapValue.fields } });
const variant = process.argv[2] || "";
put("groupCreators/W", { at: 1 });
put("associations/G1", { name: "Golfing Buddies", ownerUid: "W" });
put("associations/G1/members/W", { uid: "W", role: "owner", golferId: "gReal" });
put("associations/G1/roster/gReal", { golferId: "gReal" });
put("associations/G1/roster/gPat", { golferId: "gPat" });
put("associations/G1/rounds/r1", { golferId: "gReal", date: "2026-09-01", gross: 90 });
put("associations/G1/rounds/r2", { golferId: "c4", date: "2026-09-02", gross: 95 });
put("golfers/gReal", { name: "Willy Rosales", linkedUid: "W", groups: ["G1"], handicapIndex: 18.2 });
put("golfers/gPat", { name: "Pat Player", linkedUid: "UP", groups: ["G1"] });
put("golferNames/willy-rosales", { golferId: "gReal" });
put("golfers/c1", { name: "Willy Rosales", linkedUid: variant === "mine" ? "W" : "OLD1", groups: ["GONE1"] });
put("golfers/c2", { name: "willy  rosales", linkedUid: "OLD2", groups: ["GONE2"] });
put("golfers/c3", { name: "Willy Rosales", linkedUid: null, groups: [] });
put("golfers/c4", { name: "Willy Rosales", groups: [] });            /* has a round: kept */
put("golfers/c5", { name: "Somebody Else", groups: [] });            /* matches nobody: kept */
if (variant !== "mine" && variant !== "namelist") put("golfers/c6", { name: "Pat Player", linkedUid: "UP", groups: [] }); /* linked to a real golfer's account: left as is */
if (variant === "namelist") put("golferNames/willy-rosales", { golferId: "c2" });
if (process.env.ARC_DUMP) {
  const fs = await import("node:fs"); const t = "2026-10-02T12:00:00.000000Z";
  fs.writeFileSync(process.env.ARC_DUMP, JSON.stringify({ kind: "scorecard-full-backup", version: 1, project: P,
    documents: docs.map((w) => ({ path: w.update.name.slice(DB.length + 1), fields: w.update.fields, missing: false, createTime: t, updateTime: t })), accounts: [] }));
  process.exit(0);
}
const r = await fetch(`${FS}/${DB}:commit`, { method: "POST", headers: H, body: JSON.stringify({ writes: docs }) });
if (!r.ok) { console.error(await r.text()); process.exit(1); }
