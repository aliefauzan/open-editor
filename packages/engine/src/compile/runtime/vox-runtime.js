/* global window, document */
// vox-runtime.js: per-instance scene variables (engine spec "Compile").
// vox.vars(el) returns the JSON of the <script type="application/json" data-vox-vars> that belongs
// to the composition containing `el`, so many mounted scenes in one document never collide.
(function () {
  'use strict';
  var cache = new WeakMap();
  function rootOf(el) {
    return el.closest('[data-composition-id]');
  }
  function vars(el) {
    var root = rootOf(el);
    if (!root) throw new Error('vox.vars: element is not inside a composition');
    var scripts = root.querySelectorAll('script[data-vox-vars]');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (rootOf(s) !== root) continue;
      var hit = cache.get(s);
      if (hit && hit.text === s.textContent) return hit.value;
      var value = JSON.parse(s.textContent);
      cache.set(s, { text: s.textContent, value: value });
      return value;
    }
    throw new Error('vox.vars: no data-vox-vars in ' + root.getAttribute('data-composition-id'));
  }
  // vox.mount(id): the instance root of scene `id`, found through its data-vox-instance marker (the
  // HyperFrames bundler may rename composition ids, e.g. `s3-p1__hf1` for nested mounts, so a
  // `[data-composition-id="<id>"]` lookup is not reliable), and `register(tl)` under the id the
  // runtime waits for.
  var claimed = new WeakSet();
  function mount(id) {
    var markers = document.querySelectorAll(
      'script[data-vox-vars][data-vox-instance="' + id + '"]',
    );
    // Claim markers, not roots: the runtime strips data-composition-id from a mounted inner root,
    // so rootOf() is the host, which stays the same element when vox-preview.js remounts a scene.
    var root = null;
    for (var i = 0; i < markers.length && !root; i++) {
      var r = rootOf(markers[i]);
      if (r && !claimed.has(markers[i])) {
        root = r;
        claimed.add(markers[i]);
      }
    }
    if (!root) throw new Error('vox.mount: no mounted instance ' + id);
    var chain = [];
    for (
      var el = root;
      el;
      el = el.parentElement && el.parentElement.closest('[data-composition-id]')
    ) {
      var cid = el.getAttribute('data-composition-id') || '';
      if (cid !== id && cid.indexOf(id + '__hf') !== 0) break;
      if (chain.indexOf(cid) < 0) chain.push(cid);
    }
    var keys = chain.indexOf(id) >= 0 ? [id] : chain.length ? chain : [id];
    return {
      root: root,
      vars: vars(root),
      keys: keys,
      register: function (tl) {
        for (var k = 0; k < keys.length; k++) window.__timelines[keys[k]] = tl;
      },
    };
  }
  window.vox = { vars: vars, mount: mount };
})();
