/* deep-scan.js — reads the RENDERED page, not its stylesheets.
 *
 * Why this exists: uidconstruct mines the CSS a site *ships*. Some sites ship
 * almost none (linear.app exposes ~7KB, because a build tool hashes and inlines
 * it), so a regex over text cannot recover their real values. The browser has
 * already done the work: cascade applied, JS run, web fonts loaded, media
 * queries resolved. getComputedStyle() reports the truth after all of that.
 *
 * Privacy: this file makes NO network requests. It reads the DOM you are
 * already looking at and prints a summary to your console. Nothing leaves your
 * machine unless you copy it somewhere yourself.
 *
 * Use: paste into the target site's devtools console, then
 *      deepScan()            -> prints + copies JSON to clipboard
 *      deepScan({quiet:true}) -> returns the object, no clipboard write
 */
(function () {
  'use strict';

  var PROPS = ['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight',
    'lineHeight', 'letterSpacing', 'borderRadius', 'boxShadow', 'borderColor',
    'borderWidth', 'padding', 'margin', 'gap', 'display', 'position', 'zIndex',
    'opacity', 'textTransform'];

  var MAX_ELS = 4000;      // perf ceiling for huge marketing pages
  var TOP = { color: 24, fontSize: 16, fontWeight: 10, radius: 12, shadow: 10,
    spacing: 18, family: 12, gap: 12 };

  // A value is only interesting if it is not the browser default for that prop.
  var DEFAULTS = { backgroundColor: 'rgba(0, 0, 0, 0)', opacity: '1',
    position: 'static', display: 'inline', zIndex: 'auto', margin: '0px',
    padding: '0px', borderRadius: '0px', letterSpacing: 'normal', gap: 'normal' };

  function bump(store, key, prop) {
    if (!key || key === 'none' || key === 'normal') return;
    if (prop && DEFAULTS[prop] === key) return;   // browser default, not a design choice
    store[key] = (store[key] || 0) + 1;
  }

  function topN(store, n) {
    return Object.keys(store).sort(function (a, b) { return store[b] - store[a]; })
      .slice(0, n).map(function (k) { return { value: k, uses: store[k] }; });
  }

  function parsePx(v) { var m = parseFloat(v); return isNaN(m) ? null : m; }

  // Pure + unit-testable: samples -> aggregated spec. No DOM access in here.
  function aggregate(samples, doc) {
    var s = doc || TOP;
    var colors = {}, bgs = {}, fams = {}, sizes = {}, weights = {}, radii = {},
      shadows = {}, spacings = {}, gaps = {}, pairs = [], boxes = {};

    samples.forEach(function (el) {
      var st = el.styles, tag = el.tag;
      bump(colors, st.color, 'color');
      bump(bgs, st.backgroundColor, 'backgroundColor');
      bump(fams, st.fontFamily);
      bump(sizes, st.fontSize);
      if (st.fontWeight && st.fontWeight !== '400' && st.fontWeight !== 'normal') bump(weights, st.fontWeight);
      bump(radii, st.borderRadius, 'borderRadius');
      if (st.boxShadow && st.boxShadow !== 'none') bump(shadows, st.boxShadow);
      bump(gaps, st.gap, 'gap');
      ['padding', 'margin'].forEach(function (p) {
        (st[p] || '').split(/\s+/).forEach(function (v) {
          var px = parsePx(v);
          if (px !== null && px > 0 && px < 400) bump(spacings, px + 'px');
        });
      });
      // Readable pairs are the thing a spec actually needs: text ON a surface.
      if (st.color && st.backgroundColor && st.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          st.color !== 'rgba(0, 0, 0, 0)' && pairs.length < 240) {
        var k = st.color + '|' + st.backgroundColor + '|' + tag;
        if (!boxes[k]) { boxes[k] = 1; pairs.push({ text: st.color, on: st.backgroundColor, tag: tag }); }
      }
    });

    return {
      colors: topN(colors, s.color), backgrounds: topN(bgs, s.color),
      families: topN(fams, s.family), fontSizes: topN(sizes, s.fontSize),
      fontWeights: topN(weights, s.fontWeight), radii: topN(radii, s.radius),
      shadows: topN(shadows, s.shadow), spacing: topN(spacings, s.spacing),
      gaps: topN(gaps, s.gap), pairs: pairs
    };
  }

  // Runs in the browser. Cross-origin sheets throw SecurityError -> skip them.
  function mediaQueries() {
    var out = {};
    var sheets = document.styleSheets || [];
    for (var i = 0; i < sheets.length; i++) {
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var r = rules[j];
        if (r.type === 4 && r.media && r.media.mediaText) bump(out, r.media.mediaText.toLowerCase().replace(/\s+/g, ' '));
        if (r.type === 4 && r.cssRules) {
          for (var k = 0; k < r.cssRules.length; k++) {
            var q = r.cssRules[k];
            if (q.type === 4 && q.media) bump(out, q.media.mediaText.toLowerCase().replace(/\s+/g, ' '));
          }
        }
      }
    }
    return Object.keys(out).sort(function (a, b) { return out[b] - out[a]; }).slice(0, 20);
  }

  function animations() {
    var list = [];
    try {
      var found = {};
      (document.getAnimations ? document.getAnimations() : []).forEach(function (a) {
        var name = (a.animationName) || (a.effect && a.effect.getKeyframes &&
          (a.effect.getKeyframes()[0] || {}).animationName) || '';
        var d = a.effect && a.effect.getTiming ? a.effect.getTiming().duration : null;
        var e = a.effect && a.effect.getTiming ? a.effect.getTiming().easing : '';
        var key = name + '|' + d + '|' + e;
        if (!found[key]) { found[key] = 1; list.push({ name: name, durationMs: d, easing: e, state: a.playState }); }
      });
    } catch (e) { /* getAnimations unsupported */ }
    return list.slice(0, 20);
  }

  function collect() {
    var els = document.querySelectorAll('body *');
    var out = [];
    for (var i = 0; i < els.length && out.length < MAX_ELS; i++) {
      var el = els[i];
      var cs = getComputedStyle(el);
      if (!cs || cs.visibility === 'hidden' || cs.display === 'none') continue;
      var rect = el.getBoundingClientRect();
      var st = {};
      for (var p = 0; p < PROPS.length; p++) {
        var name = PROPS[p], v = cs[name];
        if (v && v !== DEFAULTS[name]) st[name] = v;
      }
      out.push({ tag: el.tagName.toLowerCase(), styles: st,
        box: { w: Math.round(rect.width), h: Math.round(rect.height) } });
    }
    return out;
  }

  window.deepScan = function (opts) {
    opts = opts || {};
    var samples = collect();
    var spec = aggregate(samples, TOP);
    var loaded = [];
    try { document.fonts.forEach(function (f) { if (f.status === 'loaded' && loaded.indexOf(f.family) < 0) loaded.push(f.family); }); } catch (e) {}
    var result = {
      _scan: 'uidconstruct deep-scan v1',
      domain: location.hostname.replace(/^www\./, ''),
      scannedAt: new Date().toISOString(),
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      elementsSampled: samples.length,
      fontsLoaded: loaded,
      mediaQueries: mediaQueries(),
      animations: animations(),
      tokens: spec
    };
    var json = JSON.stringify(result, null, 1);
    if (!opts.quiet) {
      console.log(json);
      try { copy(json); console.log('%cdeep-scan: ' + samples.length + ' elements copied to clipboard', 'color:#0a0'); } catch (e) {
        console.log('deep-scan: copy() unavailable — use deepScan({quiet:true}).tokens');
      }
    }
    return result;
  };
  console.log('deep-scan loaded. run: deepScan()');
})();
