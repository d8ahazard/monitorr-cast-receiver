'use strict';

// ─── Monitorr Cast Receiver v0.1.0 ──────────────────────────────────────────
//
// Fully custom receiver: HLS.js player, hand-crafted MEDIA_STATUS messages,
// server-side seeking with seekOffset tracking, no dependency on PlayerManager
// internal state or cast-media-player element.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '0.1.3';
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

  // ── State ──────────────────────────────────────────────────────────────────

  var hls = null;
  var mediaSessionId = 0;
  var realDuration = 0;
  var seekOffset = 0;
  var currentUrl = null;
  var hlsSessionId = null;
  var monitorrOrigin = null;
  var lastMetadata = null;
  var serverSeeking = false;
  var statusTimer = null;
  var overlayTimer = null;
  var isHlsContent = false;

  // ── Media Namespace Listener ───────────────────────────────────────────────
  // We handle ALL media messages ourselves instead of using PlayerManager.

  context.addCustomMessageListener(MEDIA_NS, function (event) {
    var data = event.data;
    var senderId = event.senderId;
    var reqId = data.requestId || 0;

    console.log(TAG, 'Media msg:', data.type, 'from', senderId);

    switch (data.type) {
      case 'LOAD':
        handleLoad(data, senderId, reqId);
        break;
      case 'PLAY':
        video.play().catch(function () {});
        sendMediaStatus(senderId, reqId);
        break;
      case 'PAUSE':
        video.pause();
        sendMediaStatus(senderId, reqId);
        break;
      case 'STOP':
        handleStop(senderId, reqId);
        break;
      case 'SEEK':
        handleSeek(data, senderId, reqId);
        break;
      case 'GET_STATUS':
        sendMediaStatus(senderId, reqId);
        break;
      case 'SET_VOLUME':
        if (data.volume) {
          if (data.volume.level !== undefined) video.volume = data.volume.level;
          if (data.volume.muted !== undefined) video.muted = data.volume.muted;
        }
        sendMediaStatus(senderId, reqId);
        break;
      default:
        console.log(TAG, 'Unhandled media msg:', data.type);
        sendMediaStatus(senderId, reqId);
    }
  });

  // ── LOAD ───────────────────────────────────────────────────────────────────

  function handleLoad(data, senderId, reqId) {
    var media = data.media;
    if (!media || !media.contentId) {
      console.error(TAG, 'LOAD: no contentId');
      return;
    }

    var url = media.contentId;
    console.log(TAG, 'LOAD:', url);

    // Cleanup previous session
    destroyPlayer();

    mediaSessionId++;
    currentUrl = url;
    seekOffset = 0;
    serverSeeking = false;

    if (media.duration > 0) realDuration = media.duration;
    else realDuration = 0;

    lastMetadata = media.metadata || null;

    isHlsContent = url.indexOf('.m3u8') !== -1 ||
      (media.contentType && media.contentType.indexOf('mpegURL') !== -1);

    var match = url.match(/\/hls\/([a-f0-9]+)\//);
    hlsSessionId = match ? match[1] : null;

    try { monitorrOrigin = new URL(url).origin; } catch (e) { monitorrOrigin = null; }

    // Apply start position from sender (resume point)
    var startTime = data.currentTime || 0;
    if (startTime > 0) seekOffset = startTime;

    // Update UI
    showPlayer();
    updateMetadata();
    showSpinner();

    if (isHlsContent && typeof Hls !== 'undefined' && Hls.isSupported()) {
      loadHls(url, function () {
        hideSpinner();
        if (realDuration <= 0) fetchDuration();
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

  // ── SEEK ───────────────────────────────────────────────────────────────────

  function handleSeek(data, senderId, reqId) {
    var targetTime = data.currentTime;
    if (targetTime === undefined) return;

    console.log(TAG, 'SEEK to', targetTime);

    if (!isHlsContent || !hlsSessionId || !monitorrOrigin) {
      video.currentTime = targetTime;
      sendMediaStatus(senderId, reqId);
      return;
    }

    // Server-side seek for HLS
    if (serverSeeking) return;
    serverSeeking = true;

    // 1. Pause immediately and show spinner
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

        // 2. Update offset NOW (before loading new source)
        seekOffset = res.offsetSeconds || targetTime;

        var cacheBuster = Date.now().toString(36);
        var reloadUrl = currentUrl.split('?')[0] + '?seek=' + cacheBuster;
        currentUrl = reloadUrl;

        // 3. Load new source (video stays paused)
        hls.loadSource(reloadUrl);

        hls.once(Hls.Events.MANIFEST_PARSED, function () {
          // 4. Seek to start of new content, still paused
          video.currentTime = 0;

          // 5. Wait until enough data is buffered to play
          function onCanPlay() {
            video.removeEventListener('canplay', onCanPlay);

            // 6. Everything is ready. Single clean transition:
            //    update status, unpause, hide spinner -- all at once.
            serverSeeking = false;
            video.play().catch(function () {});
            hideSpinner();
            sendMediaStatus(senderId, reqId);
            flashOverlay();
            console.log(TAG, 'Seek complete, offset:', seekOffset);
          }
          video.addEventListener('canplay', onCanPlay);

          // Safety: if canplay doesn't fire within 8s, force it
          setTimeout(function () {
            video.removeEventListener('canplay', onCanPlay);
            if (serverSeeking) {
              serverSeeking = false;
              video.play().catch(function () {});
              hideSpinner();
              sendMediaStatus(senderId, reqId);
            }
          }, 8000);
        });
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

  function loadHls(url, onReady) {
    if (hls) { hls.destroy(); hls = null; }

    hls = new Hls({
      enableWorker: false,
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      startLevel: -1,
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      console.log(TAG, 'HLS manifest parsed, video.duration:', video.duration);
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
    if (hls) { hls.destroy(); hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    seekOffset = 0;
    currentUrl = null;
  }

  // ── MEDIA_STATUS Builder ───────────────────────────────────────────────────

  function buildMediaStatus(reqId, stateOverride) {
    var state = stateOverride || getPlayerState();
    var currentTime = getCurrentTime();

    var status = {
      type: 'MEDIA_STATUS',
      requestId: reqId || 0,
      status: [{
        mediaSessionId: mediaSessionId,
        playbackRate: video.playbackRate || 1,
        playerState: state,
        currentTime: currentTime,
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

  // ── Send to senders ────────────────────────────────────────────────────────

  function sendMediaStatus(senderId, reqId) {
    var status = buildMediaStatus(reqId);
    if (senderId) {
      sendRaw(senderId, status);
    } else {
      broadcastMediaStatus(reqId);
    }
  }

  function broadcastMediaStatus(reqId) {
    var status = buildMediaStatus(reqId || 0);
    var senders = context.getSenders();
    for (var i = 0; i < senders.length; i++) {
      try { sendRaw(senders[i].id, status); } catch (e) {}
    }
  }

  function sendRaw(senderId, msg) {
    try {
      context.sendCustomMessage(MEDIA_NS, senderId, msg);
    } catch (e) {
      console.warn(TAG, 'Send failed:', e.message);
    }
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

  // ── Duration Fetching ──────────────────────────────────────────────────────

  function fetchDuration() {
    if (!hlsSessionId || !monitorrOrigin) return;
    var url = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/info';

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.durationSeconds > 0) {
          realDuration = info.durationSeconds;
          console.log(TAG, 'Duration:', realDuration + 's');
          if (info.startOffsetSeconds > 0 && seekOffset === 0) {
            seekOffset = info.startOffsetSeconds;
          }
          broadcastMediaStatus(0);
        } else {
          setTimeout(fetchDuration, 3000);
        }
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  // ── UI Updates ─────────────────────────────────────────────────────────────

  video.addEventListener('timeupdate', updateOverlayProgress);
  video.addEventListener('ended', function () {
    if (serverSeeking) return;
    broadcastMediaStatus(0);
    destroyPlayer();
    showIdle();
  });

  function updateOverlayProgress() {
    if (serverSeeking) return;
    var total = realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);
    var current = getCurrentTime();
    if (timeLeft) timeLeft.textContent = formatTime(current);
    if (timeRight) timeRight.textContent = formatTime(total);
    if (total > 0 && seekPlayed) {
      seekPlayed.style.width = Math.min(100, (current / total) * 100) + '%';
    }
    // Buffered indicator
    if (seekBuffered && total > 0) {
      var bufferedEnd = seekOffset + getTranscodedDuration();
      seekBuffered.style.width = Math.min(100, (bufferedEnd / total) * 100) + '%';
    }
  }

  function getTranscodedDuration() {
    if (!video) return 0;
    var d = video.duration;
    return (isFinite(d) && d > 0) ? d : 0;
  }

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

  // ── Monitorr Custom Namespace ──────────────────────────────────────────────

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

  // ── Sender connect/disconnect ──────────────────────────────────────────────

  context.addEventListener(
    cast.framework.system.EventType.SENDER_CONNECTED,
    function (event) {
      console.log(TAG, 'Sender connected:', event.senderId);
      if (currentUrl) sendMediaStatus(event.senderId, 0);
    }
  );

  context.addEventListener(
    cast.framework.system.EventType.SENDER_DISCONNECTED,
    function (event) {
      console.log(TAG, 'Sender disconnected:', event.senderId);
      if (context.getSenders().length === 0) {
        destroyPlayer();
        context.stop();
      }
    }
  );

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
