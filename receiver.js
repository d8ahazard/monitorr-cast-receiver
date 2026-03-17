'use strict';

// ─── Monitorr Cast Receiver v0.0.4 ──────────────────────────────────────────
//
// Server-side seeking: when the user seeks beyond the transcoded frontier,
// the receiver calls POST /api/cast/hls/{sessionId}/seek on the Monitorr
// server, which restarts FFmpeg at the requested offset. The receiver then
// reloads its HLS source with fresh segments.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.0.4';
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

  // ── Playback Configuration ─────────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;
  playbackConfig.initialBandwidthEstimate = 5000000;

  // Patch HLS manifests: convert EVENT -> VOD and inject ENDLIST so Shaka
  // treats the on-demand transcode output as a seekable VOD playlist.
  playbackConfig.manifestHandler = function (manifest) {
    if (manifest && manifest.indexOf('#EXTINF') !== -1) {
      manifest = manifest.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
      if (manifest.indexOf('#EXT-X-ENDLIST') === -1) {
        manifest = manifest.trimEnd() + '\n#EXT-X-ENDLIST\n';
      }
    }
    return manifest;
  };

  // ── LOAD Interceptor ───────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      var media = request.media;
      if (!media) return request;

      var url = media.contentId || media.contentUrl || '';
      console.log(TAG, 'LOAD', url, 'duration:', media.duration);

      realDuration = (media.duration > 0) ? media.duration : 0;
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

      media.streamType = cast.framework.messages.StreamType.BUFFERED;
      media.supportedMediaCommands = ALL_COMMANDS;
      serverSeeking = false;

      setIdleVisible(false);
      console.log(TAG, 'LOAD: hls=' + isHlsContent + ' dur=' + realDuration + ' session=' + hlsSessionId);

      return request;
    }
  );

  // ── SEEK Interceptor ───────────────────────────────────────────────────────
  // For HLS: intercept the seek, POST to Monitorr server to restart FFmpeg
  // at the requested offset, then reload the player with fresh segments.
  // The seek is handled entirely by the receiver -- no sender involvement.

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.SEEK,
    function (request) {
      var targetTime = request.currentTime;
      console.log(TAG, 'SEEK to', targetTime, 'hls:', isHlsContent, 'session:', hlsSessionId);

      if (!isHlsContent || !hlsSessionId || !monitorrOrigin) {
        return request;
      }

      if (serverSeeking) {
        console.log(TAG, 'SEEK ignored -- server seek already in progress');
        return null;
      }

      // Perform server-side seek asynchronously and reload the player
      serverSeek(targetTime);

      // Return null to suppress the default seek (player can't seek to non-existent segments)
      return null;
    }
  );

  function serverSeek(targetTime) {
    serverSeeking = true;
    console.log(TAG, 'Server seek to', targetTime, 'via', monitorrOrigin);

    var seekUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1);

    fetch(seekUrl, { method: 'POST' })
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        console.log(TAG, 'Server seek response:', JSON.stringify(data));

        if (!data.seeked) {
          console.error(TAG, 'Server seek failed');
          serverSeeking = false;
          return;
        }

        // Reload the player with the same HLS URL (server has restarted FFmpeg at offset).
        // Add cache buster so the player fetches the fresh manifest.
        var cacheBuster = Date.now().toString(36);
        var reloadUrl = currentContentUrl.split('?')[0] + '?seek=' + cacheBuster;

        console.log(TAG, 'Reloading player source:', reloadUrl);

        // Build a new LOAD request to reload the player
        var mediaInfo = playerManager.getMediaInformation();
        var loadRequest = new cast.framework.messages.LoadRequestData();
        loadRequest.media = new cast.framework.messages.MediaInformation();
        loadRequest.media.contentId = reloadUrl;
        loadRequest.media.contentType = 'application/x-mpegURL';
        loadRequest.media.streamType = cast.framework.messages.StreamType.BUFFERED;
        loadRequest.media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
        loadRequest.media.hlsVideoSegmentFormat = cast.framework.messages.HlsVideoSegmentFormat.FMP4;
        loadRequest.media.duration = realDuration;
        loadRequest.media.supportedMediaCommands = ALL_COMMANDS;

        if (mediaInfo && mediaInfo.metadata) {
          loadRequest.media.metadata = mediaInfo.metadata;
        }

        loadRequest.autoplay = true;
        loadRequest.currentTime = 0;

        playerManager.load(loadRequest)
          .then(function () {
            console.log(TAG, 'Reload complete after server seek to', targetTime);
            serverSeeking = false;
          })
          .catch(function (err) {
            console.error(TAG, 'Reload failed after server seek:', err);
            serverSeeking = false;
          });
      })
      .catch(function (err) {
        console.error(TAG, 'Server seek fetch failed:', err);
        serverSeeking = false;
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
      console.log(TAG, 'Load complete');

      var mediaInfo = playerManager.getMediaInformation();
      if (mediaInfo) {
        if (realDuration > 0) mediaInfo.duration = realDuration;
        mediaInfo.streamType = cast.framework.messages.StreamType.BUFFERED;
        mediaInfo.supportedMediaCommands = ALL_COMMANDS;
      }

      playerManager.setSupportedMediaCommands(ALL_COMMANDS, true);
      playerManager.broadcastStatus();
      console.log(TAG, 'Status broadcast: seek=ON, duration=' + realDuration);
    }
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.MEDIA_FINISHED,
    function () {
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

  // ── Custom Namespace ───────────────────────────────────────────────────────

  context.addCustomMessageListener(NAMESPACE, function (event) {
    var data = event.data;
    console.log(TAG, 'Custom:', data.type, data);

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

      case 'SEEK_OFFSET':
        break;

      case 'CONFIG':
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
