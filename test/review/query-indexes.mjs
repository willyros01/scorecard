/* Every parameterised Firestore search must have a live-index probe.
   Emulator success is never reported as proof of a live index. */
import fs from 'node:fs';
import crypto from 'node:crypto';
const source = fs.readFileSync('store.js', 'utf8');
const queries = [];
for (const match of source.matchAll(/\bquery\s*\(/g)) {
  let depth = 1, quote = '', i = match.index + match[0].length;
  const begin = i;
  for (; i < source.length && depth; i++) {
    const ch = source[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; }
    else if ('"\'`'.includes(ch)) quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  if (depth) throw new Error('Cannot parse a Firestore query');
  const text = source.slice(begin, i - 1).replace(/\s+/g, ' ').trim();
  const signature = crypto.createHash('sha256').update(text).digest('hex');
  const group = /collectionGroup\(fb\.db, "([^"]+)"\)/.exec(text);
  const collection = /(?:col|collection)\(([^)]*)\)/.exec(text);
  const literals = collection ? [...collection[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
  const collectionId = group ? group[1] : literals.at(-1);
  if (!collectionId) throw new Error('Query target needs an explicit probe: ' + text);
  const field = /(?:where|orderBy)\("([^"]+)"/.exec(text)?.[1];
  const op = /where\("[^"]+", "([^"]+)"/.exec(text)?.[1];
  const from = [{ collectionId, ...(group ? {allDescendants:true} : {}) }];
  const structuredQuery = { from, limit:1 };
  if (field && op) structuredQuery.where = {fieldFilter: {field:{fieldPath:field}, op: ({'==':'EQUAL','>=':'GREATER_THAN_OR_EQUAL','in':'IN','array-contains':'ARRAY_CONTAINS'})[op], value: op === 'in' ? {arrayValue:{values:[{stringValue:'__scorecard_index_probe__'}]}} : {stringValue:field === 'date' ? '9999-12-31' : '__scorecard_index_probe__'} }};
  else if (field) structuredQuery.orderBy = [{field:{fieldPath:field},direction:text.includes('"desc"')?'DESCENDING':'ASCENDING'}];
  if (structuredQuery.where && !structuredQuery.where.fieldFilter.op) throw new Error('Unsupported probe operator: ' + op);
  queries.push({signature,collectionId,parent:!group && literals[0]==='associations' && literals.length>1 ? 'associations/__scorecard_index_probe__' : '',structuredQuery});
}
const file = 'build/query-indexes.json';
if (process.argv.includes('--write')) fs.writeFileSync(file, JSON.stringify({queries},null,2)+'\n');
else {
  const expected = JSON.parse(fs.readFileSync(file,'utf8')).queries;
  if (JSON.stringify(expected)!==JSON.stringify(queries)) throw new Error('A Firestore search changed without updating its live-index probe. Run node test/review/query-indexes.mjs --write and verify the new probe.');
  console.log('PASS: all '+queries.length+' Firestore query calls have an explicit live-index probe');
}
