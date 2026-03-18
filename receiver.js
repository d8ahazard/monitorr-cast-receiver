'use strict';

// ─── Monitorr Cast Receiver v1.0.0 ──────────────────────────────────────────
//
// Fully custom receiver. No cast-media-player, no Shaka, no native player UI.
// HLS.js for Monitorr-transcoded streams. Plain <video> for direct play.
// CAF SDK used only for session lifecycle, message interception, and status.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var context = cast.framework.CastReceiverContext.getInstance();
  var playerManager = context.getPlayerManager();
  var MessageType = cast.framework.messages.MessageType;

  // ── DOM refs ───────────────────────────────────────────────────────────────

  var videoEl = document.getElementById('mr-video');
  var elIdle = document.getElementById('mr-idle');
  var elLoading = document.getElementById('mr-loading');
  var elLoadingTitle = document.getElementById('mr-loading-title');
  var elLoadingSub = document.getElementById('mr-loading-sub');
  var elTransport = document.getElementById('mr-transport');
  var elPoster = document.getElementById('mr-poster');
  var elTitle = document.getElementById('mr-title');
  var elSubtitle = document.getElementById('mr-subtitle');
  var elTimeCurrent = document.getElementById('mr-time-current');
  var elTimeDuration = document.getElementById('mr-time-duration');
  var elProgressPlayed = document.getElementById('mr-progress-played');
  var elProgressBuffered = document.getElementById('mr-progress-buffered');
  var elProgressSeek = document.getElementById('mr-progress-seek');
  var elBtnPlayPause = document.getElementById('mr-btn-playpause');
  var elIconPlay = document.getElementById('mr-icon-play');
  var elIconPause = document.getElementById('mr-icon-pause');
  var elBtnRw = document.getElementById('mr-btn-rw');
  var elBtnFf = document.getElementById('mr-btn-ff');
  var elBtnPrev = document.getElementById('mr-btn-prev');
  var elBtnNext = document.getElementById('mr-btn-next');
  var elBtnCc = document.getElementById('mr-btn-cc');
  var elToast = document.getElementById('mr-toast');

  // ── Logging ────────────────────────────────────────────────────────────────

  function log(cat, msg) {
    console.log('[MonitorrCast] [' + cat + '] ' + msg);
  }

  // ── Central state ──────────────────────────────────────────────────────────

  var state = {
    mode: null,
    sessionId: null,
    monitorrOrigin: null,
    currentUrl: null,
    realDuration: 0,
    seekOffset: 0,
    pendingSeekTarget: null,
    serverSeeking: false,
    playbackState: 'idle',
    subtitleTracks: [],
    activeSubTrackId: null,
    metadata: { title: '', subtitle: '', posterUrl: null },
    episodeNav: { next: null, prev: null },
    mediaSessionId: 1,
  };

  var hls = null;
  var statusTimer = null;
  var transportHideTimer = null;
  var toastTimer = null;

  // ── State machine ──────────────────────────────────────────────────────────

  function setState(newState) {
    if (state.playbackState === newState) return;
    var prev = state.playbackState;
    state.playbackState = newState;
    log('state', prev + ' -> ' + newState);
    document.body.setAttribute('data-state', newState);
    document.body.classList.remove('mr-transport-autohide');
    updateUI();
    scheduleTransportHide();
  }

  // ── UI updates ─────────────────────────────────────────────────────────────

  function updateUI() {
    var s = state.playbackState;
    var isPlaying = s === 'playing';
    var isPaused = s === 'paused';

    elIconPlay.style.display = isPlaying ? 'none' : '';
    elIconPause.style.display = isPlaying ? '' : 'none';

    if (state.metadata.title) elTitle.textContent = state.metadata.title;
    if (state.metadata.subtitle) elSubtitle.textContent = state.metadata.subtitle;

    if (state.metadata.posterUrl) {
      elPoster.src = state.metadata.posterUrl;
      elPoster.classList.add('has-src');
    } else {
      elPoster.classList.remove('has-src');
    }

    if (s === 'loading' || s === 'seeking') {
      elLoadingTitle.textContent = state.metadata.title || '';
      elLoadingSub.textContent = s === 'seeking' ? 'Seeking\u2026' : 'Loading\u2026';
    }

    elBtnPrev.classList.toggle('available', !!state.episodeNav.prev);
    elBtnNext.classList.toggle('available', !!state.episodeNav.next);
    elBtnCc.classList.toggle('active', state.activeSubTrackId !== null);

    updateProgress();
  }

  function updateProgress() {
    var current = getCurrentTime();
    var duration = state.realDuration;

    elTimeCurrent.textContent = formatTime(current);
    elTimeDuration.textContent = formatTime(duration);

    if (duration > 0) {
      var pct = Math.min(100, Math.max(0, (current / duration) * 100));
      elProgressPlayed.style.width = pct + '%';
    } else {
      elProgressPlayed.style.width = '0%';
    }

    if (videoEl.buffered.length > 0 && duration > 0) {
      var buffEnd = state.seekOffset + videoEl.buffered.end(videoEl.buffered.length - 1);
      var buffPct = Math.min(100, (buffEnd / duration) * 100);
      elProgressBuffered.style.width = buffPct + '%';
    }

    if (state.serverSeeking && state.pendingSeekTarget !== null && duration > 0) {
      var seekPct = Math.min(100, (state.pendingSeekTarget / duration) * 100);
      elProgressSeek.style.width = seekPct + '%';
      elProgressSeek.classList.add('active');
    } else {
      elProgressSeek.classList.remove('active');
    }
  }

  function scheduleTransportHide() {
    clearTimeout(transportHideTimer);
    if (state.playbackState === 'playing') {
      transportHideTimer = setTimeout(function () {
        document.body.classList.add('mr-transport-autohide');
      }, 5000);
    }
  }

  function showTransport() {
    document.body.classList.remove('mr-transport-autohide');
    scheduleTransportHide();
  }

  function showToast(msg, durationMs) {
    elToast.textContent = msg;
    elToast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      elToast.classList.remove('visible');
    }, durationMs || 4000);
  }

  function getCurrentTime() {
    if (state.serverSeeking && state.pendingSeekTarget !== null) {
      return state.pendingSeekTarget;
    }
    return state.seekOffset + (videoEl.currentTime || 0);
  }

  function formatTime(sec) {
    if (!sec || sec < 0) return '0:00';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return m + ':' + pad2(s);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // ── Playback engines ───────────────────────────────────────────────────────

  function loadHls(url) {
    destroyHls();
    state.currentUrl = url;
    setState('loading');

    if (!Hls.isSupported()) {
      log('load', 'HLS.js not supported on this device, falling back to native');
      videoEl.src = url;
      videoEl.play().catch(function () {});
      return;
    }

    hls = new Hls({
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      enableWorker: true,
      lowLatencyMode: false,
      startPosition: 0,
    });

    hls.loadSource(url);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      log('load', 'HLS manifest parsed, starting playback');
      videoEl.play().then(function () {
        setState('playing');
        broadcastStatus();
      }).catch(function (e) {
        log('load', 'Autoplay blocked: ' + e.message);
        setState('paused');
        broadcastStatus();
      });
    });

    hls.on(Hls.Events.ERROR, function (event, data) {
      log('hls', 'Error: ' + data.type + ' / ' + data.details + ' fatal=' + data.fatal);
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            log('hls', 'Fatal network error, attempting recovery');
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            log('hls', 'Fatal media error, attempting recovery');
            hls.recoverMediaError();
            break;
          default:
            log('hls', 'Unrecoverable error');
            showToast('Playback error');
            destroyHls();
            setState('idle');
            break;
        }
      }
    });
  }

  function loadDirect(url) {
    destroyHls();
    state.currentUrl = url;
    setState('loading');

    videoEl.src = url;
    videoEl.load();
  }

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    videoEl.removeAttribute('src');
    videoEl.load();
  }

  // ── Video element events ───────────────────────────────────────────────────

  videoEl.addEventListener('loadedmetadata', function () {
    log('video', 'loadedmetadata, native duration=' + videoEl.duration);
    if (state.mode === 'direct' && videoEl.duration && isFinite(videoEl.duration)) {
      state.realDuration = videoEl.duration;
    }
    updateUI();
  });

  videoEl.addEventListener('canplay', function () {
    log('video', 'canplay');
    if (state.playbackState === 'loading') {
      videoEl.play().then(function () {
        setState('playing');
        broadcastStatus();
      }).catch(function () {
        setState('paused');
        broadcastStatus();
      });
    }
  });

  videoEl.addEventListener('playing', function () {
    if (state.playbackState !== 'seeking') {
      setState('playing');
      broadcastStatus();
    }
  });

  videoEl.addEventListener('pause', function () {
    if (!state.serverSeeking && state.playbackState !== 'idle' && state.playbackState !== 'loading') {
      setState('paused');
      broadcastStatus();
    }
  });

  videoEl.addEventListener('waiting', function () {
    if (!state.serverSeeking && state.playbackState === 'playing') {
      setState('buffering');
    }
  });

  videoEl.addEventListener('ended', function () {
    log('video', 'ended');
    if (state.episodeNav.next) {
      playNextEpisode();
    } else {
      resetToIdle();
      broadcastStatus();
    }
  });

  videoEl.addEventListener('timeupdate', function () {
    if (!state.serverSeeking) updateProgress();
  });

  // ── LOAD interceptor ──────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.LOAD, function (request) {
    var media = request.media;
    if (!media) {
      log('load', 'LOAD with no media, ignoring');
      return null;
    }

    var url = media.contentId || media.contentUrl || '';
    var cd = media.customData || {};
    log('load', 'LOAD url=' + url);
    log('load', 'customData=' + JSON.stringify(cd));

    // Reset
    stopStatusTimer();
    state.serverSeeking = false;
    state.pendingSeekTarget = null;
    state.seekOffset = 0;
    state.subtitleTracks = [];
    state.activeSubTrackId = null;
    state.mediaSessionId = (state.mediaSessionId || 0) + 1;

    // Determine mode
    state.mode = cd.playbackMode ||
      ((url.indexOf('.m3u8') !== -1 || (media.contentType && media.contentType.indexOf('mpegURL') !== -1))
        ? 'monitorr-hls' : 'direct');
    log('load', 'Mode: ' + state.mode);

    // Extract session info (customData preferred, URL fallback)
    state.sessionId = cd.sessionId || extractSessionId(url);
    try { state.monitorrOrigin = cd.monitorrOrigin || new URL(url).origin; }
    catch (e) { state.monitorrOrigin = null; }

    // Duration
    state.realDuration = cd.durationSeconds || media.duration || 0;
    state.seekOffset = cd.startOffsetSeconds || (request.currentTime > 0 ? request.currentTime : 0);

    // Metadata
    var meta = media.metadata || {};
    var images = meta.images || [];
    state.metadata = {
      title: meta.title || cd.title || '',
      subtitle: meta.subtitle || cd.subtitle || '',
      posterUrl: cd.posterUrl || (images.length > 0 ? images[0].url : null),
    };

    // Episode navigation
    state.episodeNav = {
      next: cd.nextEpisodeFileId || null,
      prev: cd.prevEpisodeFileId || null,
    };

    // Load via our engine
    if (state.mode === 'monitorr-hls') {
      loadHls(url);
    } else {
      loadDirect(url);
    }

    // Fetch duration + subtitles from backend (async, non-blocking)
    if (state.sessionId && state.monitorrOrigin) {
      if (state.realDuration <= 0) fetchDuration();
      fetchSubtitleTracks();
    }

    startStatusTimer();
    updateUI();

    return null;
  });

  // ── SEEK interceptor ──────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.SEEK, function (request) {
    var targetTime = request.currentTime;
    log('seek', 'SEEK to ' + targetTime + 's (mode=' + state.mode + ')');
    showTransport();

    if (state.mode === 'direct') {
      videoEl.currentTime = targetTime;
      broadcastStatus();
      return null;
    }

    doServerSeek(targetTime);
    return null;
  });

  function doServerSeek(targetTime) {
    if (state.serverSeeking) {
      log('seek', 'Already seeking, queuing target ' + targetTime);
      state.pendingSeekTarget = targetTime;
      updateProgress();
      return;
    }

    if (!state.sessionId || !state.monitorrOrigin) {
      log('seek', 'No session/origin for server seek');
      return;
    }

    state.serverSeeking = true;
    state.pendingSeekTarget = targetTime;
    setState('seeking');

    log('seek', 'POST /seek?t=' + targetTime.toFixed(1));

    fetch(state.monitorrOrigin + '/api/cast/hls/' + state.sessionId + '/seek?t=' + targetTime.toFixed(1), {
      method: 'POST'
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (res) {
        log('seek', 'Server seek OK, offset=' + (res.offsetSeconds || targetTime));
        state.seekOffset = res.offsetSeconds || targetTime;

        var baseUrl = state.currentUrl.split('?')[0];
        var reloadUrl = baseUrl + '?seek=' + Date.now().toString(36);
        state.currentUrl = reloadUrl;

        // Destroy and reload HLS.js with new manifest
        destroyHls();

        hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          enableWorker: true,
          lowLatencyMode: false,
          startPosition: 0,
        });

        hls.loadSource(reloadUrl);
        hls.attachMedia(videoEl);

        hls.on(Hls.Events.MANIFEST_PARSED, function () {
          log('seek', 'Post-seek manifest parsed, resuming playback');
          videoEl.play().then(function () {
            var queued = state.pendingSeekTarget;
            state.serverSeeking = false;
            state.pendingSeekTarget = null;

            if (queued !== null && Math.abs(queued - state.seekOffset) > 2) {
              log('seek', 'Processing queued seek to ' + queued);
              doServerSeek(queued);
            } else {
              setState('playing');
              broadcastStatus();
            }
          }).catch(function () {
            state.serverSeeking = false;
            state.pendingSeekTarget = null;
            setState('paused');
            broadcastStatus();
          });
        });

        hls.on(Hls.Events.ERROR, function (event, data) {
          if (data.fatal) {
            log('seek', 'Fatal HLS error after seek: ' + data.details);
            state.serverSeeking = false;
            state.pendingSeekTarget = null;
            showToast('Seek playback error');
            setState('idle');
          }
        });
      })
      .catch(function (err) {
        log('seek', 'Server seek failed: ' + err.message);
        state.serverSeeking = false;
        state.pendingSeekTarget = null;
        showToast('Seek failed');
        // Keep current session alive -- don't nuke playback
        if (hls) {
          setState('playing');
        } else {
          setState('idle');
        }
        broadcastStatus();
      });
  }

  // ── PLAY interceptor ──────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.PLAY, function () {
    log('playback', 'PLAY');
    videoEl.play().catch(function () {});
    setState('playing');
    broadcastStatus();
    return null;
  });

  // ── PAUSE interceptor ─────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.PAUSE, function () {
    log('playback', 'PAUSE');
    videoEl.pause();
    setState('paused');
    broadcastStatus();
    return null;
  });

  // ── STOP interceptor ──────────────────────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.STOP, function () {
    log('playback', 'STOP');
    resetToIdle();
    broadcastStatus();
    return null;
  });

  // ── EDIT_TRACKS_INFO interceptor (CC) ─────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.EDIT_TRACKS_INFO, function (request) {
    var activeIds = request.activeTrackIds || [];
    log('subs', 'EDIT_TRACKS activeIds=' + JSON.stringify(activeIds));

    if (activeIds.length === 0) {
      disableSubs();
    } else {
      var trackId = activeIds[0];
      for (var i = 0; i < state.subtitleTracks.length; i++) {
        if (state.subtitleTracks[i].trackId === trackId) {
          enableSubs(state.subtitleTracks[i].streamIndex, trackId);
          break;
        }
      }
    }

    return null;
  });

  // ── QUEUE_NEXT / QUEUE_PREV ───────────────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.QUEUE_NEXT, function () {
    log('queue', 'QUEUE_NEXT');
    if (state.episodeNav.next) playNextEpisode();
    return null;
  });

  playerManager.setMessageInterceptor(MessageType.QUEUE_PREV, function () {
    log('queue', 'QUEUE_PREV');
    if (state.episodeNav.prev) playPrevEpisode();
    return null;
  });

  // ── MEDIA_STATUS interceptor ──────────────────────────────────────────────

  playerManager.setMessageInterceptor(MessageType.MEDIA_STATUS, function (msg) {
    if (msg && msg.status) {
      for (var i = 0; i < msg.status.length; i++) {
        var s = msg.status[i];
        s.currentTime = getCurrentTime();
        s.playerState = mapPlayerState();
        if (!s.media) s.media = {};
        s.media.duration = state.realDuration;
        s.media.streamType = cast.framework.messages.StreamType.BUFFERED;
        s.media.metadata = buildCastMetadata();
        s.media.supportedMediaCommands = getSupportedCommands();
        if (state.subtitleTracks.length > 0) {
          s.media.tracks = buildCastTracks();
          if (state.activeSubTrackId !== null) {
            s.activeTrackIds = [state.activeSubTrackId];
          } else {
            s.activeTrackIds = [];
          }
        }
        s.mediaSessionId = state.mediaSessionId;
      }
    }
    return msg;
  });

  // ── Status publisher ──────────────────────────────────────────────────────

  function broadcastStatus() {
    try {
      playerManager.broadcastStatus();
    } catch (e) {
      log('status', 'broadcastStatus error: ' + e.message);
    }
  }

  function startStatusTimer() {
    stopStatusTimer();
    statusTimer = setInterval(function () {
      if (state.playbackState === 'playing' || state.playbackState === 'paused' || state.playbackState === 'buffering') {
        updateProgress();
        broadcastStatus();
      }
    }, 2000);
  }

  function stopStatusTimer() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  // ── Duration fetch ────────────────────────────────────────────────────────

  function fetchDuration() {
    if (!state.sessionId || !state.monitorrOrigin) return;
    log('backend', 'Fetching duration for session ' + state.sessionId);

    fetch(state.monitorrOrigin + '/api/cast/hls/' + state.sessionId + '/info')
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.durationSeconds > 0) {
          state.realDuration = info.durationSeconds;
          if (info.startOffsetSeconds > 0 && state.seekOffset === 0) {
            state.seekOffset = info.startOffsetSeconds;
          }
          log('backend', 'Duration: ' + state.realDuration + 's, startOffset: ' + state.seekOffset + 's');
          updateUI();
          broadcastStatus();
        } else {
          setTimeout(fetchDuration, 3000);
        }
      })
      .catch(function () { setTimeout(fetchDuration, 5000); });
  }

  // ── Subtitle management ───────────────────────────────────────────────────

  function fetchSubtitleTracks() {
    if (!state.sessionId || !state.monitorrOrigin) return;
    log('subs', 'Fetching subtitle tracks');

    fetch(state.monitorrOrigin + '/api/cast/hls/' + state.sessionId + '/subtitles')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var tracks = data.tracks || [];
        if (tracks.length === 0) {
          log('subs', 'No subtitle tracks available');
          return;
        }

        state.subtitleTracks = [];
        for (var i = 0; i < tracks.length; i++) {
          var t = tracks[i];
          state.subtitleTracks.push({
            trackId: i + 1,
            streamIndex: t.streamIndex,
            language: t.language,
            title: t.title || t.language,
          });
        }
        log('subs', 'Found ' + state.subtitleTracks.length + ' subtitle tracks');
        broadcastStatus();
      })
      .catch(function (e) {
        log('subs', 'Failed to fetch subtitles: ' + e.message);
      });
  }

  function enableSubs(streamIndex, trackId) {
    if (!state.sessionId || !state.monitorrOrigin) return;
    log('subs', 'Enabling subtitle streamIndex=' + streamIndex);

    state.activeSubTrackId = trackId;
    updateUI();

    fetch(state.monitorrOrigin + '/api/cast/hls/' + state.sessionId + '/subs/enable?streamIndex=' + streamIndex, {
      method: 'POST'
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        log('subs', 'Subtitle enabled, reloading stream');
        reloadAfterSubChange();
      })
      .catch(function (e) {
        log('subs', 'Enable subtitle failed: ' + e.message);
        showToast('Subtitle error');
      });
  }

  function disableSubs() {
    if (!state.sessionId || !state.monitorrOrigin) return;
    log('subs', 'Disabling subtitles');

    state.activeSubTrackId = null;
    updateUI();

    fetch(state.monitorrOrigin + '/api/cast/hls/' + state.sessionId + '/subs/disable', {
      method: 'POST'
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function () {
        log('subs', 'Subtitles disabled, reloading stream');
        reloadAfterSubChange();
      })
      .catch(function (e) {
        log('subs', 'Disable subtitle failed: ' + e.message);
        showToast('Subtitle error');
      });
  }

  function reloadAfterSubChange() {
    var currentTime = getCurrentTime();
    var baseUrl = state.currentUrl.split('?')[0];
    var reloadUrl = baseUrl + '?subs=' + Date.now().toString(36);
    state.currentUrl = reloadUrl;

    if (state.mode === 'monitorr-hls') {
      destroyHls();

      hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: true,
        lowLatencyMode: false,
        startPosition: 0,
      });

      hls.loadSource(reloadUrl);
      hls.attachMedia(videoEl);

      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        videoEl.play().catch(function () {});
        broadcastStatus();
      });

      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          log('subs', 'Fatal error after sub reload: ' + data.details);
          showToast('Playback error after subtitle change');
        }
      });
    } else {
      videoEl.src = reloadUrl;
      videoEl.currentTime = currentTime;
      videoEl.play().catch(function () {});
    }
  }

  // ── Episode navigation ────────────────────────────────────────────────────

  function playNextEpisode() {
    if (!state.episodeNav.next || !state.monitorrOrigin) return;
    log('queue', 'Playing next episode: ' + state.episodeNav.next);
    showToast('Loading next episode\u2026', 6000);
    triggerEpisodeLoad(state.episodeNav.next);
  }

  function playPrevEpisode() {
    if (!state.episodeNav.prev || !state.monitorrOrigin) return;
    log('queue', 'Playing previous episode: ' + state.episodeNav.prev);
    showToast('Loading previous episode\u2026', 6000);
    triggerEpisodeLoad(state.episodeNav.prev);
  }

  function triggerEpisodeLoad(fileId) {
    // Episode navigation: request the sender/backend to start a new session.
    // We use a custom namespace message if available, otherwise the sender's
    // status poller will detect idle and can re-initiate.
    // For now, we signal via a custom message on the monitorr namespace.
    try {
      var ns = 'urn:x-cast:com.monitorr.cast';
      context.sendCustomMessage(ns, undefined, {
        type: 'PLAY_FILE',
        fileId: fileId,
      });
      log('queue', 'Sent PLAY_FILE on custom namespace for fileId=' + fileId);
    } catch (e) {
      log('queue', 'Custom namespace send failed: ' + e.message + ' -- sender must handle episode nav');
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function extractSessionId(url) {
    var match = url.match(/\/hls\/([a-f0-9]+)\//);
    return match ? match[1] : null;
  }

  function resetToIdle() {
    destroyHls();
    stopStatusTimer();
    state.mode = null;
    state.sessionId = null;
    state.currentUrl = null;
    state.realDuration = 0;
    state.seekOffset = 0;
    state.pendingSeekTarget = null;
    state.serverSeeking = false;
    state.subtitleTracks = [];
    state.activeSubTrackId = null;
    state.metadata = { title: '', subtitle: '', posterUrl: null };
    state.episodeNav = { next: null, prev: null };
    setState('idle');
  }

  function mapPlayerState() {
    switch (state.playbackState) {
      case 'playing': return cast.framework.messages.PlayerState.PLAYING;
      case 'paused': return cast.framework.messages.PlayerState.PAUSED;
      case 'buffering':
      case 'loading':
      case 'seeking': return cast.framework.messages.PlayerState.BUFFERING;
      default: return cast.framework.messages.PlayerState.IDLE;
    }
  }

  function getSupportedCommands() {
    var Cmd = cast.framework.messages.Command;
    var cmds = Cmd.PAUSE | Cmd.SEEK | Cmd.STREAM_VOLUME | Cmd.STREAM_MUTE;
    if (state.episodeNav.next) cmds |= Cmd.QUEUE_NEXT;
    if (state.episodeNav.prev) cmds |= Cmd.QUEUE_PREV;
    return cmds;
  }

  function buildCastMetadata() {
    var m = new cast.framework.messages.GenericMediaMetadata();
    m.title = state.metadata.title;
    m.subtitle = state.metadata.subtitle;
    if (state.metadata.posterUrl) {
      var img = new cast.framework.messages.Image(state.metadata.posterUrl);
      m.images = [img];
    }
    return m;
  }

  function buildCastTracks() {
    var tracks = [];
    for (var i = 0; i < state.subtitleTracks.length; i++) {
      var t = state.subtitleTracks[i];
      var ct = new cast.framework.messages.Track(t.trackId, cast.framework.messages.TrackType.TEXT);
      ct.subType = cast.framework.messages.TextTrackType.SUBTITLES;
      ct.name = t.title;
      ct.language = t.language;
      tracks.push(ct);
    }
    return tracks;
  }

  // ── UI button handlers ────────────────────────────────────────────────────

  elBtnPlayPause.addEventListener('click', function () {
    if (state.playbackState === 'playing') {
      videoEl.pause();
      setState('paused');
    } else {
      videoEl.play().catch(function () {});
      setState('playing');
    }
    broadcastStatus();
  });

  elBtnRw.addEventListener('click', function () {
    var target = Math.max(0, getCurrentTime() - 30);
    log('ui', 'Rewind 30s -> ' + target);
    showTransport();
    if (state.mode === 'direct') {
      videoEl.currentTime = target;
      broadcastStatus();
    } else {
      doServerSeek(target);
    }
  });

  elBtnFf.addEventListener('click', function () {
    var target = Math.min(state.realDuration || Infinity, getCurrentTime() + 30);
    log('ui', 'Forward 30s -> ' + target);
    showTransport();
    if (state.mode === 'direct') {
      videoEl.currentTime = target;
      broadcastStatus();
    } else {
      doServerSeek(target);
    }
  });

  elBtnPrev.addEventListener('click', function () {
    if (state.episodeNav.prev) playPrevEpisode();
  });

  elBtnNext.addEventListener('click', function () {
    if (state.episodeNav.next) playNextEpisode();
  });

  elBtnCc.addEventListener('click', function () {
    if (state.subtitleTracks.length === 0) {
      showToast('No subtitles available');
      return;
    }
    if (state.activeSubTrackId !== null) {
      disableSubs();
    } else {
      var first = state.subtitleTracks[0];
      enableSubs(first.streamIndex, first.trackId);
    }
  });

  // ── Start CAF ─────────────────────────────────────────────────────────────

  var opts = new cast.framework.CastReceiverOptions();
  opts.skipPlayersLoad = true;
  opts.disableIdleTimeout = true;
  opts.maxInactivity = 3600;

  try {
    opts.customNamespaces = {};
    opts.customNamespaces['urn:x-cast:com.monitorr.cast'] = cast.framework.system.MessageType.JSON;
  } catch (e) {
    log('lifecycle', 'Custom namespace registration failed: ' + e.message);
  }

  context.start(opts);
  setState('idle');
  log('lifecycle', 'Monitorr Cast Receiver v1.0.0 started (skipPlayersLoad=true)');

})();
