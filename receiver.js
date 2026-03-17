'use strict';

// ─── Monitorr Cast Receiver v0.0.7 ──────────────────────────────────────────
//
// Uses HLS.js (same as the web player) instead of the built-in cast-media-player.
// This gives us full control: seeking reloads the HLS source in-place without
// restarting the Cast app or creating a new media session.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.0.7';
  var NAMESPACE = 'urn:x-cast:com.monitorr.cast';
  var TAG = '[Monitorr v' + VERSION + ']';

  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();

  var CMD = cast.framework.messages.Command;
  var ALL_COMMANDS = CMD.ALL_BASIC_MEDIA | CMD.STREAM_TRANSFER;

  // ── State ──────────────────────────────────────────────────────────────────

  var realDuration = 0;
  var isHlsContent = false;
  var hlsSessionId = null;
  var monitorrOrigin = null;
  var currentContentUrl = null;
  var serverSeeking = false;
  var lastMetadata = null;
  var hls = null;

  var video = document.getElementById('monitorr-video');
  playerManager.setMediaElement(video);

  // ── Playback Configuration ─────────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;

  // ── LOAD Interceptor ───────────────────────────────────────────────────────
  // We handle HLS loading ourselves via HLS.js, so we intercept LOAD and
  // return null (suppress default) after setting up the player.

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      var media = request.media;
      if (!media) return request;

      var url = media.contentId || media.contentUrl || '';
      console.log(TAG, 'LOAD', url, 'duration:', media.duration);

      if (media.duration > 0) realDuration = media.duration;
      currentContentUrl = url;

      isHlsContent = url.indexOf('.m3u8') !== -1 ||
        media.contentType === 'application/x-mpegURL' ||
        media.contentType === 'application/vnd.apple.mpegurl';

      var match = url.match(/\/hls\/([a-f0-9]+)\//);
      hlsSessionId = match ? match[1] : null;

      try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

      if (media.metadata) lastMetadata = media.metadata;

      media.streamType = cast.framework.messages.StreamType.BUFFERED;
      media.supportedMediaCommands = ALL_COMMANDS;

      setIdleVisible(false);
      serverSeeking = false;
      updateMetadataDisplay();

      if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
        loadWithHlsJs(url);
        // Don't return the request -- we manage the player ourselves
        // But we still need the framework to track media info
        return request;
      }

      // DirectPlay fallback: let the framework handle MP4
      return request;
    }
  );

  function loadWithHlsJs(url) {
    if (hls) {
      hls.destroy();
      hls = null;
    }

    hls = new Hls({
      enableWorker: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      startLevel: -1,
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      console.log(TAG, 'HLS manifest parsed');
      video.play().catch(function (e) { console.warn(TAG, 'autoplay:', e); });
      if (realDuration <= 0) fetchDuration();
    });

    hls.on(Hls.Events.ERROR, function (_, data) {
      if (data.fatal) {
        console.error(TAG, 'HLS fatal error:', data.type, data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });

    console.log(TAG, 'HLS.js loading:', url);
  }

  // ── SEEK Interceptor ───────────────────────────────────────────────────────
  // For HLS: call server to restart FFmpeg, then reload HLS.js source in-place.
  // No new media session. No app restart. Just like the web overlay does.

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.SEEK,
    function (request) {
      var targetTime = request.currentTime;
      console.log(TAG, 'SEEK to', targetTime, 'hls:', isHlsContent);

      if (!isHlsContent || !hlsSessionId || !monitorrOrigin || !hls) {
        return request;
      }

      if (serverSeeking) {
        console.log(TAG, 'SEEK debounced');
        return null;
      }

      serverSeek(targetTime);
      return null;
    }
  );

  function serverSeek(targetTime) {
    serverSeeking = true;
    console.log(TAG, 'Server seek to', targetTime);

    video.pause();

    var seekUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1);

    fetch(seekUrl, { method: 'POST' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        console.log(TAG, 'Server seek OK:', JSON.stringify(data));
        if (!data.seeked) throw new Error('Server refused seek');

        // Reload the HLS source -- same as web overlay's hlsReload()
        if (hls) {
          var cacheBuster = Date.now().toString(36);
          var reloadUrl = currentContentUrl.split('?')[0] + '?seek=' + cacheBuster;
          currentContentUrl = reloadUrl;

          console.log(TAG, 'Reloading HLS source:', reloadUrl);
          hls.loadSource(reloadUrl);

          // Wait for the new manifest to be parsed, then play
          hls.once(Hls.Events.MANIFEST_PARSED, function () {
            video.currentTime = 0;
            video.play().catch(function () {});
            serverSeeking = false;
            playerManager.broadcastStatus();
            console.log(TAG, 'Seek reload complete');
          });
        } else {
          serverSeeking = false;
        }
      })
      .catch(function (err) {
        console.error(TAG, 'Server seek failed:', err);
        serverSeeking = false;
        video.play().catch(function () {});
      });
  }

  // ── MEDIA_STATUS Interceptor ───────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.MEDIA_STATUS,
    function (msg) {
      if (msg.status) {
        for (var i = 0; i < msg.status.length; i++) {
          var s = msg.status[i];
          s.supportedMediaCommands = ALL_COMMANDS;
          if (s.media) {
            if (realDuration > 0) s.media.duration = realDuration;
            s.media.streamType = cast.framework.messages.StreamType.BUFFERED;
            s.media.supportedMediaCommands = ALL_COMMANDS;
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
      console.log(TAG, 'Load complete, realDuration:', realDuration);
      if (realDuration <= 0) fetchDuration();

      var mediaInfo = playerManager.getMediaInformation();
      if (mediaInfo) {
        if (realDuration > 0) mediaInfo.duration = realDuration;
        mediaInfo.streamType = cast.framework.messages.StreamType.BUFFERED;
        mediaInfo.supportedMediaCommands = ALL_COMMANDS;
      }

      playerManager.setSupportedMediaCommands(ALL_COMMANDS, true);
      playerManager.broadcastStatus();
    }
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.MEDIA_FINISHED,
    function () {
      if (serverSeeking) return;
      console.log(TAG, 'Media finished');
      if (hls) { hls.destroy(); hls = null; }
      resetState();
      setIdleVisible(true);
    }
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.ERROR,
    function (event) {
      console.error(TAG, 'Error:', event.detailedErrorCode, event.error);
    }
  );

  // ── Duration Fetching ──────────────────────────────────────────────────────

  function fetchDuration() {
    if (!hlsSessionId || !monitorrOrigin) return;
    var infoUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/info';
    console.log(TAG, 'Fetching duration from', infoUrl);

    fetch(infoUrl)
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.durationSeconds > 0) {
          console.log(TAG, 'Duration from server:', info.durationSeconds + 's');
          applyDuration(info.durationSeconds);
        } else {
          setTimeout(fetchDuration, 3000);
        }
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  function applyDuration(dur) {
    realDuration = dur;
    var mediaInfo = playerManager.getMediaInformation();
    if (mediaInfo) mediaInfo.duration = dur;
    playerManager.broadcastStatus();
    console.log(TAG, 'Duration applied:', dur + 's');
  }

  // ── Metadata Display ──────────────────────────────────────────────────────

  function updateMetadataDisplay() {
    var titleEl = document.getElementById('meta-title');
    var subtitleEl = document.getElementById('meta-subtitle');
    var posterEl = document.getElementById('meta-poster');

    if (lastMetadata) {
      if (titleEl) titleEl.textContent = lastMetadata.title || '';
      if (subtitleEl) subtitleEl.textContent = lastMetadata.subtitle || '';
      if (lastMetadata.images && lastMetadata.images.length > 0 && posterEl) {
        posterEl.src = lastMetadata.images[0].url;
        posterEl.style.display = 'block';
      }
    }
  }

  // ── Custom Namespace ───────────────────────────────────────────────────────

  context.addCustomMessageListener(NAMESPACE, function (event) {
    var data = event.data;
    console.log(TAG, 'Custom:', data.type);

    switch (data.type) {
      case 'PING':
        context.sendCustomMessage(NAMESPACE, event.senderId, {
          type: 'PONG',
          version: VERSION,
          currentTime: video.currentTime,
          duration: realDuration,
          hlsSessionId: hlsSessionId,
          playerState: playerManager.getPlayerState()
        });
        break;
    }
  });

  // ── Sender connect/disconnect ──────────────────────────────────────────────

  context.addEventListener(
    cast.framework.system.EventType.SENDER_CONNECTED,
    function (event) { console.log(TAG, 'Sender connected:', event.senderId); }
  );

  context.addEventListener(
    cast.framework.system.EventType.SENDER_DISCONNECTED,
    function (event) {
      console.log(TAG, 'Sender disconnected:', event.senderId);
      if (context.getSenders().length === 0 &&
          playerManager.getPlayerState() === cast.framework.messages.PlayerState.IDLE) {
        if (hls) { hls.destroy(); hls = null; }
        context.stop();
      }
    }
  );

  // ── Helpers ────────────────────────────────────────────────────────────────

  function resetState() {
    realDuration = 0;
    isHlsContent = false;
    hlsSessionId = null;
    monitorrOrigin = null;
    currentContentUrl = null;
    serverSeeking = false;
    lastMetadata = null;
  }

  function setIdleVisible(visible) {
    var el = document.getElementById('monitorr-idle');
    if (el) el.style.display = visible ? 'flex' : 'none';
    var wm = document.getElementById('monitorr-watermark');
    if (wm) wm.style.display = visible ? 'none' : 'flex';
    var playerEl = document.getElementById('monitorr-player');
    if (playerEl) playerEl.style.display = visible ? 'none' : 'flex';
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  var opts = new cast.framework.CastReceiverOptions();
  opts.playbackConfig = playbackConfig;
  opts.maxInactivity = 3600;
  opts.supportedCommands = ALL_COMMANDS;
  opts.skipPlayersLoad = true;
  opts.customNamespaces = {};
  opts.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;

  context.start(opts);
  console.log(TAG, 'Receiver v' + VERSION + ' started');
  setIdleVisible(true);

})();
