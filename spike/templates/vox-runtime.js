/* global window */
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
  window.vox = { vars: vars };
})();
