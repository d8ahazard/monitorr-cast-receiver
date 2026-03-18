'use strict';

// ─── Monitorr Cast Receiver v0.5.2 ──────────────────────────────────────────
//
// Works WITH the Cast platform, not against it.
// cast-media-player handles UI, D-pad, seek bar, play/pause.
// We intercept LOAD (HLS.js), SEEK (server-side), and patch MEDIA_STATUS.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var TAG = '[Monitorr]';
  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();

  var realDuration = 0;
  var seekOffset = 0;
  var hlsSessionId = null;
  var monitorrOrigin = null;
  var currentUrl = null;
  var isHlsContent = false;
  var serverSeeking = false;
  var hls = null;

  // ── Playback Config ────────────────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;
  playbackConfig.initialBandwidthEstimate = 5000000;

  // ── LOAD Interceptor ───────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      var media = request.media;
      if (!media) return request;

      var url = media.contentId || '';
      console.log(TAG, 'LOAD', url);

      destroyHls();
      seekOffset = 0;
      serverSeeking = false;
      currentUrl = url;

      if (media.duration > 0) realDuration = media.duration;
      else realDuration = 0;

      isHlsContent = url.indexOf('.m3u8') !== -1 ||
        (media.contentType && media.contentType.indexOf('mpegURL') !== -1);

      var match = url.match(/\/hls\/([a-f0-9]+)\//);
      hlsSessionId = match ? match[1] : null;

      try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

      if (request.currentTime > 0) seekOffset = request.currentTime;

      media.streamType = cast.framework.messages.StreamType.BUFFERED;

      // If HLS, load with HLS.js on the cast-media-player's video element
      if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
        var videoEl = document.querySelector('cast-media-player').getMediaElement();
        if (videoEl) {
          loadHls(url, videoEl);
          if (realDuration <= 0) fetchDuration();
        }
      }

      return request;
    }
  );

  // ── SEEK Interceptor ───────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.SEEK,
    function (request) {
      var targetTime = request.currentTime;
      console.log(TAG, 'SEEK to', targetTime);

      if (!isHlsContent || !hlsSessionId || !monitorrOrigin) {
        return request;
      }

      if (serverSeeking) return null;
      serverSeeking = true;

      var seekUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1);

      fetch(seekUrl, { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (res) {
          console.log(TAG, 'Server seek OK');
          seekOffset = res.offsetSeconds || targetTime;

          var cacheBuster = Date.now().toString(36);
          var reloadUrl = currentUrl.split('?')[0] + '?seek=' + cacheBuster;
          currentUrl = reloadUrl;

          var videoEl = document.querySelector('cast-media-player').getMediaElement();
          if (videoEl) {
            destroyHls();
            loadHls(reloadUrl, videoEl);
          }

          serverSeeking = false;
          playerManager.broadcastStatus();
        })
        .catch(function (err) {
          console.error(TAG, 'Server seek failed:', err);
          serverSeeking = false;
        });

      return null; // Suppress default seek
    }
  );

  // ── MEDIA_STATUS Interceptor ───────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.MEDIA_STATUS,
    function (msg) {
      if (msg.status) {
        for (var i = 0; i < msg.status.length; i++) {
          var s = msg.status[i];
          if (!serverSeeking) {
            s.currentTime = seekOffset + (s.currentTime || 0);
          }
          if (s.media) {
            if (realDuration > 0) s.media.duration = realDuration;
            s.media.streamType = cast.framework.messages.StreamType.BUFFERED;
          }
        }
      }
      return msg;
    }
  );

  // ── Player Events ──────────────────────────────────────────────────────────

  playerManager.addEventListener(
    cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
    function () {
      console.log(TAG, 'Load complete');
      if (realDuration <= 0) fetchDuration();
      var mi = playerManager.getMediaInformation();
      if (mi) {
        if (realDuration > 0) mi.duration = realDuration;
        mi.streamType = cast.framework.messages.StreamType.BUFFERED;
      }
      playerManager.broadcastStatus();
    }
  );

  // ── HLS.js ─────────────────────────────────────────────────────────────────

  function loadHls(url, videoEl) {
    destroyHls();
    hls = new Hls({
      enableWorker: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      startLevel: -1,
    });
    hls.loadSource(url);
    hls.attachMedia(videoEl);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      console.log(TAG, 'HLS manifest parsed');
      videoEl.play().catch(function () {});
    });
    hls.on(Hls.Events.ERROR, function (_, data) {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
  }

  function destroyHls() {
    if (hls) { hls.detachMedia(); hls.destroy(); hls = null; }
  }

  // ── Duration ───────────────────────────────────────────────────────────────

  function fetchDuration() {
    if (!hlsSessionId || !monitorrOrigin) return;
    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/info')
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.durationSeconds > 0) {
          realDuration = info.durationSeconds;
          if (info.startOffsetSeconds > 0 && seekOffset === 0) seekOffset = info.startOffsetSeconds;
          var mi = playerManager.getMediaInformation();
          if (mi) mi.duration = realDuration;
          playerManager.broadcastStatus();
        } else setTimeout(fetchDuration, 3000);
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  var opts = new cast.framework.CastReceiverOptions();
  opts.playbackConfig = playbackConfig;
  opts.disableIdleTimeout = true;
  opts.maxInactivity = 3600;

  context.start(opts);
  console.log(TAG, 'Receiver v0.5.2 started');

})();
