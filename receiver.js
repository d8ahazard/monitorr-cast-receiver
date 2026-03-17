'use strict';

// ─── Monitorr Cast Receiver v0.0.6 ──────────────────────────────────────────
//
// Architecture:
//   - HLS EVENT playlists are left intact (no manifest hacking). The internal
//     Shaka player polls the growing manifest and consumes new segments as
//     FFmpeg produces them.
//   - Duration and supportedMediaCommands are overridden in MEDIA_STATUS so
//     sender UIs (Google Home, phone remotes) show the full movie length and
//     a seek bar.
//   - SEEK is intercepted: POSTs to the Monitorr server to restart FFmpeg at
//     the requested offset, then reloads the player with a fresh manifest.
//   - Duration is fetched from the server info endpoint (which probes with
//     ffprobe if the DB doesn't have it).
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.0.6';
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

  // ── Playback Configuration ─────────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;
  playbackConfig.initialBandwidthEstimate = 5000000;

  // No manifest manipulation -- let the EVENT playlist work naturally so the
  // player keeps fetching new segments as FFmpeg produces them.

  // ── LOAD Interceptor ───────────────────────────────────────────────────────

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

      if (isHlsContent) {
        media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
        media.hlsVideoSegmentFormat = cast.framework.messages.HlsVideoSegmentFormat.FMP4;
      }

      // Tell the protocol layer this is seekable BUFFERED content
      media.streamType = cast.framework.messages.StreamType.BUFFERED;
      media.supportedMediaCommands = ALL_COMMANDS;
      if (media.metadata) lastMetadata = media.metadata;

      setIdleVisible(false);
      serverSeeking = false;

      console.log(TAG, 'LOAD: hls=' + isHlsContent + ' dur=' + realDuration + ' session=' + hlsSessionId);
      return request;
    }
  );

  // ── SEEK Interceptor ───────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.SEEK,
    function (request) {
      var targetTime = request.currentTime;
      console.log(TAG, 'SEEK to', targetTime, 'hls:', isHlsContent);

      // DirectPlay (MP4): let the default seek handle it
      if (!isHlsContent || !hlsSessionId || !monitorrOrigin) {
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

    var seekUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1);

    fetch(seekUrl, { method: 'POST' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        console.log(TAG, 'Server seek response:', JSON.stringify(data));
        if (!data.seeked) throw new Error('Server refused seek');

        var cacheBuster = Date.now().toString(36);
        var reloadUrl = currentContentUrl.split('?')[0] + '?seek=' + cacheBuster;
        currentContentUrl = reloadUrl;

        console.log(TAG, 'Reloading player:', reloadUrl);

        var loadReq = new cast.framework.messages.LoadRequestData();
        loadReq.media = new cast.framework.messages.MediaInformation();
        loadReq.media.contentId = reloadUrl;
        loadReq.media.contentType = 'application/x-mpegURL';
        loadReq.media.streamType = cast.framework.messages.StreamType.BUFFERED;
        loadReq.media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
        loadReq.media.hlsVideoSegmentFormat = cast.framework.messages.HlsVideoSegmentFormat.FMP4;
        loadReq.media.supportedMediaCommands = ALL_COMMANDS;
        if (realDuration > 0) loadReq.media.duration = realDuration;
        if (lastMetadata) loadReq.media.metadata = lastMetadata;
        loadReq.autoplay = true;
        loadReq.currentTime = 0;

        return playerManager.load(loadReq);
      })
      .then(function () {
        console.log(TAG, 'Reload after seek complete');
        serverSeeking = false;
      })
      .catch(function (err) {
        console.error(TAG, 'Server seek failed:', err);
        serverSeeking = false;
      });
  }

  // ── MEDIA_STATUS Interceptor ───────────────────────────────────────────────
  // Override duration and commands on every outgoing status so sender UIs
  // show the full movie seek bar regardless of the HLS manifest's duration.

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

      // Fetch duration from server if we don't have it yet
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
    if (!hlsSessionId || !monitorrOrigin) {
      fallbackToPlayerDuration();
      return;
    }
    var infoUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/info';
    console.log(TAG, 'Fetching duration from', infoUrl);

    fetch(infoUrl)
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.durationSeconds > 0) {
          console.log(TAG, 'Duration from server:', info.durationSeconds + 's');
          applyDuration(info.durationSeconds);
        } else {
          console.log(TAG, 'Server duration 0, retrying in 3s');
          setTimeout(fetchDuration, 3000);
        }
      })
      .catch(function () {
        fallbackToPlayerDuration();
      });
  }

  function fallbackToPlayerDuration() {
    try {
      var el = playerManager.getMediaElement();
      if (el && isFinite(el.duration) && el.duration > 10) {
        applyDuration(el.duration);
      } else {
        setTimeout(fetchDuration, 5000);
      }
    } catch (e) {}
  }

  function applyDuration(dur) {
    realDuration = dur;
    var mediaInfo = playerManager.getMediaInformation();
    if (mediaInfo) mediaInfo.duration = dur;
    playerManager.broadcastStatus();
    console.log(TAG, 'Duration applied:', dur + 's');
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
          currentTime: playerManager.getCurrentTimeSec(),
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
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  var opts = new cast.framework.CastReceiverOptions();
  opts.playbackConfig = playbackConfig;
  opts.maxInactivity = 3600;
  opts.supportedCommands = ALL_COMMANDS;
  opts.customNamespaces = {};
  opts.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;

  context.start(opts);
  console.log(TAG, 'Receiver v' + VERSION + ' started');
  setIdleVisible(true);

})();
