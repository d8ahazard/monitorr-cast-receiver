'use strict';

// ─── Monitorr Cast Receiver v0.5.2 ──────────────────────────────────────────
//
// Fully custom receiver. Custom namespace only (no media namespace).
// D-pad state machine: menu hidden = seek, menu visible = navigate buttons.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.5.2';
  var TAG = '[Monitorr v' + VERSION + ']';
  var NS = 'urn:x-cast:com.monitorr.cast';

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
  var btnPlay = document.getElementById('mr-btn-play');
  var playIcon = document.getElementById('mr-play-icon');
  var ccLabel = document.getElementById('mr-cc-label');
  var controlsEl = document.getElementById('mr-controls');

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
  var statusTimer = null;
  var menuTimer = null;
  var isHlsContent = false;
  var subtitleTracks = [];
  var activeSubIndex = -1;

  // ── Menu / Focus State ─────────────────────────────────────────────────────

  var menuVisible = false;
  var focusIndex = -1;

  function getVisibleButtons() {
    if (!controlsEl) return [];
    var btns = controlsEl.querySelectorAll('.mr-btn');
    var visible = [];
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].style.display !== 'none') visible.push(btns[i]);
    }
    return visible;
  }

  function setFocus(idx) {
    var btns = getVisibleButtons();
    // Clear all
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('focused');
    if (idx >= 0 && idx < btns.length) {
      focusIndex = idx;
      btns[idx].classList.add('focused');
    } else {
      focusIndex = -1;
    }
  }

  function showMenu() {
    if (!currentUrl) return;
    menuVisible = true;
    overlay.classList.add('visible');
    // Focus play/pause by default
    var btns = getVisibleButtons();
    var playIdx = 0;
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].dataset.action === 'play-pause') { playIdx = i; break; }
    }
    setFocus(playIdx);
    resetMenuTimer();
  }

  function hideMenu() {
    menuVisible = false;
    overlay.classList.remove('visible');
    setFocus(-1);
    clearTimeout(menuTimer);
  }

  function resetMenuTimer() {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(hideMenu, 6000);
  }

  function activateFocused() {
    var btns = getVisibleButtons();
    if (focusIndex < 0 || focusIndex >= btns.length) return;
    var action = btns[focusIndex].dataset.action;
    resetMenuTimer();

    switch (action) {
      case 'play-pause':
        if (video.paused) video.play().catch(function(){}); else video.pause();
        updatePlayIcon();
        broadcast();
        break;
      case 'seek-back':
        hideMenu();
        tapSeek(-1);
        break;
      case 'seek-forward':
        hideMenu();
        tapSeek(1);
        break;
      case 'cc':
        cycleSubtitle();
        break;
      case 'skip-prev':
      case 'skip-next':
        // TODO: send skip message to sender
        break;
    }
  }

  // ── D-pad Seeking (menu hidden) ────────────────────────────────────────────

  var scrubState = null;

  function getScrubStep(holdMs) {
    if (holdMs < 1000) return 5;
    if (holdMs < 3000) return 10;
    if (holdMs < 6000) return 30;
    return 60;
  }

  function startScrub(direction) {
    if (serverSeeking || !currentUrl) return;
    var now = seekOffset + (video.currentTime || 0);
    var total = realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);
    scrubState = { direction: direction, startTime: now, scrubTime: now, holdStart: Date.now(), total: total };
    // Show overlay during scrub for visual feedback
    overlay.classList.add('visible');
    tickScrub();
    scrubState.interval = setInterval(tickScrub, 200);
  }

  function tickScrub() {
    if (!scrubState) return;
    var holdMs = Date.now() - scrubState.holdStart;
    var step = getScrubStep(holdMs);
    scrubState.scrubTime += scrubState.direction * step * 0.2;
    scrubState.scrubTime = Math.max(0, Math.min(scrubState.total || 999999, scrubState.scrubTime));
    if (timeLeft) timeLeft.textContent = fmt(scrubState.scrubTime);
    if (scrubState.total > 0 && seekPlayed) {
      seekPlayed.style.width = Math.min(100, scrubState.scrubTime / scrubState.total * 100) + '%';
    }
  }

  function endScrub() {
    if (!scrubState) return;
    clearInterval(scrubState.interval);
    var target = scrubState.scrubTime;
    var moved = Math.abs(target - scrubState.startTime);
    scrubState = null;
    overlay.classList.remove('visible');
    if (moved < 1) return;
    handleSeek({ time: target }, null);
  }

  function tapSeek(direction) {
    if (serverSeeking || !currentUrl) return;
    var now = seekOffset + (video.currentTime || 0);
    var jump = direction > 0 ? 10 : -5;
    handleSeek({ time: Math.max(0, now + jump) }, null);
  }

  // ── D-pad Event Handler ────────────────────────────────────────────────────

  var keyHoldTimer = null;
  var keyHeld = false;

  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;

    // Play/Pause media keys -- always work
    if (code === 179 || code === 415 || code === 19) {
      if (currentUrl && !serverSeeking) {
        if (video.paused) video.play().catch(function(){}); else video.pause();
        updatePlayIcon(); broadcast();
      }
      e.preventDefault();
      return;
    }

    if (!currentUrl) return;

    if (menuVisible) {
      // ── Menu visible: navigate buttons ──
      var btns = getVisibleButtons();
      switch (code) {
        case 37: // Left: move focus left
          if (focusIndex > 0) setFocus(focusIndex - 1);
          resetMenuTimer();
          e.preventDefault();
          break;
        case 39: // Right: move focus right
          if (focusIndex < btns.length - 1) setFocus(focusIndex + 1);
          resetMenuTimer();
          e.preventDefault();
          break;
        case 38: // Up: hide menu
        case 27: // Escape / Back
        case 8:  // Backspace (some remotes)
          hideMenu();
          e.preventDefault();
          break;
        case 40: // Down: hide menu
          hideMenu();
          e.preventDefault();
          break;
        case 13: // Enter/Select: activate
          activateFocused();
          e.preventDefault();
          break;
      }
    } else {
      // ── Menu hidden: seek or show menu ──
      switch (code) {
        case 38: // Up: show menu
        case 40: // Down: show menu
          showMenu();
          e.preventDefault();
          break;
        case 37: // Left: seek back
        case 39: // Right: seek forward
          if (!e.repeat) {
            keyHeld = false;
            var dir = code === 39 ? 1 : -1;
            keyHoldTimer = setTimeout(function () {
              keyHeld = true;
              startScrub(dir);
            }, 300);
          }
          e.preventDefault();
          break;
        case 13: // Enter: show menu
          showMenu();
          e.preventDefault();
          break;
      }
    }
  });

  document.addEventListener('keyup', function (e) {
    if (e.keyCode === 37 || e.keyCode === 39) {
      if (keyHoldTimer) { clearTimeout(keyHoldTimer); keyHoldTimer = null; }
      if (!menuVisible) {
        if (keyHeld) {
          endScrub();
        } else {
          tapSeek(e.keyCode === 39 ? 1 : -1);
        }
      }
      keyHeld = false;
      e.preventDefault();
    }
  });

  // ── Cast Message Handler ───────────────────────────────────────────────────

  context.addCustomMessageListener(NS, function (event) {
    var data = event.data;
    var sid = event.senderId;

    switch (data.type) {
      case 'LOAD':        handleLoad(data, sid); break;
      case 'PLAY':        video.play().catch(function(){}); updatePlayIcon(); reply(sid); break;
      case 'PAUSE':       video.pause(); updatePlayIcon(); reply(sid); break;
      case 'STOP':        handleStop(sid); break;
      case 'SEEK':        handleSeek(data, sid); break;
      case 'GET_STATUS':  reply(sid); break;
      case 'SET_VOLUME':
        if (data.level !== undefined) video.volume = data.level;
        if (data.muted !== undefined) video.muted = data.muted;
        reply(sid);
        break;
      case 'PING':
        send(sid, { type: 'PONG', version: VERSION });
        break;
      default: reply(sid);
    }
  });

  // ── LOAD ───────────────────────────────────────────────────────────────────

  function handleLoad(data, sid) {
    var url = data.url || (data.media && data.media.contentId);
    if (!url) return;
    console.log(TAG, 'LOAD:', url);

    destroyHls(); stopBroadcaster(); hideMenu();
    currentUrl = url;
    seekOffset = 0;
    serverSeeking = false;
    subtitleTracks = [];
    activeSubIndex = -1;

    realDuration = data.duration || 0;
    lastMetadata = data.metadata || null;
    customData = data.customData || null;

    isHlsContent = url.indexOf('.m3u8') !== -1;
    var match = url.match(/\/hls\/([a-f0-9]+)\//);
    hlsSessionId = match ? match[1] : null;
    try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

    if (data.startTime > 0) seekOffset = data.startTime;

    showPlayer(); updateMetadata(); updateSkipButtons(); updatePlayIcon(); showSpinner();

    if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
      loadHls(url, function () {
        hideSpinner();
        if (realDuration <= 0) fetchDuration();
        if (hlsSessionId && monitorrOrigin) fetchSubtitleTracks();
        startBroadcaster();
        reply(sid);
        showMenu(); // Show menu briefly on load
      });
    } else {
      video.src = url;
      video.addEventListener('canplay', function f() {
        video.removeEventListener('canplay', f);
        video.play().catch(function(){});
        hideSpinner(); startBroadcaster(); reply(sid); showMenu();
      });
    }
  }

  // ── SEEK ───────────────────────────────────────────────────────────────────

  function handleSeek(data, sid) {
    var t = data.time;
    if (t === undefined) return;

    if (!isHlsContent || !hlsSessionId || !monitorrOrigin) {
      video.currentTime = t;
      if (sid) reply(sid);
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
          serverSeeking = false; hideSpinner(); updatePlayIcon(); broadcast();
        });
        h.on(Hls.Events.ERROR, function (_, e) {
          if (e.fatal) { if (e.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad(); else if (e.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError(); }
        });
        setTimeout(function () { if (serverSeeking) { serverSeeking = false; video.play().catch(function(){}); hideSpinner(); } }, 12000);
      })
      .catch(function () { serverSeeking = false; hideSpinner(); video.play().catch(function(){}); });
  }

  // ── STOP ───────────────────────────────────────────────────────────────────

  function handleStop(sid) {
    destroyHls(); stopBroadcaster(); hideMenu();
    send(sid, { type: 'STATUS', state: 'IDLE' });
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
      updatePlayIcon();
      if (onReady) { onReady(); onReady = null; }
    });
    hls.on(Hls.Events.ERROR, function (_, d) {
      if (d.fatal) { if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(); else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError(); }
    });
  }

  function destroyHls() { if (hls) { hls.detachMedia(); hls.destroy(); hls = null; } }

  // ── Status ─────────────────────────────────────────────────────────────────

  function buildStatus() {
    return {
      type: 'STATUS',
      state: getState(),
      currentTime: seekOffset + (video.currentTime || 0),
      duration: realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0),
      volume: video.volume, muted: video.muted,
      url: currentUrl, hlsSessionId: hlsSessionId,
      metadata: lastMetadata,
      subtitles: { tracks: subtitleTracks, activeIndex: activeSubIndex },
      version: VERSION
    };
  }

  function getState() {
    if (!currentUrl) return 'IDLE';
    if (serverSeeking) return 'BUFFERING';
    if (video.paused || video.ended) return 'PAUSED';
    return 'PLAYING';
  }

  function reply(sid) { if (sid) send(sid, buildStatus()); }
  function send(sid, msg) { try { context.sendCustomMessage(NS, sid, msg); } catch(e){} }
  function broadcast() { context.getSenders().forEach(function(s) { send(s.id, buildStatus()); }); }

  function startBroadcaster() { stopBroadcaster(); statusTimer = setInterval(function () { if (!serverSeeking) broadcast(); }, 2000); }
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
          broadcast();
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
          video.play().catch(function(){}); serverSeeking = false; hideSpinner(); broadcast();
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

  function updateSkipButtons() {
    var hasPrev = customData && typeof customData.prevEpisodeFileId === 'string' && customData.prevEpisodeFileId.length > 0;
    var hasNext = customData && typeof customData.nextEpisodeFileId === 'string' && customData.nextEpisodeFileId.length > 0;
    if (btnSkipPrev) btnSkipPrev.style.display = hasPrev ? 'flex' : 'none';
    if (btnSkipNext) btnSkipNext.style.display = hasNext ? 'flex' : 'none';
  }

  function updatePlayIcon() {
    if (playIcon) playIcon.className = video.paused ? 'bi bi-play-fill' : 'bi bi-pause-fill';
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  video.addEventListener('timeupdate', function () {
    if (serverSeeking || scrubState) return;
    var total = realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);
    var cur = seekOffset + (video.currentTime || 0);
    if (timeLeft) timeLeft.textContent = fmt(cur);
    if (timeRight) timeRight.textContent = fmt(total);
    if (total > 0 && seekPlayed) seekPlayed.style.width = Math.min(100, cur / total * 100) + '%';
    if (seekBuffered && total > 0) seekBuffered.style.width = Math.min(100, (seekOffset + (isFinite(video.duration) ? video.duration : 0)) / total * 100) + '%';
  });

  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('ended', function () { if (!serverSeeking) { destroyHls(); stopBroadcaster(); hideMenu(); showIdle(); } });

  function updateMetadata() {
    if (!lastMetadata) return;
    if (metaTitle) metaTitle.textContent = lastMetadata.title || '';
    if (metaSubtitle) metaSubtitle.textContent = lastMetadata.subtitle || '';
    if (lastMetadata.images && lastMetadata.images.length > 0 && metaPoster) { metaPoster.src = lastMetadata.images[0].url; metaPoster.style.display = 'block'; }
    else if (metaPoster) metaPoster.style.display = 'none';
  }

  function showPlayer() { if (idleScreen) idleScreen.style.display = 'none'; if (playerScreen) playerScreen.style.display = 'block'; }
  function showIdle() { if (playerScreen) playerScreen.style.display = 'none'; if (idleScreen) idleScreen.style.display = 'flex'; }
  function showSpinner() { if (spinner) spinner.style.display = 'flex'; }
  function hideSpinner() { if (spinner) spinner.style.display = 'none'; }
  function fmt(s) { if (!s || !isFinite(s)) return '0:00'; s = Math.max(0, Math.floor(s)); var h = Math.floor(s/3600), m = Math.floor(s%3600/60), ss = s%60; return h > 0 ? h+':'+(m<10?'0':'')+m+':'+(ss<10?'0':'')+ss : m+':'+(ss<10?'0':'')+ss; }

  // ── Sender events ──────────────────────────────────────────────────────────

  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function (e) {
    if (currentUrl) send(e.senderId, buildStatus());
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
  opts.customNamespaces[NS] = cast.framework.system.MessageType.JSON;

  context.start(opts);
  console.log(TAG, 'Receiver started');
  showIdle();

})();
