/* global window, document, location */
// Spike renderer page (vox-app://app/index.html). The main process drives it with
// webContents.executeJavaScript (no preload: this spike has no window.vox API).
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var events = [];
  var player = document.createElement('hyperframes-player');
  var w = Number(q.get('w') || 540);
  var h = Number(q.get('h') || 960);
  player.style.width = w + 'px';
  player.style.height = h + 'px';
  player.setAttribute('width', '1080');
  player.setAttribute('height', '1920');
  if (q.get('mode') !== 'same-origin') player.setAttribute('sandbox-origin', 'opaque');
  [
    'ready',
    'error',
    'ended',
    'playbackerror',
    'runtimedataapplied',
    'runtimedataerror',
    'runtimeprotocolerror',
  ].forEach(function (name) {
    player.addEventListener(name, function (e) {
      var d;
      try {
        d = e.detail === undefined ? null : JSON.parse(JSON.stringify(e.detail));
      } catch {
        d = String(e.detail);
      }
      events.push({ name: name, at: window.performance.now(), detail: d });
    });
  });
  // Transport bar below the player, as in the app: the timecode is redrawn on every seek.
  var transport = document.createElement('div');
  transport.id = 'transport';
  transport.textContent = '00:00.000';
  function showTime(t) {
    var m = Math.floor(t / 60);
    var sec = t - m * 60;
    transport.textContent = (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(3);
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(player);
    document.body.appendChild(transport);
    player.setAttribute('src', q.get('src') || 'vox-media://build/index.html');
  });
  window.voxPage = {
    player: player,
    seek: function (t) {
      player.seek(t);
      showTime(t);
    },
    events: events,
    waitFor: function (name, sinceIndex, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var t0 = window.performance.now();
        (function poll() {
          for (var i = sinceIndex || 0; i < events.length; i++)
            if (events[i].name === name) return resolve(events[i]);
          if (window.performance.now() - t0 > (timeoutMs || 20000))
            return reject(new Error('timeout waiting for ' + name));
          window.setTimeout(poll, 10);
        })();
      });
    },
  };
})();
