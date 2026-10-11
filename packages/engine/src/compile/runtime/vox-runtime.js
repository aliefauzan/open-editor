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
  //
  // `root` is the scene's authored root as mounted. HyperFrames flattens a template root below its
  // host: the root loses data-composition-id and id and gets data-hf-inner-root, and the scene's
  // `#root { ... }` rules (style tokens, box) are scoped to that inner root. Content a scene script
  // appends must go inside it, or `var(--tok-*)` is undefined there (GATE 5: captions rendered in
  // the default serif with no stroke). Unflattened, the root is the composition element itself.
  var claimed = new WeakSet();
  function contentRoot(marker) {
    return marker.closest('[data-hf-inner-root], [data-composition-id]');
  }
  function mount(id) {
    var markers = document.querySelectorAll(
      'script[data-vox-vars][data-vox-instance="' + id + '"]',
    );
    // Claim markers, not roots: the runtime strips data-composition-id from a mounted inner root,
    // so rootOf() is the host, which stays the same element when vox-preview.js remounts a scene.
    var host = null;
    var root = null;
    for (var i = 0; i < markers.length && !host; i++) {
      var r = rootOf(markers[i]);
      if (r && !claimed.has(markers[i])) {
        host = r;
        root = contentRoot(markers[i]);
        claimed.add(markers[i]);
      }
    }
    if (!host) throw new Error('vox.mount: no mounted instance ' + id);
    var chain = [];
    for (
      var el = host;
      el;
      el = el.parentElement && el.parentElement.closest('[data-composition-id]')
    ) {
      var cid = el.getAttribute('data-composition-id') || '';
      if (cid !== id && cid.indexOf(id + '__hf') !== 0) break;
      if (chain.indexOf(cid) < 0) chain.push(cid);
    }
    var keys = chain.indexOf(id) >= 0 ? [id] : chain.length ? chain : [id];
    // Templates write `window.__timelines[mount.key] = mount.register(tl);` so `hyperframes lint`
    // sees the registration (inlined preview templates are not exempt from its static check).
    return {
      root: root,
      vars: vars(host),
      keys: keys,
      key: keys[0],
      register: function (tl) {
        window.__timelines = window.__timelines || {};
        for (var k = 0; k < keys.length; k++) window.__timelines[keys[k]] = tl;
        return tl;
      },
    };
  }
  window.vox = { vars: vars, mount: mount };
})();
