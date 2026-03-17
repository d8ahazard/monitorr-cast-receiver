'use strict';

// ─── Monitorr Cast Receiver ──────────────────────────────────────────────────
//
// Custom Web Receiver for Google Cast that integrates with Monitorr's
// server-side transcoding and HLS streaming pipeline.
//
// Key behaviors:
//   - Accepts LOAD from Monitorr sender for both DirectPlay (MP4) and HLS
//   - Overrides HLS manifest duration with the real movie duration from metadata
//   - Reports accurate duration/position in MEDIA_STATUS so sender seek bars work
//   - Provides urn:x-cast:com.monitorr.cast namespace for sender coordination
//   - Forwards remote-initiated SEEK events to the sender for server-side handling
//
// Host this on GitHub Pages and register the URL in the Cast SDK Developer
// Console to get your application ID. Then set that ID in Monitorr's config.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var NAMESPACE = 'urn:x-cast:com.monitorr.cast';
  var TAG = '[Monitorr]';

  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();

  // ── State ────────────────────────────────────────────────────────────────

  var realDuration = 0;
  var isHlsContent = false;
  var hlsSessionId = null;
  var monitorrOrigin = null;

  // ── Playback Configuration ───────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;
  playbackConfig.initialBandwidthEstimate = 5000000;

  // ── LOAD Interceptor ─────────────────────────────────────────────────────
  // The Monitorr sender builds LOAD messages with:
  //   contentId:    stream URL (direct MP4 or HLS master.m3u8)
  //   contentType:  "video/mp4" or "application/x-mpegURL"
  //   duration:     real movie duration in seconds (authoritative)
  //   streamType:   "BUFFERED"
  //   metadata:     { metadataType: 1, title, images }
  //   hlsSegmentFormat / hlsVideoSegmentFormat: "fmp4" for HLS

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      var media = request.media;
      if (!media) return request;

      var url = media.contentId || media.contentUrl || '';
      console.log(TAG, 'LOAD', url);

      // Store authoritative duration (HLS manifest only knows transcoded-so-far)
      realDuration = (media.duration > 0) ? media.duration : 0;

      // Detect content type
      isHlsContent = url.indexOf('.m3u8') !== -1 ||
        media.contentType === 'application/x-mpegURL' ||
        media.contentType === 'application/vnd.apple.mpegurl';

      // Extract HLS session ID from URL pattern /hls/{sessionId}/
      var match = url.match(/\/hls\/([a-f0-9]+)\//);
      hlsSessionId = match ? match[1] : null;

      // Remember server origin for API calls
      try {
        var parsed = new URL(url);
        monitorrOrigin = parsed.origin;
      } catch (e) { monitorrOrigin = null; }

      if (isHlsContent) {
        // Normalize segment format enums (sender sends raw "fmp4" strings)
        media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
        media.hlsVideoSegmentFormat = cast.framework.messages.HlsVideoSegmentFormat.FMP4;
        media.streamType = cast.framework.messages.StreamType.BUFFERED;
      }

      // Hide idle screen, show watermark
      setIdleVisible(false);

      return request;
    }
  );

  // ── SEEK Interceptor ─────────────────────────────────────────────────────
  // For HLS content, the receiver can only seek within available segments.
  // We notify the Monitorr sender so it can trigger a server-side transcode
  // restart and send a fresh LOAD if the target is beyond the frontier.

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

  // ── MEDIA_STATUS Interceptor ─────────────────────────────────────────────
  // Override the duration in every status broadcast so sender UIs always
  // show the full movie length, not the partial HLS manifest duration.

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.MEDIA_STATUS,
    function (statusMessage) {
      if (realDuration > 0 && statusMessage.status) {
        for (var i = 0; i < statusMessage.status.length; i++) {
          var s = statusMessage.status[i];
          if (s.media) {
            s.media.duration = realDuration;
          }
        }
      }
      return statusMessage;
    }
  );

  // ── Player Events ────────────────────────────────────────────────────────

  playerManager.addEventListener(
    cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
    function () {
      console.log(TAG, 'Load complete, duration:', realDuration);

      // Patch media information with real duration and re-broadcast
      if (realDuration > 0) {
        var mediaInfo = playerManager.getMediaInformation();
        if (mediaInfo) {
          mediaInfo.duration = realDuration;
          playerManager.broadcastStatus();
        }
      }
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

  // ── Custom Namespace ─────────────────────────────────────────────────────
  // urn:x-cast:com.monitorr.cast protocol:
  //
  //   Sender → Receiver:
  //     SEEK_OFFSET  { offset: <seconds> }   After server-side seek, tells
  //                                           receiver about the new offset.
  //     PING         {}                       Health check.
  //     CONFIG       { ... }                  Optional configuration.
  //
  //   Receiver → Sender:
  //     PONG           { currentTime, duration, hlsSessionId, playerState }
  //     SEEK_REQUESTED { targetTime, hlsSessionId }  A remote-initiated seek
  //                                                   that needs server-side
  //                                                   transcode restart.
  //     STATUS         { currentTime, duration, playerState }

  context.addCustomMessageListener(NAMESPACE, function (event) {
    var data = event.data;
    console.log(TAG, 'Custom:', data.type, data);

    switch (data.type) {
      case 'PING':
        context.sendCustomMessage(NAMESPACE, event.senderId, {
          type: 'PONG',
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

  // ── Sender connect/disconnect ────────────────────────────────────────────

  context.addEventListener(
    cast.framework.system.EventType.SENDER_CONNECTED,
    function (event) {
      console.log(TAG, 'Sender connected:', event.senderId);
    }
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

  // ── Helpers ──────────────────────────────────────────────────────────────

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
    if (wm) wm.style.display = visible ? 'none' : 'block';
  }

  // ── Start ────────────────────────────────────────────────────────────────

  var opts = new cast.framework.CastReceiverOptions();
  opts.playbackConfig = playbackConfig;
  opts.maxInactivity = 3600;
  opts.supportedCommands =
    cast.framework.messages.Command.ALL_BASIC_MEDIA |
    cast.framework.messages.Command.STREAM_TRANSFER;
  opts.customNamespaces = {};
  opts.customNamespaces[NAMESPACE] = cast.framework.system.MessageType.JSON;

  context.start(opts);
  console.log(TAG, 'Receiver started');
  setIdleVisible(true);

})();
