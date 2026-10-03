/* Every parameterised Firestore search must have a live-index probe.
   Emulator success is never reported as proof of a live index. */
import fs from 'node:fs';
import crypto from 'node:crypto';
const queries = [];
const files = fs.readdirSync('.').filter(p => /\.(?:js|html)$/.test(p)).sort();
for (const sourceFile of files) {
const source = fs.readFileSync(sourceFile, 'utf8');
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
  const filters = [...text.matchAll(/where\("([^"]+)", "([^"]+)"/g)].map(m => {
    const [_,field,op] = m;
    const operation = {'==':'EQUAL','!=':'NOT_EQUAL','>=':'GREATER_THAN_OR_EQUAL','>':'GREATER_THAN','<=':'LESS_THAN_OR_EQUAL','<':'LESS_THAN','in':'IN','not-in':'NOT_IN','array-contains':'ARRAY_CONTAINS','array-contains-any':'ARRAY_CONTAINS_ANY'}[op];
    if (!operation) throw new Error('Unsupported probe operator: ' + op);
    const one = {stringValue:field === 'date' ? '9999-12-31' : '__scorecard_index_probe__'};
    return {fieldFilter:{field:{fieldPath:field},op:operation,value:['in','not-in','array-contains-any'].includes(op)?{arrayValue:{values:[one]}}:one}};
  });
  const orders = [...text.matchAll(/orderBy\("([^"]+)"(?:, "([^"]+)")?/g)].map(m => ({field:{fieldPath:m[1]},direction:m[2]==='desc'?'DESCENDING':'ASCENDING'}));
  if ([...text.matchAll(/\bwhere\(/g)].length !== filters.length || [...text.matchAll(/\borderBy\(/g)].length !== orders.length) throw new Error('Dynamic constraint needs a manually reviewed probe: ' + text);
  const structuredQuery = {from:[{collectionId,...(group?{allDescendants:true}:{})}],limit:1};
  if (filters.length) structuredQuery.where = filters.length===1 ? filters[0] : {compositeFilter:{op:'AND',filters}};
  if (orders.length) structuredQuery.orderBy=orders;
  queries.push({sourceFile,signature,collectionId,parent:!group && literals[0]==='associations' && literals.length>1 ? 'associations/scorecard-index-probe-nonexistent' : '',structuredQuery});
}
}
const file = 'build/query-indexes.json';
if (process.argv.includes('--write')) fs.writeFileSync(file, JSON.stringify({queries},null,2)+'\n');
else {
  const expected = JSON.parse(fs.readFileSync(file,'utf8')).queries;
  if (JSON.stringify(expected)!==JSON.stringify(queries)) throw new Error('A Firestore search changed without updating its live-index probe. Run node test/review/query-indexes.mjs --write and verify the new probe.');
  console.log('PASS: all '+queries.length+' Firestore query calls have an explicit live-index probe');
}
