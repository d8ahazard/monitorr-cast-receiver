'use strict';

// ─── Monitorr Cast Receiver v0.0.2 ──────────────────────────────────────────
(function () {

  var VERSION = '0.0.2';
  var NAMESPACE = 'urn:x-cast:com.monitorr.cast';
  var TAG = '[Monitorr v' + VERSION + ']';

  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();

  var CMD = cast.framework.messages.Command;
  var SEEK_COMMANDS = CMD.PAUSE | CMD.SEEK | CMD.STREAM_VOLUME | CMD.STREAM_MUTE | CMD.STREAM_TRANSFER;

  // ── State ──────────────────────────────────────────────────────────────────

  var realDuration = 0;
  var isHlsContent = false;
  var hlsSessionId = null;
  var monitorrOrigin = null;

  // ── Playback Configuration ─────────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;
  playbackConfig.initialBandwidthEstimate = 5000000;

  // ── LOAD Interceptor ───────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      var media = request.media;
      if (!media) return request;

      var url = media.contentId || media.contentUrl || '';
      console.log(TAG, 'LOAD', url, 'duration:', media.duration);

      realDuration = (media.duration > 0) ? media.duration : 0;

      isHlsContent = url.indexOf('.m3u8') !== -1 ||
        media.contentType === 'application/x-mpegURL' ||
        media.contentType === 'application/vnd.apple.mpegurl';

      var match = url.match(/\/hls\/([a-f0-9]+)\//);
      hlsSessionId = match ? match[1] : null;

      try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

      // HLS segment format hints
      if (isHlsContent) {
        media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
        media.hlsVideoSegmentFormat = cast.framework.messages.HlsVideoSegmentFormat.FMP4;
      }

      // Force VOD / seekable treatment regardless of HLS playlist type
      media.streamType = cast.framework.messages.StreamType.BUFFERED;
      media.supportedMediaCommands = SEEK_COMMANDS;

      setIdleVisible(false);
      console.log(TAG, 'LOAD processed: hls=' + isHlsContent + ' duration=' + realDuration + ' session=' + hlsSessionId);

      return request;
    }
  );

  // ── SEEK Interceptor ───────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.SEEK,
    function (request) {
      console.log(TAG, 'SEEK to', request.currentTime, 'hls:', isHlsContent);

      if (isHlsContent && hlsSessionId) {
        broadcastToSenders({
          type: 'SEEK_REQUESTED',
          targetTime: request.currentTime,
          hlsSessionId: hlsSessionId
        });
      }

      return request;
    }
  );

  // ── MEDIA_STATUS Interceptor ───────────────────────────────────────────────
  // Patches every outgoing status to force seek support + correct duration.

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.MEDIA_STATUS,
    function (msg) {
      if (msg.status) {
        for (var i = 0; i < msg.status.length; i++) {
          var s = msg.status[i];
          s.supportedMediaCommands = SEEK_COMMANDS;
          if (s.media) {
            if (realDuration > 0) s.media.duration = realDuration;
            s.media.streamType = cast.framework.messages.StreamType.BUFFERED;
            s.media.supportedMediaCommands = SEEK_COMMANDS;
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
        mediaInfo.supportedMediaCommands = SEEK_COMMANDS;
      }

      // Set at player manager level and force broadcast
      playerManager.setSupportedMediaCommands(SEEK_COMMANDS, true);
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
        console.log(TAG, 'Seek offset:', data.offset);
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

  function broadcastToSenders(data) {
    try {
      var senders = context.getSenders();
      for (var i = 0; i < senders.length; i++) {
        context.sendCustomMessage(NAMESPACE, senders[i].id, data);
      }
    } catch (e) {
      console.warn(TAG, 'Broadcast failed:', e);
    }
  }

  function resetState() {
    realDuration = 0;
    isHlsContent = false;
    hlsSessionId = null;
    monitorrOrigin = null;
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
  opts.supportedCommands = CMD.ALL_BASIC_MEDIA | CMD.STREAM_TRANSFER;
  opts.customNamespaces = {};
  opts.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;

  context.start(opts);
  console.log(TAG, 'Receiver started');
  setIdleVisible(true);

})();
