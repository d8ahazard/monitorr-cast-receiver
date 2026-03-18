'use strict';

// ─── Monitorr Cast Receiver v0.4.0 ──────────────────────────────────────────
//
// Architecture: fully custom. Media namespace as custom namespace, hand-crafted
// MEDIA_STATUS, HLS.js player, no PlayerManager UI. One UI, ours.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.4.0';
  var TAG = '[Monitorr v' + VERSION + ']';
  var MEDIA_NS = 'urn:x-cast:com.google.cast.media';
  var MONITORR_NS = 'urn:x-cast:com.monitorr.cast';

  var context = cast.framework.CastReceiverContext.getInstance();

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

  // ── State ──────────────────────────────────────────────────────────────────

  var hls = null;
  var mediaSessionId = 0;
  var realDuration = 0;
  var seekOffset = 0;
  var currentUrl = null;
  var hlsSessionId = null;
  var monitorrOrigin = null;
  var lastMetadata = null;
  var customData = null;
  var serverSeeking = false;
  var statusTimer = null;
  var overlayTimer = null;
  var isHlsContent = false;
  var subtitleTracks = [];
  var activeSubIndex = -1;

  // ── Media Namespace ────────────────────────────────────────────────────────

  context.addCustomMessageListener(MEDIA_NS, function (event) {
    var data = event.data;
    var sid = event.senderId;
    var rid = data.requestId || 0;

    switch (data.type) {
      case 'LOAD':        handleLoad(data, sid, rid); break;
      case 'PLAY':        video.play().catch(function(){}); send(sid, buildStatus(rid)); break;
      case 'PAUSE':       video.pause(); send(sid, buildStatus(rid)); break;
      case 'STOP':        handleStop(sid, rid); break;
      case 'SEEK':        handleSeek(data, sid, rid); break;
      case 'GET_STATUS':  send(sid, buildStatus(rid)); break;
      case 'SET_VOLUME':
        if (data.volume) {
          if (data.volume.level !== undefined) video.volume = data.volume.level;
          if (data.volume.muted !== undefined) video.muted = data.volume.muted;
        }
        send(sid, buildStatus(rid));
        break;
      default: send(sid, buildStatus(rid));
    }
  });

  // ── LOAD ───────────────────────────────────────────────────────────────────

  function handleLoad(data, sid, rid) {
    var media = data.media;
    if (!media || !media.contentId) return;
    var url = media.contentId;
    console.log(TAG, 'LOAD:', url);

    destroyHls(); stopBroadcaster();
    mediaSessionId++;
    currentUrl = url;
    seekOffset = 0;
    serverSeeking = false;
    subtitleTracks = [];
    activeSubIndex = -1;

    realDuration = (media.duration > 0) ? media.duration : 0;
    lastMetadata = media.metadata || null;
    customData = (media.customData && typeof media.customData === 'object') ? media.customData : null;

    isHlsContent = url.indexOf('.m3u8') !== -1 || (media.contentType && media.contentType.indexOf('mpegURL') !== -1);
    var match = url.match(/\/hls\/([a-f0-9]+)\//);
    hlsSessionId = match ? match[1] : null;
    try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

    var startTime = data.currentTime || 0;
    if (startTime > 0) seekOffset = startTime;

    showPlayer(); updateMetadata(); updateSkipButtons(); showSpinner();

    if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
      loadHls(url, function () {
        hideSpinner();
        if (realDuration <= 0) fetchDuration();
        if (hlsSessionId && monitorrOrigin) fetchSubtitleTracks();
        startBroadcaster();
        send(sid, buildStatus(rid));
        flashOverlay();
      });
    } else {
      video.src = url;
      video.addEventListener('canplay', function f() {
        video.removeEventListener('canplay', f);
        video.play().catch(function(){});
        hideSpinner(); startBroadcaster(); send(sid, buildStatus(rid));
      });
    }
  }

  // ── SEEK ───────────────────────────────────────────────────────────────────

  function handleSeek(data, sid, rid) {
    var t = data.currentTime;
    if (t === undefined) return;

    if (!isHlsContent || !hlsSessionId || !monitorrOrigin) {
      video.currentTime = t;
      send(sid, buildStatus(rid));
      return;
    }

    if (serverSeeking) return;
    serverSeeking = true;
    video.pause();
    showSpinner();

    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + t.toFixed(1), { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (res) {
        seekOffset = res.offsetSeconds || t;
        var reloadUrl = currentUrl.split('?')[0] + '?seek=' + Date.now().toString(36);
        currentUrl = reloadUrl;

        destroyHls();
        var h = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
        hls = h;
        h.loadSource(reloadUrl);
        h.once(Hls.Events.MANIFEST_PARSED, function () { h.attachMedia(video); });
        h.once(Hls.Events.FRAG_BUFFERED, function () {
          video.play().catch(function(){});
          serverSeeking = false;
          hideSpinner();
          broadcast(0);
          flashOverlay();
        });
        h.on(Hls.Events.ERROR, function (_, e) {
          if (e.fatal) { if (e.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad(); else if (e.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError(); }
        });
        setTimeout(function () { if (serverSeeking) { serverSeeking = false; video.play().catch(function(){}); hideSpinner(); } }, 12000);
      })
      .catch(function () { serverSeeking = false; hideSpinner(); video.play().catch(function(){}); });
  }

  // ── STOP ───────────────────────────────────────────────────────────────────

  function handleStop(sid, rid) {
    destroyHls(); stopBroadcaster();
    var s = buildStatus(rid, 'IDLE');
    s.status[0].idleReason = 'CANCELLED';
    send(sid, s);
    showIdle();
  }

  // ── HLS.js ─────────────────────────────────────────────────────────────────

  function loadHls(url, onReady) {
    destroyHls();
    hls = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      video.play().catch(function(){});
      if (onReady) { onReady(); onReady = null; }
    });
    hls.on(Hls.Events.ERROR, function (_, d) {
      if (d.fatal) { if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(); else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError(); }
    });
  }

  function destroyHls() { if (hls) { hls.detachMedia(); hls.destroy(); hls = null; } }

  // ── MEDIA_STATUS ───────────────────────────────────────────────────────────

  function buildStatus(rid, stateOverride) {
    var state = stateOverride || getState();
    var s = { type: 'MEDIA_STATUS', requestId: rid || 0, status: [{
      mediaSessionId: mediaSessionId, playbackRate: 1, playerState: state,
      currentTime: seekOffset + (video.currentTime || 0),
      supportedMediaCommands: 0x3FFFF,
      volume: { level: video.volume, muted: video.muted },
      media: currentUrl ? {
        contentId: currentUrl, streamType: 'BUFFERED',
        contentType: isHlsContent ? 'application/x-mpegURL' : 'video/mp4',
        duration: realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0),
        metadata: lastMetadata
      } : null
    }]};
    return s;
  }

  function getState() {
    if (!currentUrl) return 'IDLE';
    if (serverSeeking || video.seeking || video.readyState < 3) return 'BUFFERING';
    if (video.paused || video.ended) return 'PAUSED';
    return 'PLAYING';
  }

  function send(sid, msg) { try { context.sendCustomMessage(MEDIA_NS, sid, msg); } catch(e){} }
  function broadcast(rid) {
    var s = buildStatus(rid || 0);
    context.getSenders().forEach(function(sender) { send(sender.id, s); });
  }

  function startBroadcaster() { stopBroadcaster(); statusTimer = setInterval(function () { if (!serverSeeking) broadcast(0); }, 2000); }
  function stopBroadcaster() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

  // ── Duration ───────────────────────────────────────────────────────────────

  function fetchDuration() {
    if (!hlsSessionId || !monitorrOrigin) return;
    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/info')
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.durationSeconds > 0) {
          realDuration = info.durationSeconds;
          if (info.startOffsetSeconds > 0 && seekOffset === 0) seekOffset = info.startOffsetSeconds;
          broadcast(0);
        } else setTimeout(fetchDuration, 3000);
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  // ── Subtitles ──────────────────────────────────────────────────────────────

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
        updateCCButton();
      })
      .catch(function () { subtitleTracks = []; updateCCButton(); });
  }

  function cycleSubtitle() {
    if (!subtitleTracks.length) return;
    toggleSubtitle(activeSubIndex + 1 >= subtitleTracks.length ? -1 : activeSubIndex + 1);
  }

  function toggleSubtitle(idx) {
    if (!hlsSessionId || !monitorrOrigin) return;
    showSpinner(); serverSeeking = true;
    var url = idx < 0
      ? monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/disable'
      : monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/enable?streamIndex=' + subtitleTracks[idx].streamIndex;
    fetch(url, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function () {
        activeSubIndex = idx; updateCCButton();
        var reloadUrl = currentUrl.split('?')[0] + '?subs=' + Date.now().toString(36);
        currentUrl = reloadUrl;
        destroyHls();
        var h = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
        hls = h;
        h.loadSource(reloadUrl);
        h.once(Hls.Events.MANIFEST_PARSED, function () { h.attachMedia(video); });
        h.once(Hls.Events.FRAG_BUFFERED, function () {
          video.play().catch(function(){}); serverSeeking = false; hideSpinner(); broadcast(0); flashOverlay();
        });
        h.on(Hls.Events.ERROR, function (_, e) { if (e.fatal && e.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad(); });
        setTimeout(function () { if (serverSeeking) { serverSeeking = false; hideSpinner(); } }, 20000);
      })
      .catch(function () { serverSeeking = false; hideSpinner(); });
  }

  function updateCCButton() {
    if (!btnCC) return;
    if (!subtitleTracks.length) { btnCC.style.display = 'none'; return; }
    btnCC.style.display = 'flex';
    if (activeSubIndex >= 0 && subtitleTracks[activeSubIndex]) {
      btnCC.classList.add('active');
      if (ccLabel) ccLabel.textContent = subtitleTracks[activeSubIndex].language.toUpperCase();
    } else { btnCC.classList.remove('active'); if (ccLabel) ccLabel.textContent = ''; }
  }

  // ── Skip ───────────────────────────────────────────────────────────────────

  function updateSkipButtons() {
    var hasPrev = customData && typeof customData.prevEpisodeFileId === 'string' && customData.prevEpisodeFileId.length > 0;
    var hasNext = customData && typeof customData.nextEpisodeFileId === 'string' && customData.nextEpisodeFileId.length > 0;
    if (btnSkipPrev) btnSkipPrev.style.display = hasPrev ? 'flex' : 'none';
    if (btnSkipNext) btnSkipNext.style.display = hasNext ? 'flex' : 'none';
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  if (btnCC) btnCC.addEventListener('click', cycleSubtitle);

  video.addEventListener('timeupdate', function () {
    if (serverSeeking) return;
    var total = realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);
    var cur = seekOffset + (video.currentTime || 0);
    if (timeLeft) timeLeft.textContent = fmt(cur);
    if (timeRight) timeRight.textContent = fmt(total);
    if (total > 0 && seekPlayed) seekPlayed.style.width = Math.min(100, cur / total * 100) + '%';
    if (seekBuffered && total > 0) seekBuffered.style.width = Math.min(100, (seekOffset + (isFinite(video.duration) ? video.duration : 0)) / total * 100) + '%';
  });

  video.addEventListener('ended', function () { if (!serverSeeking) { destroyHls(); stopBroadcaster(); showIdle(); } });

  function updateMetadata() {
    if (!lastMetadata) return;
    if (metaTitle) metaTitle.textContent = lastMetadata.title || '';
    if (metaSubtitle) metaSubtitle.textContent = lastMetadata.subtitle || '';
    if (lastMetadata.images && lastMetadata.images.length > 0 && metaPoster) { metaPoster.src = lastMetadata.images[0].url; metaPoster.style.display = 'block'; }
    else if (metaPoster) metaPoster.style.display = 'none';
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
  function fmt(s) { if (!s || !isFinite(s)) return '0:00'; s = Math.max(0, Math.floor(s)); var h = Math.floor(s/3600), m = Math.floor(s%3600/60), ss = s%60; return h > 0 ? h+':'+(m<10?'0':'')+m+':'+(ss<10?'0':'')+ss : m+':'+(ss<10?'0':'')+ss; }

  // ── Monitorr Namespace ─────────────────────────────────────────────────────

  context.addCustomMessageListener(MONITORR_NS, function (e) {
    if (e.data.type === 'PING') context.sendCustomMessage(MONITORR_NS, e.senderId, {
      type: 'PONG', version: VERSION, currentTime: seekOffset + (video.currentTime||0),
      duration: realDuration, hlsSessionId: hlsSessionId, playerState: getState()
    });
  });

  // ── Sender events ──────────────────────────────────────────────────────────

  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function (e) {
    if (currentUrl) send(e.senderId, buildStatus(0));
  });
  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function () {
    if (context.getSenders().length === 0) { destroyHls(); stopBroadcaster(); context.stop(); }
  });

  // ── Start ──────────────────────────────────────────────────────────────────

  var opts = new cast.framework.CastReceiverOptions();
  opts.skipPlayersLoad = true;
  opts.disableIdleTimeout = true;
  opts.maxInactivity = 3600;
  opts.customNamespaces = {};
  opts.customNamespaces[MEDIA_NS] = cast.framework.system.MessageType.JSON;
  opts.customNamespaces[MONITORR_NS] = cast.framework.system.MessageType.JSON;

  context.start(opts);
  console.log(TAG, 'Receiver started');
  showIdle();

})();
