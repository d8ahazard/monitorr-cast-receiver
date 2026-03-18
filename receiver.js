'use strict';

// ─── Monitorr Cast Receiver v2.4.5 ──────────────────────────────────────────
//
// Uses PlayerManager interceptors (not custom namespace for media).
// The SDK owns the media state machine and UI. We own the player (HLS.js)
// and intercept LOAD/SEEK/PLAY/PAUSE to control it.
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  var VERSION = '2.4.5';
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
  var btnPlayPause = document.getElementById('mr-btn-playpause');
  var iconPlay = document.getElementById('mr-icon-play');
  var iconPause = document.getElementById('mr-icon-pause');
  var btnRw = document.getElementById('mr-btn-rw');
  var btnFf = document.getElementById('mr-btn-ff');
  var seekRow = document.querySelector('.mr-seek-row');
  var seekTrack = document.querySelector('.mr-seek-track');
  var seekPreview = document.getElementById('mr-seek-preview');

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

  // ── PLAY / PAUSE Interceptors ─────────────────────────────────────────────

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.PLAY,
    function () {
      console.log(TAG, 'PLAY intercepted');
      video.play().catch(function () {});
      flashOverlay();
      return null;
    }
  );

  playerManager.setMessageInterceptor(
    cast.framework.messages.MessageType.PAUSE,
    function () {
      console.log(TAG, 'PAUSE intercepted');
      video.pause();
      flashOverlay();
      return null;
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
            reapplySubtitlesAfterSeek();
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

          if (serverSeeking || seekLockedTime !== null) {
            s.playerState = cast.framework.messages.PlayerState.BUFFERING;
            s.currentTime = seekLockedTime !== null ? seekLockedTime : seekOffset;
          } else if (video && currentUrl) {
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
    video.pause();
    video.removeAttribute('src');
    video.load();
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

  // ── Subtitles (lazy sidecar WebVTT) ───────────────────────────────────────

  var vttCache = {};
  var activeTextTrack = null;
  var subExtractPollTimer = null;
  var subExtractRequested = false;
  var pendingSubIdx = -1;

  function fetchSubtitleTracks() {
    if (!hlsSessionId || !monitorrOrigin) return;
    vttCache = {};
    activeSubIndex = -1;
    subExtractRequested = false;
    pendingSubIdx = -1;

    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subtitles')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        subtitleTracks = data.tracks || [];
        console.log(TAG, 'Subtitle tracks:', subtitleTracks.length);
        updateCCButton();

        var defaultIdx = -1;
        for (var i = 0; i < subtitleTracks.length; i++) {
          if (subtitleTracks[i].isDefault) { defaultIdx = i; break; }
        }
        if (defaultIdx >= 0) {
          console.log(TAG, 'Auto-enabling default sub:', subtitleTracks[defaultIdx].language);
          requestSubtitle(defaultIdx);
        }
      })
      .catch(function () { subtitleTracks = []; updateCCButton(); });
  }

  function requestSubtitle(idx) {
    if (idx < 0 || idx >= subtitleTracks.length) return;

    activeSubIndex = idx;
    pendingSubIdx = idx;
    updateCCButton();

    if (vttCache[idx]) {
      applyCuesForOffset(idx);
      pendingSubIdx = -1;
      updateCCButton();
      return;
    }

    var track = subtitleTracks[idx];
    if (track.vttReady) {
      fetchAndCacheVtt(idx, track, function () {
        if (pendingSubIdx === idx) {
          applyCuesForOffset(idx);
          pendingSubIdx = -1;
          updateCCButton();
        }
      });
      return;
    }

    if (!subExtractRequested) {
      subExtractRequested = true;
      console.log(TAG, 'Requesting subtitle extraction');
      fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subs/extract', { method: 'POST' })
        .catch(function () {});
    }

    pollForVttReady(idx);
  }

  function pollForVttReady(idx) {
    clearTimeout(subExtractPollTimer);
    if (!hlsSessionId || !monitorrOrigin) return;

    fetch(monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/subtitles')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        subtitleTracks = data.tracks || [];
        updateCCButton();

        var track = subtitleTracks[idx];
        if (track && track.vttReady) {
          console.log(TAG, 'VTT ready for', track.language);
          fetchAndCacheVtt(idx, track, function () {
            if (pendingSubIdx === idx) {
              applyCuesForOffset(idx);
              pendingSubIdx = -1;
              updateCCButton();
            }
          });
        } else {
          subExtractPollTimer = setTimeout(function () { pollForVttReady(idx); }, 2000);
        }
      })
      .catch(function () {
        subExtractPollTimer = setTimeout(function () { pollForVttReady(idx); }, 2000);
      });
  }

  function fetchAndCacheVtt(idx, trackInfo, onDone) {
    var url = monitorrOrigin + trackInfo.vttUrl;
    fetch(url)
      .then(function (r) { return r.text(); })
      .then(function (vttText) {
        vttCache[idx] = parseVttCues(vttText);
        console.log(TAG, 'Cached VTT:', trackInfo.language, vttCache[idx].length, 'cues');
        if (onDone) onDone();
      })
      .catch(function (e) {
        console.log(TAG, 'Failed to fetch VTT:', trackInfo.language, e.message);
        if (onDone) onDone();
      });
  }

  function parseVttCues(vttText) {
    var cues = [];
    var lines = vttText.split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i].trim();
      var match = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (!match) { i++; continue; }
      var startSec = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
      var endSec = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
      i++;
      var text = [];
      while (i < lines.length && lines[i].trim() !== '') {
        text.push(lines[i].trim());
        i++;
      }
      if (text.length > 0) {
        cues.push({ start: startSec, end: endSec, text: text.join('\n') });
      }
      i++;
    }
    return cues;
  }

  function removeAllTextTracks() {
    activeTextTrack = null;
    for (var i = video.textTracks.length - 1; i >= 0; i--) {
      video.textTracks[i].mode = 'disabled';
    }
    var tracks = video.querySelectorAll('track');
    for (var j = tracks.length - 1; j >= 0; j--) {
      tracks[j].parentNode.removeChild(tracks[j]);
    }
  }

  function applyCuesForOffset(trackIdx) {
    removeAllTextTracks();
    if (trackIdx < 0 || !vttCache[trackIdx]) return;

    var cues = vttCache[trackIdx];
    var offset = seekOffset;
    var textTrack = video.addTextTrack('subtitles', subtitleTracks[trackIdx].language, subtitleTracks[trackIdx].language);
    textTrack.mode = 'showing';
    activeTextTrack = textTrack;

    for (var i = 0; i < cues.length; i++) {
      var adjusted_start = cues[i].start - offset;
      var adjusted_end = cues[i].end - offset;
      if (adjusted_end <= 0) continue;
      if (adjusted_start < 0) adjusted_start = 0;
      try {
        textTrack.addCue(new VTTCue(adjusted_start, adjusted_end, cues[i].text));
      } catch (e) {}
    }
    console.log(TAG, 'Applied', textTrack.cues ? textTrack.cues.length : 0, 'cues at offset', offset);
  }

  function reapplySubtitlesAfterSeek() {
    if (activeSubIndex >= 0 && vttCache[activeSubIndex]) {
      applyCuesForOffset(activeSubIndex);
    }
  }

  function cycleSubtitle() {
    if (subtitleTracks.length === 0) return;
    var next = activeSubIndex + 1;
    if (next >= subtitleTracks.length) next = -1;

    if (next < 0) {
      activeSubIndex = -1;
      pendingSubIdx = -1;
      clearTimeout(subExtractPollTimer);
      removeAllTextTracks();
      updateCCButton();
      console.log(TAG, 'Subtitles off');
      return;
    }

    requestSubtitle(next);
  }

  function updateCCButton() {
    if (!btnCC) return;
    if (subtitleTracks.length === 0) { btnCC.style.display = 'none'; return; }
    btnCC.style.display = 'flex';

    if (pendingSubIdx >= 0 && !vttCache[pendingSubIdx]) {
      btnCC.classList.add('active');
      if (ccLabel) ccLabel.textContent = '...';
    } else if (activeSubIndex >= 0 && subtitleTracks[activeSubIndex]) {
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

  if (btnPlayPause) btnPlayPause.addEventListener('click', function () {
    if (video.paused) video.play().catch(function () {});
    else video.pause();
    playerManager.broadcastStatus();
  });

  if (btnRw) btnRw.addEventListener('click', function () { tapSeek(-5); });
  if (btnFf) btnFf.addEventListener('click', function () { tapSeek(10); });

  function updatePlayPauseIcon() {
    if (!iconPlay || !iconPause) return;
    iconPlay.style.display = video.paused ? '' : 'none';
    iconPause.style.display = video.paused ? 'none' : '';
  }
  video.addEventListener('play', function () { updatePlayPauseIcon(); startProgressReporting(); });
  video.addEventListener('pause', function () { updatePlayPauseIcon(); reportProgress(); });
  video.addEventListener('playing', updatePlayPauseIcon);

  video.addEventListener('timeupdate', function () {
    var total = realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);

    if (seekInteractionActive || serverSeeking || seekLockedTime !== null) {
      var frozen = seekPreviewTime !== null ? seekPreviewTime :
                   seekLockedTime !== null ? seekLockedTime : getCurrentPlaybackTime();
      if (timeLeft) timeLeft.textContent = formatTime(frozen);
      if (timeRight) timeRight.textContent = formatTime(total);
      if (total > 0 && seekPlayed) seekPlayed.style.width = Math.min(100, (frozen / total) * 100) + '%';
      return;
    }

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
    if (!serverSeeking) { reportProgress(); stopProgressReporting(); destroyHls(); showIdle(); }
  });

  function updateMetadata() {
    if (!lastMetadata) return;
    if (metaTitle) metaTitle.textContent = lastMetadata.title || '';
    if (metaSubtitle) metaSubtitle.textContent = lastMetadata.subtitle || '';

    var posterSrc = null;
    if (customData && customData.posterUrl) posterSrc = customData.posterUrl;
    else if (lastMetadata.images && lastMetadata.images.length > 0) posterSrc = lastMetadata.images[0].url;

    if (posterSrc && metaPoster) {
      metaPoster.src = posterSrc;
      metaPoster.style.display = 'block';
    } else if (metaPoster) { metaPoster.style.display = 'none'; }
  }

  function flashOverlay() {
    if (overlay) overlay.classList.add('visible');
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(function () { if (overlay) overlay.classList.remove('visible'); }, 6000);
  }

  // ── Tap on video for play/pause ─────────────────────────────────────────

  if (playerScreen) {
    var tapStart = null;
    playerScreen.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.mr-bottom') || e.target.closest('#mr-spinner')) return;
      tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    playerScreen.addEventListener('pointerup', function (e) {
      if (!tapStart) return;
      var dx = Math.abs(e.clientX - tapStart.x);
      var dy = Math.abs(e.clientY - tapStart.y);
      var dt = Date.now() - tapStart.t;
      tapStart = null;
      if (dx > 20 || dy > 20 || dt > 400) return;
      if (e.target.closest('.mr-bottom') || e.target.closest('#mr-spinner')) return;

      if (isOverlayVisible()) {
        hideOverlayNow();
      } else {
        if (video.paused) video.play().catch(function () {});
        else video.pause();
        playerManager.broadcastStatus();
        flashOverlay();
      }
    });
  }

  // ── Seek track pointer/touch interaction ────────────────────────────────

  if (seekTrack) {
    var dragging = false;
    var dragCommitTimer = null;

    function pointerPctToTime(e) {
      var rect = seekTrack.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var duration = getDuration();
      return pct * duration;
    }

    seekTrack.style.cursor = 'pointer';

    seekTrack.addEventListener('pointerdown', function (e) {
      var duration = getDuration();
      if (duration <= 0) return;
      e.preventDefault();
      dragging = true;
      seekTrack.setPointerCapture(e.pointerId);

      beginSeekInteraction();
      seekPreviewTime = pointerPctToTime(e);
      updateSeekPreviewVisuals();
      flashOverlay();
    });

    seekTrack.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      e.preventDefault();
      seekPreviewTime = pointerPctToTime(e);
      updateSeekPreviewVisuals();
    });

    seekTrack.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      seekPreviewTime = pointerPctToTime(e);
      updateSeekPreviewVisuals();

      clearTimeout(dragCommitTimer);
      dragCommitTimer = setTimeout(function () {
        commitSeekPreview();
      }, 400);
    });

    seekTrack.addEventListener('pointercancel', function () {
      if (dragging) {
        dragging = false;
        cancelSeekPreview();
      }
    });
  }

  // ── D-pad navigation: two rows (seek / buttons) ────────────────────────────

  var allButtons = [btnSkipPrev, btnRw, btnPlayPause, btnFf, btnCC, btnSkipNext];
  var focusIndex = -1;
  var activeRow = 'buttons'; // 'buttons' or 'seek'

  function getVisibleButtons() {
    var out = [];
    for (var i = 0; i < allButtons.length; i++) {
      var b = allButtons[i];
      if (!b) continue;
      if (b.style.display === 'none' || b.offsetParent === null) continue;
      out.push(b);
    }
    return out;
  }

  function clearAllFocus() {
    for (var i = 0; i < allButtons.length; i++) {
      if (allButtons[i]) allButtons[i].classList.remove('mr-focused');
    }
    if (seekRow) seekRow.classList.remove('mr-focused');
    focusIndex = -1;
  }

  function setButtonFocus(idx) {
    var btns = getVisibleButtons();
    if (btns.length === 0) return;
    clearAllFocus();
    activeRow = 'buttons';
    focusIndex = ((idx % btns.length) + btns.length) % btns.length;
    btns[focusIndex].classList.add('mr-focused');
    btns[focusIndex].focus();
  }

  function setSeekRowFocus() {
    clearAllFocus();
    activeRow = 'seek';
    if (seekRow) seekRow.classList.add('mr-focused');
  }

  function showOverlayAndFocus() {
    flashOverlay();
    var btns = getVisibleButtons();
    if (btns.length > 0) {
      var ppIdx = -1;
      for (var i = 0; i < btns.length; i++) {
        if (btns[i] === btnPlayPause) { ppIdx = i; break; }
      }
      setButtonFocus(ppIdx >= 0 ? ppIdx : Math.floor(btns.length / 2));
    }
  }

  function hideOverlayNow() {
    if (overlay) overlay.classList.remove('visible');
    clearTimeout(overlayTimer);
    clearAllFocus();
    var activeEl = document.activeElement;
    if (activeEl && activeEl !== document.body && typeof activeEl.blur === 'function') activeEl.blur();
  }

  function isOverlayVisible() {
    return overlay && overlay.classList.contains('visible');
  }

  function normalizeRemoteKey(e) {
    var key = e.key || e.code || '';
    var code = e.keyCode || e.which || 0;
    if (key === 'Up' || key === 'UIUp' || key === 'DPAD_UP' || key === 'NAVIGATE_UP') return 'ArrowUp';
    if (key === 'Down' || key === 'UIDown' || key === 'DPAD_DOWN' || key === 'NAVIGATE_DOWN') return 'ArrowDown';
    if (key === 'Left' || key === 'UILeft' || key === 'DPAD_LEFT' || key === 'NAVIGATE_LEFT') return 'ArrowLeft';
    if (key === 'Right' || key === 'UIRight' || key === 'DPAD_RIGHT' || key === 'NAVIGATE_RIGHT') return 'ArrowRight';
    if (key === 'Back' || key === 'GoBack' || key === 'BrowserBack' || key === 'XF86Back') return 'Backspace';
    if (key === 'Select') return 'Enter';
    if (code === 4 || code === 461 || code === 27 || code === 8) return 'Backspace';
    if (code === 13 || code === 23 || code === 66) return 'Enter';
    if (code === 32) return ' ';
    if (code === 179) return 'MediaPlayPause';
    if (code === 415) return 'MediaPlay';
    if (code === 19 || code === 38) return 'ArrowUp';
    if (code === 20 || code === 40) return 'ArrowDown';
    if (code === 21 || code === 37) return 'ArrowLeft';
    if (code === 22 || code === 39) return 'ArrowRight';
    return key;
  }

  function isOwnedRemoteKey(key) {
    return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' ||
      key === 'Enter' || key === 'Backspace' || key === 'Escape' ||
      key === 'MediaPlayPause' || key === 'MediaPlay' || key === ' ';
  }

  function consumeKeyEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  }

  function getCurrentPlaybackTime() {
    return seekOffset + (video.currentTime || 0);
  }

  function getDuration() {
    return realDuration > 0 ? realDuration : (isFinite(video.duration) ? video.duration : 0);
  }

  // ── Seek interaction state ──────────────────────────────────────────────

  var seekPreviewTime = null;
  var seekHoldCount = 0;
  var seekLockedTime = null;
  var seekKeepaliveTimer = null;
  var seekDebounceTimer = null;
  var seekInteractionActive = false;

  function startSeekKeepalive() {
    stopSeekKeepalive();
    seekKeepaliveTimer = setInterval(function () {
      try { playerManager.broadcastStatus(); } catch (e) {}
    }, 1000);
    try { playerManager.broadcastStatus(); } catch (e) {}
  }

  function stopSeekKeepalive() {
    if (seekKeepaliveTimer) {
      clearInterval(seekKeepaliveTimer);
      seekKeepaliveTimer = null;
    }
  }

  function beginSeekInteraction() {
    if (!seekInteractionActive) {
      seekInteractionActive = true;
      seekPreviewTime = getCurrentPlaybackTime();
    }
  }

  function isSeekActive() {
    return seekInteractionActive || seekPreviewTime !== null;
  }

  function getSeekStep() {
    if (seekHoldCount < 3) return 5;
    if (seekHoldCount < 8) return 10;
    if (seekHoldCount < 15) return 30;
    if (seekHoldCount < 25) return 60;
    return 120;
  }

  function updateSeekPreviewVisuals() {
    var duration = getDuration();
    if (duration <= 0 || seekPreviewTime === null) return;
    if (seekPreview) {
      seekPreview.classList.add('active');
      seekPreview.style.width = (seekPreviewTime / duration * 100) + '%';
    }
    if (timeLeft) timeLeft.textContent = formatTime(seekPreviewTime);
    if (duration > 0 && seekPlayed) seekPlayed.style.width = Math.min(100, (seekPreviewTime / duration) * 100) + '%';
  }

  function nudgeSeekPreview(direction) {
    var duration = getDuration();
    if (duration <= 0) return;

    beginSeekInteraction();
    var step = getSeekStep();
    seekHoldCount++;

    seekPreviewTime += direction * step;
    seekPreviewTime = Math.max(0, Math.min(duration, seekPreviewTime));
    updateSeekPreviewVisuals();
  }

  function tapSeek(deltaSeconds) {
    var duration = getDuration();
    if (duration <= 0) return;

    beginSeekInteraction();
    seekPreviewTime += deltaSeconds;
    seekPreviewTime = Math.max(0, Math.min(duration, seekPreviewTime));
    updateSeekPreviewVisuals();

    clearTimeout(seekDebounceTimer);
    seekDebounceTimer = setTimeout(function () {
      commitSeekPreview();
    }, 800);
  }

  function cancelSeekPreview() {
    clearTimeout(seekDebounceTimer);
    seekPreviewTime = null;
    seekHoldCount = 0;
    seekInteractionActive = false;
    if (seekPreview) {
      seekPreview.classList.remove('active');
      seekPreview.style.width = '0';
    }
  }

  function commitSeekPreview() {
    clearTimeout(seekDebounceTimer);
    if (seekPreviewTime === null) return;
    var target = seekPreviewTime;
    cancelSeekPreview();
    commitSeek(target);
  }

  function commitSeek(target) {
    if (isHlsContent && hlsSessionId && monitorrOrigin) {
      if (serverSeeking) return;
      serverSeeking = true;
      seekLockedTime = target;
      startSeekKeepalive();
      video.pause();
      showSpinner();
      var seekUrl = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/seek?t=' + target.toFixed(1);
      fetch(seekUrl, { method: 'POST' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (res) {
          seekOffset = res.offsetSeconds || target;
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
            seekLockedTime = null;
            stopSeekKeepalive();
            hideSpinner();
            playerManager.broadcastStatus();
            flashOverlay();
            reapplySubtitlesAfterSeek();
          });
          newHls.on(Hls.Events.ERROR, function (_, e) {
            if (e.fatal) {
              if (e.type === Hls.ErrorTypes.NETWORK_ERROR) newHls.startLoad();
              else if (e.type === Hls.ErrorTypes.MEDIA_ERROR) newHls.recoverMediaError();
            }
          });
          setTimeout(function () { if (serverSeeking) { serverSeeking = false; seekLockedTime = null; stopSeekKeepalive(); video.play().catch(function () {}); hideSpinner(); } }, 12000);
        })
        .catch(function () {
          serverSeeking = false;
          seekLockedTime = null;
          stopSeekKeepalive();
          hideSpinner();
          video.play().catch(function () {});
        });
      return;
    }

    video.currentTime = target;
    seekLockedTime = null;
    playerManager.broadcastStatus();
    flashOverlay();
  }

  function seekByDelta(deltaSeconds) {
    var target = getCurrentPlaybackTime() + deltaSeconds;
    var duration = getDuration();
    if (duration > 0) target = Math.min(duration, target);
    target = Math.max(0, target);
    commitSeek(target);
  }

  window.addEventListener('keydown', function (e) {
    var key = normalizeRemoteKey(e);
    if (!isOwnedRemoteKey(key)) return;

    if (!isOverlayVisible() && (key === 'Backspace' || key === 'Escape')) {
      consumeKeyEvent(e);
      video.pause();
      killServerSession();
      destroyHls();
      showIdle();
      context.stop();
      return;
    }

    consumeKeyEvent(e);

    if (!isOverlayVisible()) {
      showOverlayAndFocus();
      return;
    }

    flashOverlay();

    if (key === 'ArrowUp') {
      if (activeRow === 'buttons') {
        cancelSeekPreview();
        setSeekRowFocus();
      }
      return;
    }

    if (key === 'ArrowDown') {
      if (activeRow === 'seek') {
        cancelSeekPreview();
        var btns = getVisibleButtons();
        var ppIdx = -1;
        for (var i = 0; i < btns.length; i++) { if (btns[i] === btnPlayPause) { ppIdx = i; break; } }
        setButtonFocus(ppIdx >= 0 ? ppIdx : Math.floor(btns.length / 2));
      } else {
        hideOverlayNow();
      }
      return;
    }

    if (key === 'ArrowLeft') {
      if (activeRow === 'seek') {
        nudgeSeekPreview(-1);
      } else {
        setButtonFocus(focusIndex <= 0 ? getVisibleButtons().length - 1 : focusIndex - 1);
      }
      return;
    }

    if (key === 'ArrowRight') {
      if (activeRow === 'seek') {
        nudgeSeekPreview(1);
      } else {
        setButtonFocus(focusIndex + 1);
      }
      return;
    }

    if (key === 'Enter') {
      if (activeRow === 'seek') {
        if (isSeekActive()) {
          clearTimeout(seekDebounceTimer);
          commitSeekPreview();
        }
      } else {
        var btns2 = getVisibleButtons();
        if (focusIndex >= 0 && focusIndex < btns2.length) btns2[focusIndex].click();
      }
      return;
    }

    if (key === 'Backspace' || key === 'Escape') {
      if (isSeekActive()) {
        cancelSeekPreview();
      } else if (isOverlayVisible()) {
        hideOverlayNow();
      }
      return;
    }

    if (key === 'MediaPlayPause' || key === ' ' || key === 'MediaPlay') {
      if (video.paused) video.play().catch(function () {});
      else video.pause();
      playerManager.broadcastStatus();
      return;
    }
  }, true);

  window.addEventListener('keyup', function (e) {
    var key = normalizeRemoteKey(e);
    if (!isOwnedRemoteKey(key)) return;
    consumeKeyEvent(e);
  }, true);
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

  function killServerSession() {
    if (hlsSessionId && monitorrOrigin) {
      var pos = Math.floor(getCurrentPlaybackTime() * 1000);
      var dur = realDuration > 0 ? Math.floor(realDuration * 1000) : 0;
      var url = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/kill';
      if (pos > 0 && dur > 0) url += '?positionMs=' + pos + '&durationMs=' + dur;
      console.log(TAG, 'Killing server session:', hlsSessionId, 'at', pos, 'ms');
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send();
      } catch (e) {
        console.log(TAG, 'Kill XHR failed, trying fetch:', e.message);
        fetch(url, { keepalive: true }).catch(function () {});
      }
    }
  }

  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function (e) {
    console.log(TAG, 'Sender disconnected:', e.senderId);
    if (context.getSenders().length === 0) {
      console.log(TAG, 'No senders remaining, shutting down');
      video.pause();
      killServerSession();
      destroyHls();
      showIdle();
      context.stop();
    }
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

  window.addEventListener('beforeunload', function () {
    reportProgressFinal();
    video.pause();
    killServerSession();
    destroyHls();
  });

  // ── Progress Reporting ──────────────────────────────────────────────────

  var progressTimer = null;

  function startProgressReporting() {
    stopProgressReporting();
    progressTimer = setInterval(reportProgress, 15000);
  }

  function stopProgressReporting() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }

  function reportProgress() {
    if (!monitorrOrigin || !hlsSessionId) return;
    if (video.paused && !video.ended) return;
    var pos = Math.floor(getCurrentPlaybackTime() * 1000);
    var dur = realDuration > 0 ? Math.floor(realDuration * 1000) : 0;
    if (pos <= 0 || dur <= 0) return;
    var url = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/progress';
    var body = JSON.stringify({ positionMs: pos, durationMs: dur });
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body }).catch(function () {});
  }

  function reportProgressFinal() {
    if (!monitorrOrigin || !hlsSessionId) return;
    var pos = Math.floor(getCurrentPlaybackTime() * 1000);
    var dur = realDuration > 0 ? Math.floor(realDuration * 1000) : 0;
    if (pos <= 0 || dur <= 0) return;
    var url = monitorrOrigin + '/api/cast/hls/' + hlsSessionId + '/progress';
    var body = JSON.stringify({ positionMs: pos, durationMs: dur });
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
    } catch (e) {}
  }

  context.start(opts);
  console.log(TAG, 'Receiver started');
  showIdle();

})();
