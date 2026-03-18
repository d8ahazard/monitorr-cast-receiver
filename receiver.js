'use strict';

// ─── Monitorr Cast Receiver v0.3.2 ──────────────────────────────────────────
//
// Uses PlayerManager interceptors (not custom namespace for media).
// The SDK owns the media state machine and UI. We own the player (HLS.js)
// and intercept LOAD/SEEK/PLAY/PAUSE to control it.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.3.3';
  var TAG = '[Monitorr v' + VERSION + ']';
  var MONITORR_NS = 'urn:x-cast:com.monitorr.cast';

  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();

  // ── DOM ────────────────────────────────────────────────────────────────────

  var video = document.getElementById('mr-video');
  var idleScreen = document.getElementById('mr-idle');
  var playerScreen = document.getElementById('mr-player');
  var overlay = document.getElementById('mr-overlay');
  var seekPlayed = document.getElementById('mr-seek-played');
  var seekBuffered = document.getElementById('mr-seek-buffered');
  var timeLeft = document.getElementById('mr-time-left');
  var timeRight = document.getElementById('mr-time-right');
  var metaTitle = document.getElementById('mr-title');
  var metaSubtitle = document.getElementById('mr-subtitle');
  var metaPoster = document.getElementById('mr-poster');
  var spinner = document.getElementById('mr-spinner');
  var btnCC = document.getElementById('mr-btn-cc');
  var btnSkipPrev = document.getElementById('mr-btn-skip-prev');
  var btnSkipNext = document.getElementById('mr-btn-skip-next');
  var ccLabel = document.getElementById('mr-cc-label');

  // Tell the SDK to track our video element for state/status generation
  playerManager.setMediaElement(video);

  // ── State ──────────────────────────────────────────────────────────────────

  var hls = null;
  var realDuration = 0;
  var seekOffset = 0;
  var currentUrl = null;
  var hlsSessionId = null;
  var monitorrOrigin = null;
  var lastMetadata = null;
  var customData = null;
  var serverSeeking = false;
  var overlayTimer = null;
  var isHlsContent = false;

  var subtitleTracks = [];
  var activeSubIndex = -1;

  // ── LOAD Interceptor ───────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.LOAD,
    function (request) {
      var media = request.media;
      if (!media || !media.contentId) return request;

      var url = media.contentId;
      console.log(TAG, 'LOAD:', url, 'duration:', media.duration);

      destroyHls();
      seekOffset = 0;
      serverSeeking = false;
      subtitleTracks = [];
      activeSubIndex = -1;
      currentUrl = url;

      if (media.duration > 0) realDuration = media.duration;
      else realDuration = 0;

      lastMetadata = media.metadata || null;
      customData = (media.customData && typeof media.customData === 'object') ? media.customData : null;

      isHlsContent = url.indexOf('.m3u8') !== -1 ||
        (media.contentType && media.contentType.indexOf('mpegURL') !== -1);

      var match = url.match(/\/hls\/([a-f0-9]+)\//);
      hlsSessionId = match ? match[1] : null;

      try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

      var startTime = request.currentTime || 0;
      if (startTime > 0) seekOffset = startTime;

      // Force BUFFERED + all commands so sender UIs show seek bar
      media.streamType = cast.framework.messages.StreamType.BUFFERED;
      media.supportedMediaCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA |
        cast.framework.messages.Command.STREAM_TRANSFER;

      showPlayer();
      updateMetadata();
      updateSkipButtons();
      showSpinner();

      if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
        // Load with HLS.js. Return the request so the SDK's state machine advances.
        createAndLoadHls(url, function () {
          hideSpinner();
          if (realDuration <= 0) fetchDuration();
          if (hlsSessionId && monitorrOrigin) fetchSubtitleTracks();
          flashOverlay();
        });
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
      video.pause();
      showSpinner();

      var seekUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1);

      fetch(seekUrl, { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (res) {
          console.log(TAG, 'Server seek OK');
          seekOffset = res.offsetSeconds || targetTime;

          var cacheBuster = Date.now().toString(36);
          var reloadUrl = currentUrl.split('?')[0] + '?seek=' + cacheBuster;
          currentUrl = reloadUrl;

          if (hls) { hls.detachMedia(); hls.destroy(); hls = null; }

          var newHls = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
          hls = newHls;
          newHls.loadSource(reloadUrl);
          newHls.once(Hls.Events.MANIFEST_PARSED, function () { newHls.attachMedia(video); });
          newHls.once(Hls.Events.FRAG_BUFFERED, function () {
            video.play().catch(function () {});
            serverSeeking = false;
            hideSpinner();
            playerManager.broadcastStatus();
            flashOverlay();
          });
          newHls.on(Hls.Events.ERROR, function (_, e) {
            if (e.fatal) {
              if (e.type === Hls.ErrorTypes.NETWORK_ERROR) newHls.startLoad();
              else if (e.type === Hls.ErrorTypes.MEDIA_ERROR) newHls.recoverMediaError();
            }
          });

          setTimeout(function () {
            if (serverSeeking) { serverSeeking = false; video.play().catch(function () {}); hideSpinner(); }
          }, 12000);
        })
        .catch(function (err) {
          console.error(TAG, 'Server seek failed:', err);
          serverSeeking = false;
          hideSpinner();
          video.play().catch(function () {});
        });

      return null; // Suppress default seek
    }
  );

  // ── MEDIA_STATUS Interceptor ───────────────────────────────────────────────
  // Patch duration and commands on every outgoing status

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.MEDIA_STATUS,
    function (msg) {
      if (msg.status) {
        for (var i = 0; i < msg.status.length; i++) {
          var s = msg.status[i];
          s.supportedMediaCommands = cast.framework.messages.Command.ALL_BASIC_MEDIA |
            cast.framework.messages.Command.STREAM_TRANSFER;
          // Inject seekOffset into currentTime
          if (!serverSeeking && video && currentUrl) {
            s.currentTime = seekOffset + (video.currentTime || 0);
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
      console.log(TAG, 'Load complete, duration:', realDuration);
      if (realDuration <= 0) fetchDuration();
      var mediaInfo = playerManager.getMediaInformation();
      if (mediaInfo) {
        if (realDuration > 0) mediaInfo.duration = realDuration;
        mediaInfo.streamType = cast.framework.messages.StreamType.BUFFERED;
      }
      playerManager.setSupportedMediaCommands(
        cast.framework.messages.Command.ALL_BASIC_MEDIA | cast.framework.messages.Command.STREAM_TRANSFER, true);
      playerManager.broadcastStatus();
    }
  );

  playerManager.addEventListener(
    cast.framework.events.EventType.MEDIA_FINISHED,
    function () {
      if (serverSeeking) return;
      console.log(TAG, 'Media finished');
      destroyHls();
      showIdle();
    }
  );

  // ── HLS.js ─────────────────────────────────────────────────────────────────

  function createAndLoadHls(url, onReady) {
    destroyHls();
    hls = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      console.log(TAG, 'HLS manifest parsed');
      video.play().catch(function () {});
      if (onReady) { onReady(); onReady = null; }
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
        } else { setTimeout(fetchDuration, 3000); }
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  // ── Subtitles (server-side burn-in) ────────────────────────────────────────

  function fetchSubtitleTracks() {
    if (!hlsSessionId || !monitorrOrigin) return;
    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subtitles')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        subtitleTracks = data.tracks || [];
        activeSubIndex = -1;
        if (data.activeStreamIndex != null) {
          for (var i = 0; i < subtitleTracks.length; i++) {
            if (subtitleTracks[i].streamIndex === data.activeStreamIndex) { activeSubIndex = i; break; }
          }
        }
        console.log(TAG, 'Subs:', subtitleTracks.length, 'active:', activeSubIndex);
        updateCCButton();
      })
      .catch(function () { subtitleTracks = []; updateCCButton(); });
  }

  function cycleSubtitle() {
    if (subtitleTracks.length === 0) return;
    var next = activeSubIndex + 1;
    if (next >= subtitleTracks.length) next = -1;
    toggleSubtitle(next);
  }

  function toggleSubtitle(idx) {
    if (!hlsSessionId || !monitorrOrigin) return;
    showSpinner();
    serverSeeking = true;

    var url = idx < 0
      ? monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/disable'
      : monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/enable?streamIndex=' + subtitleTracks[idx].streamIndex;

    fetch(url, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function () {
        activeSubIndex = idx;
        updateCCButton();
        var cacheBuster = Date.now().toString(36);
        var reloadUrl = currentUrl.split('?')[0] + '?subs=' + cacheBuster;
        currentUrl = reloadUrl;
        destroyHls();
        var newHls = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
        hls = newHls;
        newHls.loadSource(reloadUrl);
        newHls.once(Hls.Events.MANIFEST_PARSED, function () { newHls.attachMedia(video); });
        newHls.once(Hls.Events.FRAG_BUFFERED, function () {
          video.play().catch(function () {});
          serverSeeking = false;
          hideSpinner();
          playerManager.broadcastStatus();
          flashOverlay();
        });
        newHls.on(Hls.Events.ERROR, function (_, e) { if (e.fatal && e.type === Hls.ErrorTypes.NETWORK_ERROR) newHls.startLoad(); });
        setTimeout(function () { if (serverSeeking) { serverSeeking = false; hideSpinner(); } }, 20000);
      })
      .catch(function () { serverSeeking = false; hideSpinner(); });
  }

  function updateCCButton() {
    if (!btnCC) return;
    if (subtitleTracks.length === 0) { btnCC.style.display = 'none'; return; }
    btnCC.style.display = 'flex';
    if (activeSubIndex >= 0 && subtitleTracks[activeSubIndex]) {
      btnCC.classList.add('active');
      if (ccLabel) ccLabel.textContent = subtitleTracks[activeSubIndex].language.toUpperCase();
    } else {
      btnCC.classList.remove('active');
      if (ccLabel) ccLabel.textContent = '';
    }
  }

  // ── Skip ───────────────────────────────────────────────────────────────────

  function updateSkipButtons() {
    var hasPrev = customData && typeof customData.prevEpisodeFileId === 'string' && customData.prevEpisodeFileId.length > 0;
    var hasNext = customData && typeof customData.nextEpisodeFileId === 'string' && customData.nextEpisodeFileId.length > 0;
    if (btnSkipPrev) btnSkipPrev.style.display = hasPrev ? 'flex' : 'none';
    if (btnSkipNext) btnSkipNext.style.display = hasNext ? 'flex' : 'none';
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  if (btnCC) btnCC.addEventListener('click', function () { cycleSubtitle(); });

  video.addEventListener('timeupdate', function () {
    if (serverSeeking) return;
    var total = realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);
    var current = seekOffset + (video.currentTime || 0);
    if (timeLeft) timeLeft.textContent = formatTime(current);
    if (timeRight) timeRight.textContent = formatTime(total);
    if (total > 0 && seekPlayed) seekPlayed.style.width = Math.min(100, (current / total) * 100) + '%';
    if (seekBuffered && total > 0) {
      var be = seekOffset + (isFinite(video.duration) ? video.duration : 0);
      seekBuffered.style.width = Math.min(100, (be / total) * 100) + '%';
    }
  });

  video.addEventListener('ended', function () {
    if (!serverSeeking) { destroyHls(); showIdle(); }
  });

  function updateMetadata() {
    if (!lastMetadata) return;
    if (metaTitle) metaTitle.textContent = lastMetadata.title || '';
    if (metaSubtitle) metaSubtitle.textContent = lastMetadata.subtitle || '';
    if (lastMetadata.images && lastMetadata.images.length > 0 && metaPoster) {
      metaPoster.src = lastMetadata.images[0].url;
      metaPoster.style.display = 'block';
    } else if (metaPoster) { metaPoster.style.display = 'none'; }
  }

  function flashOverlay() {
    if (overlay) overlay.classList.add('visible');
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () { if (overlay) overlay.classList.remove('visible'); }, 6000);
  }

  function showPlayer() { if (idleScreen) idleScreen.style.display = 'none'; if (playerScreen) playerScreen.style.display = 'block'; }
  function showIdle() { if (playerScreen) playerScreen.style.display = 'none'; if (idleScreen) idleScreen.style.display = 'flex'; }
  function showSpinner() { if (spinner) spinner.style.display = 'flex'; }
  function hideSpinner() { if (spinner) spinner.style.display = 'none'; }

  function formatTime(s) {
    if (!s || !isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? h + ':' + (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss : m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  // ── Monitorr Namespace ─────────────────────────────────────────────────────

  context.addCustomMessageListener(MONITORR_NS, function (event) {
    if (event.data.type === 'PING') {
      context.sendCustomMessage(MONITORR_NS, event.senderId, {
        type: 'PONG', version: VERSION,
        currentTime: seekOffset + (video.currentTime || 0), duration: realDuration,
        hlsSessionId: hlsSessionId, playerState: playerManager.getPlayerState()
      });
    }
  });

  // ── Sender events ──────────────────────────────────────────────────────────

  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function (e) {
    console.log(TAG, 'Sender connected:', e.senderId);
  });

  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function (e) {
    console.log(TAG, 'Sender disconnected:', e.senderId);
    if (context.getSenders().length === 0) { destroyHls(); context.stop(); }
  });

  // ── Start ──────────────────────────────────────────────────────────────────

  var playbackConfig = new cast.framework.PlaybackConfig();
  playbackConfig.autoResumeDuration = 5;

  var opts = new cast.framework.CastReceiverOptions();
  opts.playbackConfig = playbackConfig;
  // Don't skip -- let PlayerManager manage the media state machine.
  // HLS.js and the SDK's Shaka both try to load; HLS.js wins because
  // it attaches to the video element first in our LOAD interceptor.
  opts.disableIdleTimeout = true;
  opts.maxInactivity = 3600;
  opts.customNamespaces = {};
  opts.customNamespaces[MONITORR_NS] = cast.framework.system.MessageType.JSON;
  // NOTE: urn:x-cast:com.google.cast.media is NOT registered as custom --
  // the SDK's PlayerManager handles it natively via interceptors.

  context.start(opts);
  console.log(TAG, 'Receiver started');
  showIdle();

})();
