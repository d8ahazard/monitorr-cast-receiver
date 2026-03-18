'use strict';

// ─── Monitorr Cast Receiver v0.2.0 ──────────────────────────────────────────
//
// - HLS.js destroy + re-create on seek (no attached-loadSource cascade)
// - Hand-crafted MEDIA_STATUS on the media namespace
// - Subtitle track cycling from server tracks.json
// - Contextual skip buttons via LOAD customData
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.3.0';
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

  // Subtitles
  var subtitleTracks = [];
  var activeSubIndex = -1;

  // ── Media Namespace Listener ───────────────────────────────────────────────

  context.addCustomMessageListener(MEDIA_NS, function (event) {
    var data = event.data;
    var senderId = event.senderId;
    var reqId = data.requestId || 0;

    console.log(TAG, 'Media msg:', data.type);

    switch (data.type) {
      case 'LOAD':        handleLoad(data, senderId, reqId); break;
      case 'PLAY':        video.play().catch(function () {}); sendMediaStatus(senderId, reqId); break;
      case 'PAUSE':       video.pause(); sendMediaStatus(senderId, reqId); break;
      case 'STOP':        handleStop(senderId, reqId); break;
      case 'SEEK':        handleSeek(data, senderId, reqId); break;
      case 'GET_STATUS':  sendMediaStatus(senderId, reqId); break;
      case 'SET_VOLUME':
        if (data.volume) {
          if (data.volume.level !== undefined) video.volume = data.volume.level;
          if (data.volume.muted !== undefined) video.muted = data.volume.muted;
        }
        sendMediaStatus(senderId, reqId);
        break;
      default:
        sendMediaStatus(senderId, reqId);
    }
  });

  // ── LOAD ───────────────────────────────────────────────────────────────────

  function handleLoad(data, senderId, reqId) {
    var media = data.media;
    if (!media || !media.contentId) return;

    var url = media.contentId;
    console.log(TAG, 'LOAD:', url);

    destroyPlayer();
    mediaSessionId++;
    currentUrl = url;
    seekOffset = 0;
    serverSeeking = false;
    subtitleTracks = [];
    activeSubIndex = -1;

    if (media.duration > 0) realDuration = media.duration;
    else realDuration = 0;

    lastMetadata = media.metadata || null;
    // customData is inside media (from our sender) -- NOT at the LOAD level
    customData = (media.customData && typeof media.customData === 'object') ? media.customData : null;
    console.log(TAG, 'customData:', JSON.stringify(customData));

    isHlsContent = url.indexOf('.m3u8') !== -1 ||
      (media.contentType && media.contentType.indexOf('mpegURL') !== -1);

    var match = url.match(/\/hls\/([a-f0-9]+)\//);
    hlsSessionId = match ? match[1] : null;

    try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

    var startTime = data.currentTime || 0;
    if (startTime > 0) seekOffset = startTime;

    showPlayer();
    updateMetadata();
    updateSkipButtons();
    showSpinner();

    if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
      createAndLoadHls(url, function () {
        hideSpinner();
        if (realDuration <= 0) fetchDuration();
        if (hlsSessionId && monitorrOrigin) fetchSubtitleTracks();
        startStatusBroadcaster();
        sendMediaStatus(senderId, reqId);
        flashOverlay();
      });
    } else {
      video.src = url;
      video.addEventListener('canplay', function onCanPlay() {
        video.removeEventListener('canplay', onCanPlay);
        video.play().catch(function () {});
        hideSpinner();
        startStatusBroadcaster();
        sendMediaStatus(senderId, reqId);
      });
    }
  }

  // ── SEEK (destroy + re-create pattern) ─────────────────────────────────────

  function handleSeek(data, senderId, reqId) {
    var targetTime = data.currentTime;
    if (targetTime === undefined) return;
    console.log(TAG, 'SEEK to', targetTime);

    if (!isHlsContent || !hlsSessionId || !monitorrOrigin) {
      video.currentTime = targetTime;
      sendMediaStatus(senderId, reqId);
      return;
    }

    if (serverSeeking) return;
    serverSeeking = true;
    video.pause();
    showSpinner();

    var seekUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + targetTime.toFixed(1);

    fetch(seekUrl, { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (res) {
        console.log(TAG, 'Server seek OK:', JSON.stringify(res));
        seekOffset = res.offsetSeconds || targetTime;

        var cacheBuster = Date.now().toString(36);
        var reloadUrl = currentUrl.split('?')[0] + '?seek=' + cacheBuster;
        currentUrl = reloadUrl;

        // Destroy old HLS instance completely (detach from video first)
        if (hls) {
          hls.detachMedia();
          hls.destroy();
          hls = null;
        }

        // Create fresh instance, load manifest WITHOUT attaching to video
        var newHls = new Hls({
          enableWorker: false,
          maxBufferLength: 30,
          maxMaxBufferLength: 120,
          startLevel: -1,
        });
        hls = newHls;

        newHls.loadSource(reloadUrl);

        newHls.once(Hls.Events.MANIFEST_PARSED, function () {
          console.log(TAG, 'Seek: manifest parsed, attaching to video');
          // NOW attach to video -- single clean pipeline init
          newHls.attachMedia(video);
        });

        newHls.once(Hls.Events.FRAG_BUFFERED, function () {
          console.log(TAG, 'Seek: fragment buffered, starting playback');
          video.play().catch(function () {});
          serverSeeking = false;
          hideSpinner();
          sendMediaStatus(senderId, reqId);
          flashOverlay();
        });

        newHls.on(Hls.Events.ERROR, function (_, errData) {
          if (errData.fatal) {
            console.error(TAG, 'Seek HLS error:', errData.type, errData.details);
            if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) newHls.startLoad();
            else if (errData.type === Hls.ErrorTypes.MEDIA_ERROR) newHls.recoverMediaError();
          }
        });

        // Safety timeout
        setTimeout(function () {
          if (serverSeeking) {
            console.warn(TAG, 'Seek safety timeout');
            serverSeeking = false;
            video.play().catch(function () {});
            hideSpinner();
            sendMediaStatus(senderId, reqId);
          }
        }, 12000);
      })
      .catch(function (err) {
        console.error(TAG, 'Server seek failed:', err);
        serverSeeking = false;
        hideSpinner();
        video.play().catch(function () {});
      });
  }

  // ── STOP ───────────────────────────────────────────────────────────────────

  function handleStop(senderId, reqId) {
    console.log(TAG, 'STOP');
    destroyPlayer();
    var status = buildMediaStatus(reqId, 'IDLE');
    status.status[0].idleReason = 'CANCELLED';
    sendRaw(senderId, status);
    showIdle();
  }

  // ── HLS.js ─────────────────────────────────────────────────────────────────

  function createAndLoadHls(url, onReady) {
    if (hls) { hls.detachMedia(); hls.destroy(); hls = null; }

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
      if (onReady) { onReady(); onReady = null; }
    });

    hls.on(Hls.Events.ERROR, function (_, data) {
      if (data.fatal) {
        console.error(TAG, 'HLS fatal:', data.type, data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
  }

  function destroyPlayer() {
    stopStatusBroadcaster();
    if (hls) { hls.detachMedia(); hls.destroy(); hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    seekOffset = 0;
    currentUrl = null;
    subtitleTracks = [];
    activeSubIndex = -1;
  }

  // ── MEDIA_STATUS ───────────────────────────────────────────────────────────

  function buildMediaStatus(reqId, stateOverride) {
    var state = stateOverride || getPlayerState();
    var ct = getCurrentTime();

    var status = {
      type: 'MEDIA_STATUS',
      requestId: reqId || 0,
      status: [{
        mediaSessionId: mediaSessionId,
        playbackRate: video.playbackRate || 1,
        playerState: state,
        currentTime: ct,
        supportedMediaCommands: 0x3FFFF,
        volume: { level: video.volume, muted: video.muted },
        media: null
      }]
    };

    if (currentUrl) {
      status.status[0].media = {
        contentId: currentUrl,
        streamType: 'BUFFERED',
        contentType: isHlsContent ? 'application/x-mpegURL' : 'video/mp4',
        duration: realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0),
        metadata: lastMetadata
      };
    }

    return status;
  }

  function getPlayerState() {
    if (!currentUrl) return 'IDLE';
    if (serverSeeking || video.seeking || video.readyState < 3) return 'BUFFERING';
    if (video.paused || video.ended) return 'PAUSED';
    return 'PLAYING';
  }

  function getCurrentTime() {
    if (!video || !currentUrl) return 0;
    return seekOffset + (video.currentTime || 0);
  }

  function sendMediaStatus(senderId, reqId) {
    if (senderId) sendRaw(senderId, buildMediaStatus(reqId));
    else broadcastMediaStatus(reqId);
  }

  function broadcastMediaStatus(reqId) {
    var status = buildMediaStatus(reqId || 0);
    var senders = context.getSenders();
    for (var i = 0; i < senders.length; i++) {
      try { sendRaw(senders[i].id, status); } catch (e) {}
    }
  }

  function sendRaw(senderId, msg) {
    try { context.sendCustomMessage(MEDIA_NS, senderId, msg); } catch (e) {}
  }

  // ── Status Broadcaster ─────────────────────────────────────────────────────

  function startStatusBroadcaster() {
    stopStatusBroadcaster();
    statusTimer = setInterval(function () {
      if (!serverSeeking) broadcastMediaStatus(0);
    }, 2000);
  }

  function stopStatusBroadcaster() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
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
          broadcastMediaStatus(0);
        } else {
          setTimeout(fetchDuration, 3000);
        }
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  // ── Subtitles ──────────────────────────────────────────────────────────────

  // ── Subtitles (server-side burn-in) ──────────────────────────────────────

  function fetchSubtitleTracks() {
    if (!hlsSessionId || !monitorrOrigin) return;
    var url = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subtitles';
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        subtitleTracks = data.tracks || [];
        activeSubIndex = -1;
        // Find if any sub is currently active
        if (data.activeStreamIndex != null) {
          for (var i = 0; i < subtitleTracks.length; i++) {
            if (subtitleTracks[i].streamIndex === data.activeStreamIndex) {
              activeSubIndex = i;
              break;
            }
          }
        }
        console.log(TAG, 'Subtitle tracks:', subtitleTracks.length, 'active:', activeSubIndex);
        updateCCButton();
      })
      .catch(function () { subtitleTracks = []; updateCCButton(); });
  }

  function cycleSubtitle() {
    if (subtitleTracks.length === 0) return;
    var next = activeSubIndex + 1;
    if (next >= subtitleTracks.length) next = -1; // cycle back to off
    toggleSubtitle(next);
  }

  function toggleSubtitle(idx) {
    if (!hlsSessionId || !monitorrOrigin) return;

    showSpinner();
    serverSeeking = true; // freeze UI during transcode restart

    if (idx < 0) {
      // Disable subs
      var disableUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/disable';
      fetch(disableUrl, { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function () { reloadAfterSubChange(-1); })
        .catch(function (err) {
          console.error(TAG, 'Disable subs failed:', err);
          serverSeeking = false;
          hideSpinner();
        });
    } else {
      // Enable subs with burn-in
      var track = subtitleTracks[idx];
      var enableUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/enable?streamIndex=' + track.streamIndex;
      fetch(enableUrl, { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function () { reloadAfterSubChange(idx); })
        .catch(function (err) {
          console.error(TAG, 'Enable subs failed:', err);
          serverSeeking = false;
          hideSpinner();
        });
    }
  }

  function reloadAfterSubChange(newIdx) {
    activeSubIndex = newIdx;
    updateCCButton();

    // Reload the HLS source (server has restarted transcode with/without subs)
    var cacheBuster = Date.now().toString(36);
    var reloadUrl = currentUrl.split('?')[0] + '?subs=' + cacheBuster;
    currentUrl = reloadUrl;

    if (hls) { hls.detachMedia(); hls.destroy(); hls = null; }

    var newHls = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 120, startLevel: -1 });
    hls = newHls;
    newHls.loadSource(reloadUrl);
    newHls.once(Hls.Events.MANIFEST_PARSED, function () {
      newHls.attachMedia(video);
    });
    newHls.once(Hls.Events.FRAG_BUFFERED, function () {
      video.play().catch(function () {});
      serverSeeking = false;
      hideSpinner();
      broadcastMediaStatus(0);
      flashOverlay();
      console.log(TAG, 'Subtitle change complete, active:', newIdx);
    });
    newHls.on(Hls.Events.ERROR, function (_, errData) {
      if (errData.fatal) {
        if (errData.type === Hls.ErrorTypes.NETWORK_ERROR) newHls.startLoad();
        else if (errData.type === Hls.ErrorTypes.MEDIA_ERROR) newHls.recoverMediaError();
      }
    });

    setTimeout(function () {
      if (serverSeeking) { serverSeeking = false; hideSpinner(); video.play().catch(function () {}); }
    }, 15000);
  }

  function updateCCButton() {
    if (!btnCC) return;
    if (subtitleTracks.length === 0) {
      btnCC.style.display = 'none';
      return;
    }
    btnCC.style.display = 'flex';
    if (activeSubIndex >= 0 && subtitleTracks[activeSubIndex]) {
      btnCC.classList.add('active');
      if (ccLabel) ccLabel.textContent = subtitleTracks[activeSubIndex].language.toUpperCase();
    } else {
      btnCC.classList.remove('active');
      if (ccLabel) ccLabel.textContent = '';
    }
  }

  // ── Skip Buttons ───────────────────────────────────────────────────────────

  function updateSkipButtons() {
    // Only show skip buttons when we have actual episode file IDs (strings, not null/empty)
    var hasPrev = customData && typeof customData.prevEpisodeFileId === 'string' && customData.prevEpisodeFileId.length > 0;
    var hasNext = customData && typeof customData.nextEpisodeFileId === 'string' && customData.nextEpisodeFileId.length > 0;
    if (btnSkipPrev) btnSkipPrev.style.display = hasPrev ? 'flex' : 'none';
    if (btnSkipNext) btnSkipNext.style.display = hasNext ? 'flex' : 'none';
    console.log(TAG, 'Skip buttons: prev=' + hasPrev + ' next=' + hasNext);
  }

  function requestSkip(direction) {
    var senders = context.getSenders();
    for (var i = 0; i < senders.length; i++) {
      try {
        context.sendCustomMessage(MONITORR_NS, senders[i].id, {
          type: direction === 'next' ? 'SKIP_NEXT' : 'SKIP_PREV',
          hlsSessionId: hlsSessionId
        });
      } catch (e) {}
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  video.addEventListener('timeupdate', function () {
    if (serverSeeking) return;
    var total = realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);
    var current = getCurrentTime();
    if (timeLeft) timeLeft.textContent = formatTime(current);
    if (timeRight) timeRight.textContent = formatTime(total);
    if (total > 0 && seekPlayed) seekPlayed.style.width = Math.min(100, (current / total) * 100) + '%';
    if (seekBuffered && total > 0) {
      var be = seekOffset + (isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
      seekBuffered.style.width = Math.min(100, (be / total) * 100) + '%';
    }
  });

  video.addEventListener('ended', function () {
    if (serverSeeking) return;
    broadcastMediaStatus(0);
    destroyPlayer();
    showIdle();
  });

  // Wire up CC button
  if (btnCC) btnCC.addEventListener('click', function () { cycleSubtitle(); });
  if (btnSkipPrev) btnSkipPrev.addEventListener('click', function () { requestSkip('prev'); });
  if (btnSkipNext) btnSkipNext.addEventListener('click', function () { requestSkip('next'); });

  function updateMetadata() {
    if (!lastMetadata) return;
    if (metaTitle) metaTitle.textContent = lastMetadata.title || '';
    if (metaSubtitle) metaSubtitle.textContent = lastMetadata.subtitle || '';
    if (lastMetadata.images && lastMetadata.images.length > 0 && metaPoster) {
      metaPoster.src = lastMetadata.images[0].url;
      metaPoster.style.display = 'block';
    } else if (metaPoster) {
      metaPoster.style.display = 'none';
    }
  }

  function flashOverlay() {
    if (overlay) overlay.classList.add('visible');
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () {
      if (overlay) overlay.classList.remove('visible');
    }, 6000);
  }

  function showPlayer() {
    if (idleScreen) idleScreen.style.display = 'none';
    if (playerScreen) playerScreen.style.display = 'block';
  }

  function showIdle() {
    if (playerScreen) playerScreen.style.display = 'none';
    if (idleScreen) idleScreen.style.display = 'flex';
  }

  function showSpinner() { if (spinner) spinner.style.display = 'flex'; }
  function hideSpinner() { if (spinner) spinner.style.display = 'none'; }

  function formatTime(s) {
    if (!s || !isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    return h > 0
      ? h + ':' + (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss
      : m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  // ── Monitorr Namespace ─────────────────────────────────────────────────────

  context.addCustomMessageListener(MONITORR_NS, function (event) {
    var data = event.data;
    if (data.type === 'PING') {
      context.sendCustomMessage(MONITORR_NS, event.senderId, {
        type: 'PONG', version: VERSION,
        currentTime: getCurrentTime(), duration: realDuration,
        hlsSessionId: hlsSessionId, playerState: getPlayerState()
      });
    }
  });

  // ── Sender events ──────────────────────────────────────────────────────────

  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function (event) {
    console.log(TAG, 'Sender connected:', event.senderId);
    if (currentUrl) sendMediaStatus(event.senderId, 0);
  });

  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function (event) {
    console.log(TAG, 'Sender disconnected:', event.senderId);
    if (context.getSenders().length === 0) { destroyPlayer(); context.stop(); }
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
