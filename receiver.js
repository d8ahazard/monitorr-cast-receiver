'use strict';

// ─── Monitorr Cast Receiver v0.5.2 ──────────────────────────────────────────
//
// cast-media-player for UI + Controls API for CC/skip buttons.
// HLS.js for playback. Server-side seeking.
// Subtitle tracks exposed to SDK so CC button auto-appears.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var TAG = '[Monitorr]';
  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();
  var video = document.getElementById('mr-video');

  playerManager.setMediaElement(video);

  var hls = null;
  var realDuration = 0;
  var seekOffset = 0;
  var hlsSessionId = null;
  var monitorrOrigin = null;
  var currentUrl = null;
  var isHlsContent = false;
  var serverSeeking = false;
  var subtitleTracks = [];

  // ── Controls Layout ────────────────────────────────────────────────────────

  var controls = cast.framework.ui.Controls.getInstance();
  controls.clearDefaultSlotAssignments();
  controls.assignButton(cast.framework.ui.ControlsSlot.SLOT_SECONDARY_1, cast.framework.ui.ControlsButton.CAPTIONS);
  controls.assignButton(cast.framework.ui.ControlsSlot.SLOT_PRIMARY_1, cast.framework.ui.ControlsButton.SEEK_BACKWARD_30);
  controls.assignButton(cast.framework.ui.ControlsSlot.SLOT_PRIMARY_2, cast.framework.ui.ControlsButton.SEEK_FORWARD_30);
  controls.assignButton(cast.framework.ui.ControlsSlot.SLOT_SECONDARY_2, cast.framework.ui.ControlsButton.QUEUE_NEXT);

  // ── LOAD ───────────────────────────────────────────────────────────────────

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
      subtitleTracks = [];

      if (media.duration > 0) realDuration = media.duration;
      else realDuration = 0;

      isHlsContent = url.indexOf('.m3u8') !== -1 ||
        (media.contentType && media.contentType.indexOf('mpegURL') !== -1);

      var match = url.match(/\/hls\/([a-f0-9]+)\//);
      hlsSessionId = match ? match[1] : null;
      try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

      if (request.currentTime > 0) seekOffset = request.currentTime;

      media.streamType = cast.framework.messages.StreamType.BUFFERED;

      // Configure supported commands based on content
      var cmds = cast.framework.messages.Command.ALL_BASIC_MEDIA |
        cast.framework.messages.Command.STREAM_TRANSFER;

      // Check for episode context (skip buttons)
      var cd = media.customData;
      if (cd && (cd.nextEpisodeFileId || cd.prevEpisodeFileId)) {
        cmds |= cast.framework.messages.Command.QUEUE_NEXT | cast.framework.messages.Command.QUEUE_PREV;
      }

      media.supportedMediaCommands = cmds;

      // Load with HLS.js
      if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
        loadHls(url);
        if (realDuration <= 0) fetchDuration();
        if (hlsSessionId && monitorrOrigin) fetchAndExposeSubtitleTracks(media);
      }

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
      video.pause();

      fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1), { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (res) {
          seekOffset = res.offsetSeconds || targetTime;
          var reloadUrl = currentUrl.split('?')[0] + '?seek=' + Date.now().toString(36);
          currentUrl = reloadUrl;

          destroyHls();
          var h = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
          hls = h;
          h.loadSource(reloadUrl);
          h.once(Hls.Events.MANIFEST_PARSED, function () { h.attachMedia(video); });
          h.once(Hls.Events.FRAG_BUFFERED, function () {
            video.play().catch(function () {});
            serverSeeking = false;
            playerManager.broadcastStatus();
          });
          h.on(Hls.Events.ERROR, function (_, e) {
            if (e.fatal) {
              if (e.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad();
              else if (e.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
            }
          });
          setTimeout(function () { if (serverSeeking) { serverSeeking = false; video.play().catch(function () {}); } }, 12000);
        })
        .catch(function () { serverSeeking = false; video.play().catch(function () {}); });

      return null;
    }
  );

  // ── EDIT_TRACKS (CC toggle from the platform's CC button) ──────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.EDIT_TRACKS_INFO,
    function (request) {
      console.log(TAG, 'EDIT_TRACKS', JSON.stringify(request));

      var activeIds = request.activeTrackIds || [];

      if (activeIds.length === 0 && subtitleTracks.length > 0) {
        // User turned OFF subs
        disableSubtitle();
      } else if (activeIds.length > 0) {
        // User selected a track -- find the matching subtitle
        var trackId = activeIds[0];
        for (var i = 0; i < subtitleTracks.length; i++) {
          if (subtitleTracks[i].trackId === trackId) {
            enableSubtitle(subtitleTracks[i].streamIndex);
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
          if (!serverSeeking) s.currentTime = seekOffset + (s.currentTime || 0);
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

  playerManager.addEventListener(cast.framework.events.EventType.PLAYER_LOAD_COMPLETE, function () {
    console.log(TAG, 'Load complete');
    if (realDuration <= 0) fetchDuration();
    var mi = playerManager.getMediaInformation();
    if (mi) {
      if (realDuration > 0) mi.duration = realDuration;
      mi.streamType = cast.framework.messages.StreamType.BUFFERED;
    }
    playerManager.broadcastStatus();
  });

  // ── HLS.js ─────────────────────────────────────────────────────────────────

  function loadHls(url) {
    destroyHls();
    hls = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      console.log(TAG, 'HLS manifest parsed');
      video.play().catch(function () {});
    });
    hls.on(Hls.Events.ERROR, function (_, d) {
      if (d.fatal) {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
  }

  function destroyHls() { if (hls) { hls.detachMedia(); hls.destroy(); hls = null; } }

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

  // ── Subtitles ──────────────────────────────────────────────────────────────
  // Fetch tracks from server, expose them as Cast SDK Track objects so the
  // platform's built-in CC button auto-appears.

  function fetchAndExposeSubtitleTracks(media) {
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
            language: t.language,
            title: t.title
          });
          // Create a Cast SDK Track object
          var castTrack = new cast.framework.messages.Track();
          castTrack.trackId = trackId;
          castTrack.type = cast.framework.messages.TrackType.TEXT;
          castTrack.subtype = cast.framework.messages.TextTrackType.SUBTITLES;
          castTrack.name = t.title || t.language;
          castTrack.language = t.language;
          castTracks.push(castTrack);
        }

        // Attach tracks to media info so cast-media-player shows CC button
        var mi = playerManager.getMediaInformation();
        if (mi) {
          mi.tracks = castTracks;
          playerManager.broadcastStatus();
        }

        console.log(TAG, 'Exposed', castTracks.length, 'subtitle tracks to SDK');
      })
      .catch(function () {});
  }

  function enableSubtitle(streamIndex) {
    if (!hlsSessionId || !monitorrOrigin) return;
    serverSeeking = true;
    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/enable?streamIndex=' + streamIndex, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function () {
        var reloadUrl = currentUrl.split('?')[0] + '?subs=' + Date.now().toString(36);
        currentUrl = reloadUrl;
        destroyHls();
        var h = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
        hls = h;
        h.loadSource(reloadUrl);
        h.once(Hls.Events.MANIFEST_PARSED, function () { h.attachMedia(video); });
        h.once(Hls.Events.FRAG_BUFFERED, function () {
          video.play().catch(function () {});
          serverSeeking = false;
          playerManager.broadcastStatus();
        });
        h.on(Hls.Events.ERROR, function (_, e) { if (e.fatal && e.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad(); });
        setTimeout(function () { if (serverSeeking) { serverSeeking = false; } }, 20000);
      })
      .catch(function () { serverSeeking = false; });
  }

  function disableSubtitle() {
    if (!hlsSessionId || !monitorrOrigin) return;
    serverSeeking = true;
    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/disable', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function () {
        var reloadUrl = currentUrl.split('?')[0] + '?nosubs=' + Date.now().toString(36);
        currentUrl = reloadUrl;
        destroyHls();
        var h = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
        hls = h;
        h.loadSource(reloadUrl);
        h.once(Hls.Events.MANIFEST_PARSED, function () { h.attachMedia(video); });
        h.once(Hls.Events.FRAG_BUFFERED, function () {
          video.play().catch(function () {});
          serverSeeking = false;
          playerManager.broadcastStatus();
        });
        h.on(Hls.Events.ERROR, function (_, e) { if (e.fatal && e.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad(); });
        setTimeout(function () { if (serverSeeking) { serverSeeking = false; } }, 20000);
      })
      .catch(function () { serverSeeking = false; });
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  var opts = new cast.framework.CastReceiverOptions();
  opts.playbackConfig = new cast.framework.PlaybackConfig();
  opts.playbackConfig.autoResumeDuration = 5;
  opts.playbackConfig.initialBandwidthEstimate = 5000000;
  opts.skipPlayersLoad = true;
  opts.disableIdleTimeout = true;
  opts.maxInactivity = 3600;

  context.start(opts);
  console.log(TAG, 'Receiver v0.5.2 started');

})();
