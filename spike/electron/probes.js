/* global window, document, requestAnimationFrame */
// Injected into the composition iframe by electron/main.ts (WebFrameMain.executeJavaScript works in
// opaque mode too, where the parent page cannot reach the iframe DOM). Records, during playback:
// - every rAF: [wallMs, compositionTime] (timeline fps, stalls);
// - every presented video frame (requestVideoFrameCallback): [wallMs, videoId, mediaTime];
// - every ~6th rAF: audio vs picture position of each playing linked clip pair.
(function () {
  'use strict';
  if (window.__voxProbe) return;
  var rec = null;
  var gen = 0;
  function attr(el, name) {
    return parseFloat(el.getAttribute(name) || '0') || 0;
  }
  function r4(x) {
    return Math.round(x * 10000) / 10000;
  }
  function player() {
    return window.__player;
  }
  function pairs() {
    var out = [];
    var videos = Array.prototype.slice.call(document.querySelectorAll('video[data-start]'));
    var audios = Array.prototype.slice.call(document.querySelectorAll('audio[data-start]'));
    audios.forEach(function (a) {
      var v = videos.filter(function (x) {
        return (
          x.getAttribute('data-start') === a.getAttribute('data-start') &&
          x.getAttribute('data-duration') === a.getAttribute('data-duration')
        );
      })[0];
      out.push({ a: a, v: v || null });
    });
    return out;
  }
  function sampleAv(wall, t) {
    rec.pairs.forEach(function (p) {
      if (p.a.paused) return;
      var start = attr(p.a, 'data-start');
      var dur = attr(p.a, 'data-duration');
      if (t < start || t >= start + dur) return;
      var aPos = p.a.currentTime - attr(p.a, 'data-media-start');
      var row = [r4(wall), r4(t), p.a.id, r4(aPos - (t - start)), null, null];
      if (p.v && !p.v.paused) {
        var vPos = p.v.currentTime - attr(p.v, 'data-media-start');
        row[4] = r4(vPos - (t - start));
        row[5] = r4(aPos - vPos);
      }
      rec.av.push(row);
    });
  }
  function watchVideo(v, g) {
    if (!v.requestVideoFrameCallback) return;
    var cb = function (wall, md) {
      if (!rec || g !== gen) return;
      rec.vfc.push([r4(wall), v.id, r4(md.mediaTime)]);
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }
  // In preview the runtime routes <audio> through WebAudio: it applies the volume (GSAP volume tweens
  // sampled into keyframes) on a GainNode and pins el.volume to 1, so the gain values are recorded.
  var gains = null;
  function hookGain() {
    if (gains) return;
    gains = [];
    var desc = Object.getOwnPropertyDescriptor(window.AudioParam.prototype, 'value');
    Object.defineProperty(window.AudioParam.prototype, 'value', {
      configurable: true,
      get: desc.get,
      set: function (v) {
        if (gains && gains.length < 20000)
          gains.push([r4(performance.now()), r4(player().getTime()), r4(v)]);
        desc.set.call(this, v);
      },
    });
  }
  // last presented frame per video (diagnostics for wrong frames after a seek)
  var presented = {};
  Array.prototype.slice.call(document.querySelectorAll('video')).forEach(function (v) {
    if (!v.requestVideoFrameCallback) return;
    var cb = function (wall, md) {
      presented[v.id] = [r4(wall), r4(md.mediaTime), md.presentedFrames];
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  });
  // runtime diagnostics it swallows (labels such as runtime.init.seekHoldCap)
  var swallowed = [];
  if (window.__hf) {
    window.__hf.onSwallowed = function (x) {
      if (swallowed.length < 500) swallowed.push([r4(performance.now()), String(x && x.label)]);
    };
  }
  // media element events and long animation frames during a recording (stall diagnostics)
  var evlog = [];
  var MEDIA_EVENTS = [
    'seeking',
    'seeked',
    'play',
    'playing',
    'waiting',
    'pause',
    'stalled',
    'suspend',
    'canplay',
    'emptied',
  ];
  Array.prototype.slice.call(document.querySelectorAll('video')).forEach(function (v) {
    MEDIA_EVENTS.forEach(function (name) {
      v.addEventListener(name, function () {
        var row = [
          r4(performance.now()),
          r4(player().getTime()),
          v.id,
          name,
          r4(v.currentTime),
          v.readyState,
        ];
        if (rec && rec.events.length < 20000) rec.events.push(row);
        evlog.push(row);
        if (evlog.length > 4000) evlog.splice(0, 1000);
      });
    });
  });
  if (window.PerformanceObserver) {
    try {
      new window.PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (!rec || e.duration < 80 || rec.loaf.length > 500) return;
          rec.loaf.push({
            start: r4(e.startTime),
            ms: r4(e.duration),
            blockingMs: r4(e.blockingDuration || 0),
            renderStart: r4(e.renderStart || 0),
            styleAndLayoutStart: r4(e.styleAndLayoutStart || 0),
            scripts: (e.scripts || []).map(function (x) {
              return {
                ms: r4(x.duration),
                invoker: String(x.invoker),
                src: String(x.sourceURL).slice(-60),
                fn: String(x.sourceFunctionName),
              };
            }),
          });
        });
      }).observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      /* not supported */
    }
  }
  window.__voxProbe = {
    events: function (sinceMs) {
      return evlog.filter(function (x) {
        return x[0] >= (sinceMs || 0);
      });
    },
    swallowed: function (sinceMs) {
      return swallowed.filter(function (x) {
        return x[0] >= (sinceMs || 0);
      });
    },
    presented: function (id) {
      return presented[id] || null;
    },
    hookGain: function () {
      hookGain();
      gains.length = 0;
      return true;
    },
    gains: function () {
      return gains ? gains.slice() : [];
    },
    time: function () {
      return player().getTime();
    },
    duration: function () {
      return player().getDuration();
    },
    start: function () {
      gen++;
      var g = gen;
      rec = { raf: [], vfc: [], av: [], events: [], loaf: [], pairs: pairs(), n: 0 };
      Array.prototype.slice.call(document.querySelectorAll('video')).forEach(function (v) {
        watchVideo(v, g);
      });
      (function tick() {
        if (!rec || g !== gen) return;
        var wall = performance.now();
        var t = player().getTime();
        rec.raf.push([r4(wall), r4(t)]);
        if (++rec.n % 6 === 0) sampleAv(wall, t);
        requestAnimationFrame(tick);
      })();
      return true;
    },
    stop: function () {
      var r = rec;
      rec = null;
      gen++;
      return r ? { raf: r.raf, vfc: r.vfc, av: r.av, events: r.events, loaf: r.loaf } : null;
    },
    media: function () {
      return {
        videos: Array.prototype.slice.call(document.querySelectorAll('video')).map(function (v) {
          return { id: v.id, muted: v.muted, volume: v.volume };
        }),
        audios: Array.prototype.slice.call(document.querySelectorAll('audio')).map(function (a) {
          return { id: a.id, muted: a.muted, volume: r4(a.volume), paused: a.paused };
        }),
      };
    },
  };
})();
