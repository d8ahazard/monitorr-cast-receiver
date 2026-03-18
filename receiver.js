'use strict';

(function () {

  var TAG = '[Monitorr v2.0.0]';
  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();
  var idleScreen = document.getElementById('mr-idle');

  var realDuration = 0;
  var seekOffset = 0;
  var hlsSessionId = null;
  var monitorrOrigin = null;
  var currentUrl = null;
  var isHlsContent = false;
  var serverSeeking = false;
  var subtitleTracks = [];
  var lastMetadata = null;
  var lastContentType = null;
  var isInternalReload = false;

  // ── Controls API ───────────────────────────────────────────────────────────

  var controls = cast.framework.ui.Controls.getInstance();
  controls.clearDefaultSlotAssignments();
  controls.assignButton(
    cast.framework.ui.ControlsSlot.SLOT_SECONDARY_1,
    cast.framework.ui.ControlsButton.CAPTIONS
  );
  controls.assignButton(
    cast.framework.ui.ControlsSlot.SLOT_PRIMARY_1,
    cast.framework.ui.ControlsButton.SEEK_BACKWARD_30
  );
  controls.assignButton(
    cast.framework.ui.ControlsSlot.SLOT_PRIMARY_2,
    cast.framework.ui.ControlsButton.SEEK_FORWARD_30
  );
  controls.assignButton(
    cast.framework.ui.ControlsSlot.SLOT_SECONDARY_2,
    cast.framework.ui.ControlsButton.QUEUE_NEXT
  );

  // ── LOAD ───────────────────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      var media = request.media;
      if (!media) return request;

      var url = media.contentId || '';
      console.log(TAG, 'LOAD', url, 'internal:', isInternalReload);

      if (!isInternalReload) {
        // Fresh load from sender -- reset everything
        seekOffset = 0;
        serverSeeking = false;
        currentUrl = url;
        subtitleTracks = [];

        realDuration = (media.duration > 0) ? media.duration : 0;
        lastMetadata = media.metadata || null;
        lastContentType = media.contentType || 'application/x-mpegURL';

        isHlsContent = url.indexOf('.m3u8') !== -1 ||
          (media.contentType && media.contentType.indexOf('mpegURL') !== -1);

        var match = url.match(/\/hls\/([a-f0-9]+)\//);
        hlsSessionId = match ? match[1] : null;
        try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

        if (request.currentTime > 0) seekOffset = request.currentTime;
      }
      // Internal reload: keep seekOffset, hlsSessionId, etc.

      // Force VOD semantics
      media.streamType = cast.framework.messages.StreamType.BUFFERED;

      // HLS segment format hints for Shaka
      if (isHlsContent) {
        media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
        media.hlsVideoSegmentFormat = cast.framework.messages.HlsVideoSegmentFormat.FMP4;
      }

      // Commands
      var cmds = cast.framework.messages.Command.ALL_BASIC_MEDIA |
        cast.framework.messages.Command.STREAM_TRANSFER;
      var cd = media.customData;
      if (cd && (cd.nextEpisodeFileId || cd.prevEpisodeFileId)) {
        cmds |= cast.framework.messages.Command.QUEUE_NEXT |
                cast.framework.messages.Command.QUEUE_PREV;
      }
      media.supportedMediaCommands = cmds;

      // Hide idle screen on load
      if (idleScreen) idleScreen.classList.add('hidden');

      // Fetch real duration + subtitle tracks async (only on fresh load)
      if (!isInternalReload && hlsSessionId && monitorrOrigin) {
        if (realDuration <= 0) fetchDuration();
      }

      isInternalReload = false;
      return request;
    }
  );

  // ── SEEK ───────────────────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.SEEK,
    function (request) {
      var targetTime = request.currentTime;
      console.log(TAG, 'SEEK to', targetTime);

      if (!isHlsContent || !hlsSessionId || !monitorrOrigin) return request;
      if (serverSeeking) return null;

      serverSeeking = true;

      fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1), { method: 'POST' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (res) {
          console.log(TAG, 'Server seek OK');
          seekOffset = res.offsetSeconds || targetTime;

          var cacheBuster = Date.now().toString(36);
          var reloadUrl = currentUrl.split('?')[0] + '?seek=' + cacheBuster;
          currentUrl = reloadUrl;

          return reloadPlayer(reloadUrl);
        })
        .then(function () {
          serverSeeking = false;
          playerManager.broadcastStatus();
        })
        .catch(function (err) {
          console.error(TAG, 'Seek failed:', err);
          serverSeeking = false;
        });

      return null;
    }
  );

  // ── EDIT_TRACKS_INFO (CC button) ───────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.EDIT_TRACKS_INFO,
    function (request) {
      var activeIds = request.activeTrackIds || [];
      console.log(TAG, 'EDIT_TRACKS', JSON.stringify(activeIds));

      if (!hlsSessionId || !monitorrOrigin) return request;

      if (activeIds.length === 0) {
        serverSeeking = true;
        fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/disable', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function () { return reloadPlayer(currentUrl.split('?')[0] + '?nosubs=' + Date.now().toString(36)); })
          .then(function () { serverSeeking = false; })
          .catch(function () { serverSeeking = false; });
      } else {
        var trackId = activeIds[0];
        for (var i = 0; i < subtitleTracks.length; i++) {
          if (subtitleTracks[i].trackId === trackId) {
            var si = subtitleTracks[i].streamIndex;
            serverSeeking = true;
            fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/enable?streamIndex=' + si, { method: 'POST' })
              .then(function (r) { return r.json(); })
              .then(function () { return reloadPlayer(currentUrl.split('?')[0] + '?subs=' + Date.now().toString(36)); })
              .then(function () { serverSeeking = false; })
              .catch(function () { serverSeeking = false; });
            break;
          }
        }
      }

      return request;
    }
  );

  // ── MEDIA_STATUS ───────────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.MEDIA_STATUS,
    function (msg) {
      if (msg.status) {
        for (var i = 0; i < msg.status.length; i++) {
          var s = msg.status[i];
          if (!serverSeeking && seekOffset > 0) {
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

  // ── Events ─────────────────────────────────────────────────────────────────

  playerManager.addEventListener(
    cast.framework.events.EventType.PLAYER_LOAD_COMPLETE,
    function () {
      console.log(TAG, 'Load complete, seekOffset:', seekOffset, 'duration:', realDuration);

      if (realDuration <= 0) fetchDuration();

      var mi = playerManager.getMediaInformation();
      if (mi) {
        if (realDuration > 0) mi.duration = realDuration;
        mi.streamType = cast.framework.messages.StreamType.BUFFERED;
      }

      // Expose subtitle tracks after media is loaded (mi is guaranteed non-null here)
      if (hlsSessionId && monitorrOrigin && subtitleTracks.length === 0) {
        fetchAndExposeSubtitleTracks();
      }

      playerManager.broadcastStatus();
    }
  );

  // ── Reload Player ──────────────────────────────────────────────────────────

  function reloadPlayer(url) {
    currentUrl = url;
    isInternalReload = true;
    var loadReq = new cast.framework.messages.LoadRequestData();
    loadReq.media = new cast.framework.messages.MediaInformation();
    loadReq.media.contentId = url;
    loadReq.media.contentType = lastContentType || 'application/x-mpegURL';
    loadReq.media.streamType = cast.framework.messages.StreamType.BUFFERED;
    loadReq.media.hlsSegmentFormat = cast.framework.messages.HlsSegmentFormat.FMP4;
    loadReq.media.hlsVideoSegmentFormat = cast.framework.messages.HlsVideoSegmentFormat.FMP4;
    if (realDuration > 0) loadReq.media.duration = realDuration;
    if (lastMetadata) loadReq.media.metadata = lastMetadata;
    loadReq.autoplay = true;
    loadReq.currentTime = 0;
    return playerManager.load(loadReq);
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
        } else {
          setTimeout(fetchDuration, 3000);
        }
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  // ── Subtitles ──────────────────────────────────────────────────────────────

  function fetchAndExposeSubtitleTracks() {
    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subtitles')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var tracks = data.tracks || [];
        if (tracks.length === 0) return;

        subtitleTracks = [];
        var castTracks = [];

        for (var i = 0; i < tracks.length; i++) {
          var t = tracks[i];
          var trackId = i + 1;
          subtitleTracks.push({
            trackId: trackId,
            streamIndex: t.streamIndex,
            language: t.language
          });
          var ct = new cast.framework.messages.Track();
          ct.trackId = trackId;
          ct.type = cast.framework.messages.TrackType.TEXT;
          ct.subtype = cast.framework.messages.TextTrackType.SUBTITLES;
          ct.name = t.title || t.language;
          ct.language = t.language;
          castTracks.push(ct);
        }

        var mi = playerManager.getMediaInformation();
        if (mi) {
          mi.tracks = castTracks;
          playerManager.broadcastStatus();
          console.log(TAG, 'Exposed', castTracks.length, 'subtitle tracks');
        }
      })
      .catch(function (err) {
        console.error(TAG, 'Subtitle fetch failed:', err);
      });
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;
  playbackConfig.initialBandwidthEstimate = 5000000;

  var opts = new cast.framework.CastReceiverOptions();
  opts.playbackConfig = playbackConfig;
  opts.disableIdleTimeout = true;
  opts.maxInactivity = 3600;

  playerManager.addEventListener(
    cast.framework.events.EventType.MEDIA_FINISHED,
    function () {
      if (idleScreen) idleScreen.classList.remove('hidden');
    }
  );

  context.start(opts);
  console.log(TAG, 'Receiver started');

})();
