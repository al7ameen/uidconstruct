// Test the REAL aggregate() from deep-scan.js by extracting its source and
// evaluating it. Same pattern used for serverless internals elsewhere:
// no browser needed for the pure function, and no hand-written copy that
// could drift from the file we ship.
const fs = require('fs');
const src = fs.readFileSync('deep-scan.js', 'utf8');

for (const need of ['function aggregate', 'function bump', 'function topN', 'var TOP', 'var DEFAULTS', 'function parsePx']) {
  if (!src.includes(need)) { console.error('MISSING from source: ' + need); process.exit(1); }
}
const body = src.slice(src.indexOf('var MAX_ELS'), src.indexOf('function collect'));
const f = new Function('return (function(){' + body + '; return {aggregate,bump,topN,TOP};})()');
const { aggregate, TOP } = f();

let pass = 0, fail = 0;
function ok(n, c, extra) { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' :: ' + extra : '')); } }
function el(styles, tag) { return { tag: tag || 'div', styles, box: { w: 100, h: 20 } }; }

// 1. Frequency ranking: the value the site uses most must lead its bucket.
let r = aggregate([
  el({ color: 'rgb(255, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)' }),
  el({ color: 'rgb(255, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)' }),
  el({ color: 'rgb(0, 0, 255)', backgroundColor: 'rgba(0, 0, 0, 0)' })
]);
ok('colors ranked by usage', r.colors[0].value === 'rgb(255, 0, 0)' && r.colors[0].uses === 2, JSON.stringify(r.colors));

// 2. Transparent backgrounds must NOT pollute the palette (the old bug shape).
r = aggregate([el({ backgroundColor: 'rgba(0, 0, 0, 0)' }), el({ backgroundColor: 'rgb(10,10,10)' })]);
ok('transparent bg excluded', r.backgrounds.length === 1 && r.backgrounds[0].value === 'rgb(10,10,10)', JSON.stringify(r.backgrounds));

// 3. Padding shorthand expands to individual values.
r = aggregate([el({ padding: '8px 16px', margin: '0px' })]);
const sp = r.spacing.map(s => s.value);
ok('padding shorthand expanded', sp.includes('8px') && sp.includes('16px'), JSON.stringify(r.spacing));
ok('zero margin ignored', !sp.includes('0px'), JSON.stringify(r.spacing));

// 4. Ridiculous computed values must not become a "spacing scale".
r = aggregate([el({ padding: '99999px' })]);
ok('absurd px rejected', r.spacing.length === 0, JSON.stringify(r.spacing));

// 5. pairs = the readable text-on-surface combos. This is the accuracy win.
r = aggregate([el({ color: 'rgb(255,255,255)', backgroundColor: 'rgb(0,0,0)' }, 'h1')]);
ok('pair captured', r.pairs.length === 1 && r.pairs[0].text === 'rgb(255,255,255)' && r.pairs[0].on === 'rgb(0,0,0)' && r.pairs[0].tag === 'h1', JSON.stringify(r.pairs));
r = aggregate([el({ color: 'rgb(255,255,255)', backgroundColor: 'rgba(0, 0, 0, 0)' })]);
ok('pair skipped on transparent', r.pairs.length === 0, JSON.stringify(r.pairs));

// 6. Only non-default weights reported.
r = aggregate([el({ fontWeight: '400' }), el({ fontWeight: '700' })]);
ok('default weight skipped', r.fontWeights.length === 1 && r.fontWeights[0].value === '700', JSON.stringify(r.fontWeights));

// 7. 'none'/'normal' never surface as tokens.
r = aggregate([el({ borderRadius: '0px', boxShadow: 'none', gap: 'normal', letterSpacing: 'normal' })]);
ok('none/normal filtered', r.radii.length === 0 && r.shadows.length === 0 && r.gaps.length === 0,
   JSON.stringify({ r: r.radii, s: r.shadows, g: r.gaps }));

// 8. Caps respected on a pathological page (this is what keeps prompt size sane).
const many = [];
for (let i = 0; i < 500; i++) many.push(el({ color: 'rgb(' + i + ',' + i + ',' + i + ')', backgroundColor: 'rgb(0,0,' + (i % 300) + ')' }));
r = aggregate(many);
ok('color cap = TOP', r.colors.length === TOP.color, 'got ' + r.colors.length);
ok('pairs capped at 240', r.pairs.length === 240, 'got ' + r.pairs.length);

// 9. Empty input must not throw.
try { const e = aggregate([]); ok('empty input safe', e.colors.length === 0 && e.pairs.length === 0); }
catch (err) { ok('empty input safe', false, err.message); }

// 10. Real JSON round-trip at a realistic page size (perf + validity).
const big = [];
for (let i = 0; i < 4000; i++) big.push(el({ color: 'rgb(1,2,3)', fontSize: '16px', fontFamily: 'Inter', padding: '8px', backgroundColor: 'rgb(9,9,9)' }));
const t0 = Date.now(); const out = JSON.stringify(aggregate(big)); const ms = Date.now() - t0;
ok('4000 elements aggregate <150ms', ms < 150, ms + 'ms');
ok('output is valid JSON', !!JSON.parse(out));
console.log('   4000-el aggregate: ' + ms + 'ms, ' + out.length + ' bytes JSON');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
