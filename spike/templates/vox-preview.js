/* global window, document */
// vox-preview.js (preview builds only): the scene-only patch path of the app spec "Preview
// pipeline". The renderer sends `player.setRuntimeData('vox-patch', { id, start, duration, html })`
// with the recompiled instance file of one scene (the inner HTML of its <template>); this remounts
// that sub-composition in place at the current time, without reloading the iframe.
//
// HyperFrames 0.8.145 has no public remount, so this repeats what its template mount does for our
// instance files: scope the styles to the host, normalise the inner root, run the scripts. The new
// GSAP timeline is nested into the old timeline object, which the runtime already placed at the
// host's start; host timing is read live from data-start / data-duration.
(function () {
  'use strict';
  var hf = window.__hyperframes;
  if (!hf || typeof hf.registerRuntimeDataHandler !== 'function') return;

  var STRIP = [
    'data-composition-id',
    'data-start',
    'data-duration',
    'data-end',
    'data-track-index',
    'data-composition-src',
  ];

  function scopeCss(css, id) {
    var host = '[data-composition-id="' + id + '"]';
    return css.replace(/(^|})(\s*)([^{}@]+)\{/g, function (_m, close, ws, sel) {
      var scoped = sel
        .split(',')
        .map(function (s) {
          var t = s.trim();
          if (!t) return t;
          if (t.indexOf('#root') === 0) return host + ' [data-hf-authored-id="root"]' + t.slice(5);
          return host + ' ' + t;
        })
        .join(', ');
      return close + ws + scoped + ' {';
    });
  }

  function patch(p) {
    if (!p || typeof p.id !== 'string' || typeof p.html !== 'string')
      throw new Error('vox-patch: bad payload');
    var host = document.getElementById(p.id);
    if (!host) throw new Error('vox-patch: no host ' + p.id);
    var marker = '[data-composition-id="' + p.id + '"]';

    var tpl = document.createElement('template');
    tpl.innerHTML = p.html;
    var frag = tpl.content;
    var styles = Array.prototype.slice.call(frag.querySelectorAll('style'));
    var scripts = Array.prototype.slice.call(
      frag.querySelectorAll('script:not([type="application/json"])'),
    );
    var root = frag.querySelector('[data-composition-id]');
    if (!root) throw new Error('vox-patch: no root in ' + p.id);

    // Old scoped styles of this instance (exact id match, so `s3` never removes `s3-p1`).
    Array.prototype.slice.call(document.head.querySelectorAll('style')).forEach(function (s) {
      if (
        s.textContent.indexOf(marker) >= 0 &&
        s.textContent.indexOf(marker + ' [data-composition-id') < 0
      )
        s.remove();
    });
    styles.forEach(function (s) {
      var el = document.createElement('style');
      el.textContent = scopeCss(s.textContent, p.id);
      document.head.appendChild(el);
      s.remove();
    });
    scripts.forEach(function (s) {
      s.remove();
    });

    var rid = root.getAttribute('id');
    STRIP.forEach(function (a) {
      root.removeAttribute(a);
    });
    if (rid) {
      root.removeAttribute('id');
      root.setAttribute('data-hf-authored-id', rid);
    }
    root.setAttribute('data-hf-inner-root', 'true');
    root.style.width = host.getAttribute('data-width') + 'px';
    root.style.height = host.getAttribute('data-height') + 'px';

    if (typeof p.start === 'number') host.setAttribute('data-start', String(p.start));
    if (typeof p.duration === 'number') host.setAttribute('data-duration', String(p.duration));
    host.replaceChildren(root);
    var t = document.getElementById(p.id + '-template');
    if (t) t.innerHTML = p.html;

    var timelines = window.__timelines || {};
    var oldTl = timelines[p.id];
    scripts.forEach(function (s) {
      var el = document.createElement('script');
      el.textContent = '(function(){' + s.textContent + '\n})();';
      document.body.appendChild(el);
      el.remove();
    });
    var newTl = timelines[p.id];
    if (oldTl && newTl && oldTl !== newTl && typeof oldTl.clear === 'function') {
      oldTl.clear();
      newTl.paused(false);
      oldTl.add(newTl, 0);
      timelines[p.id] = oldTl;
    }
    var player = window.__player;
    if (player && typeof player.getTime === 'function') player.seek(player.getTime());
    return true;
  }

  // Reload path ("reload and seek to the saved playhead"): the renderer stores the playhead with
  // `player.setRuntimeData('vox-playhead', seconds)` before it changes src; the player re-delivers it
  // to the new document. The player's `ready` event comes before the runtime has mounted the inline
  // scene templates (phase 01: 0.6-0.9 s later with 12 scenes), and a seek sent in between is lost,
  // so the seek waits here until every template host is mounted and its timeline registered.
  function mounted() {
    var hosts = document.querySelectorAll('[data-composition-id]');
    for (var i = 0; i < hosts.length; i++) {
      var id = hosts[i].getAttribute('data-composition-id');
      if (!document.getElementById(id + '-template')) continue;
      if (!hosts[i].querySelector('[data-hf-inner-root]')) return false;
      if (!window.__timelines || !window.__timelines[id]) return false;
    }
    return true;
  }
  var pending = null;
  function seekWhenMounted(t) {
    if (typeof t !== 'number' || !isFinite(t)) throw new Error('vox-playhead: bad time');
    var first = pending === null;
    pending = t;
    if (!first) return true;
    (function wait() {
      var player = window.__player;
      if (!player || !mounted()) return void window.requestAnimationFrame(wait);
      // one more frame: the runtime captures the root timeline right after the last mount
      window.requestAnimationFrame(function () {
        var at = pending;
        pending = null;
        player.seek(at);
      });
    })();
    return true;
  }

  // Media helpers run on every frame (cheap: about 100 elements):
  // - Pre-cue: the runtime's first sync of a media element only seeks it when it is more than 0.5 s
  //   off (HyperFrames 0.8.145 media sync), so a clip whose in-point is under 0.5 s starts playing
  //   from 0 and the clock holds until a later correction (phase 01: a 0.3 s stall and wrong frames
  //   at the cut into a clip with in-point 10/30 s). Upcoming paused elements are parked on their
  //   in-point.
  // - Paused sync: while paused, the runtime leaves a video alone when it is less than 40 ms off
  //   (more than one frame), so a clip the runtime had parked on its out-point showed the frame
  //   after its last one when a seek landed on that last frame. Every active video is held on its
  //   exact frame while the player is paused (half a frame at 30 fps is the tolerance).
  // Times are absolute: nested hosts (scenes, panels) add their own data-start.
  var CUE_AHEAD_S = 1;
  var HALF_FRAME_S = 0.5 / 30;
  function attrNum(el, name) {
    var v = parseFloat(el.getAttribute(name) || '0');
    return isFinite(v) ? v : 0;
  }
  function absStart(el) {
    var s = attrNum(el, 'data-start');
    var host = el.parentElement && el.parentElement.closest('[data-composition-id][data-start]');
    for (
      ;
      host;
      host = host.parentElement && host.parentElement.closest('[data-composition-id][data-start]')
    ) {
      s += attrNum(host, 'data-start');
    }
    return s;
  }
  function setTime(el, at) {
    try {
      el.currentTime = at;
    } catch {
      /* not loaded yet: the runtime seeks it on activation */
    }
  }
  (function cue() {
    var player = window.__player;
    if (player && typeof player.getTime === 'function') {
      var t = player.getTime();
      var paused = typeof player.isPlaying === 'function' && !player.isPlaying();
      var media = document.querySelectorAll('video, audio');
      for (var i = 0; i < media.length; i++) {
        var el = media[i];
        if (!el.hasAttribute('data-start') || !el.paused || el.seeking) continue;
        var start = absStart(el);
        var inPoint = attrNum(el, 'data-media-start');
        if (t < start) {
          if (t >= start - CUE_AHEAD_S && Math.abs(el.currentTime - inPoint) > 0.01)
            setTime(el, inPoint);
          continue;
        }
        if (!paused || el.tagName !== 'VIDEO' || t >= start + attrNum(el, 'data-duration'))
          continue;
        var target = inPoint + (t - start);
        if (Math.abs(el.currentTime - target) > HALF_FRAME_S) setTime(el, target);
      }
    }
    window.requestAnimationFrame(cue);
  })();

  hf.registerRuntimeDataHandler('vox-patch', patch);
  hf.registerRuntimeDataHandler('vox-playhead', seekWhenMounted);
  window.__voxPatch = patch;
})();
