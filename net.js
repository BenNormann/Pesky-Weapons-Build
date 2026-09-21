/*
 * Pesky Weapons — net.js
 * The single JavaScript networking layer, ported from After Hours M0.
 *
 * Exposes exactly one global: window.AH_Net (the name is kept so the
 * verified AHNet.jslib bridge is untouched).
 * Public API (called from Unity via AHNet.jslib, or from a spike page):
 *   start(roomCode, isHost)   join a room
 *   leave()
 *   broadcast(payloadB64)     send to all peers
 *   sendTo(peerId, payloadB64)
 *   getSelfId()               -> string
 *   getPeerIds()              -> JSON array string
 *   voiceSetMode(mode)        0 OFF, 1 OPEN MIC, 2 VOICE AUTO
 *   voiceSetPeerVolume(peerId, gain)   0..1, from Unity's proximity math
 *   voiceSetThreshold(dbfs)   VAD gate (default -42)
 * Internal (not part of the spec surface, needed for event plumbing):
 *   unityReady()              Unity's NetBridge signals it can receive SendMessage
 *   setLocalSink(fn)          a no-Unity spike page registers fn(method, argString)
 *
 * Events go out as (method, stringArg) pairs:
 *   OnNetReady(selfId) | OnNetError(msg) | OnPeerJoined(id) | OnPeerLeft(id)
 *   OnNetMessage("<peerId>|<payloadB64>")
 *   OnVoiceActivity('1'|'0') | OnVoiceError(msg)
 * For Unity they become SendMessage("NetBridge", method, arg). Events are
 * buffered until a sink is live — Unity's WASM finishes loading after this
 * script runs, and dropped first packets look exactly like network faults.
 *
 * Changes from After Hours, and only these:
 *   - APP_ID and the room-name prefix are Pesky Weapons' own.
 *   - Wall-clock peer liveness: OnPeerJoined / OnPeerLeft are owned here.
 *     Every received payload stamps its sender; 15 s of silence is one
 *     OnPeerLeft, a later packet is OnPeerJoined again.
 *   - Host-only relay refresh on a 3-minute wall clock (see that section
 *     for why it is a socket recycle and not a hand-rolled announce).
 *
 * Requires trystero.min.js (nostr strategy, vendored) loaded first.
 */
(function () {
  'use strict';

  // Unique app namespace so our rooms never collide with another trystero
  // app (After Hours included: the relays are shared public infrastructure).
  var APP_ID = 'pesky-weapons-9d4kv2';
  var ROOM_PREFIX = 'PESKY-';
  // One action for everything; the payload's first byte discriminates.
  // Action names are limited to 12 bytes.
  var ACTION = 'st';
  var RELAY_REDUNDANCY = 4; // public relays churn; redundancy keeps rooms forming
  // ICE is STUN only, by design: the game is peer to peer and never relays
  // through a server. STUN tells each browser its own outside address so the
  // two can punch through their routers; several servers raise the odds of a
  // usable answer. When both routers are symmetric no direct path exists and
  // the diagnosis below says so.
  var ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  // index.html may override ICE (a TURN relay for symmetric NAT and phone
  // hotspots) by defining window.PESKY_ICE_SERVERS; the constant above is the
  // fallback. ATCK defined the page global but never read it; we read it.
  function iceServers() {
    try {
      var fromPage = (typeof window !== 'undefined') ? window.PESKY_ICE_SERVERS : null;
      if (fromPage && fromPage.length) return fromPage;
    } catch (e) { }
    return ICE_SERVERS;
  }

  // Connection diagnosis: what each side gathered and how the attempt ended,
  // logged on the console and folded into the join error so a failure names
  // its cause (no reflexive address = STUN blocked; both sides reflexive but
  // no pair = symmetric NAT on at least one side; IPv6 on both = should work).
  var iceDiag = {};           // peerId -> { local: {host,srflx,prflx,v6}, remote: {...}, state }
  function diagFor(peerId) {
    if (!iceDiag[peerId]) iceDiag[peerId] = { local: { host: 0, srflx: 0, prflx: 0, v6: 0, mdns: 0 }, remote: { host: 0, srflx: 0, prflx: 0, v6: 0, mdns: 0 }, state: 'new' };
    return iceDiag[peerId];
  }
  function countCandidate(bucket, cand) {
    if (!cand) return;
    var type = cand.type || (cand.candidate && / typ (\w+)/.exec(cand.candidate) || [])[1];
    if (type && bucket.hasOwnProperty(type)) bucket[type]++;
    var addr = cand.address || (cand.candidate && cand.candidate.split(' ')[4]) || '';
    if (type === 'host' && /\.local$/i.test(addr)) bucket.mdns++;
    if (addr.indexOf(':') >= 0) bucket.v6++;
  }
  function describe(b) {
    return 'host ' + b.host + (b.mdns ? ' (' + b.mdns + ' hidden as .local)' : '') + ', reflexive ' + b.srflx + ', peer-reflexive ' + b.prflx + ', ipv6 ' + b.v6;
  }
  // trystero keeps a pool of spare connections that never talk to anybody: they sit in state new with
  // nothing from the other side, and they are not failures.
  function meaningful(d) {
    return !!d && (d.state !== 'new' || d.remote.host + d.remote.srflx + d.remote.prflx > 0);
  }
  function rank(d) {
    if (d.state === 'connected' || d.state === 'completed') return 4;
    if (d.state === 'failed') return 3;
    if (d.state === 'checking' || d.state === 'disconnected') return 2;
    return 1;
  }
  function bestDiagnosis() {
    var best = null;
    Object.keys(iceDiag).forEach(function (id) {
      var d = iceDiag[id];
      if (meaningful(d) && (!best || rank(d) > rank(iceDiag[best]))) best = id;
    });
    return best ? diagnose(best) : 'no connection attempt got as far as trading addresses with the other player';
  }
  function diagnose(peerId) {
    var d = iceDiag[peerId];
    if (!d) return 'no ICE data';
    if (d.state === 'connected' || d.state === 'completed') {
      return 'the two machines DID connect (local [' + describe(d.local) + '] remote [' + describe(d.remote) + ']); what failed came after it: the hello between the two pages did not finish in time. Try once more, and if it repeats press COPY NETWORK LOG on both machines';
    }
    var why;
    if (d.local.srflx === 0 && d.local.host > 0) why = 'this browser got no reflexive address: STUN (UDP 19302/3478) is blocked on this network';
    else if (d.remote.srflx === 0 && d.remote.host > 0 && d.remote.v6 === 0) why = 'the other browser sent no reflexive address: STUN is blocked on its network';
    else if (d.local.srflx > 0 && d.remote.srflx > 0) why = 'both sides had reflexive addresses but no pair connected: symmetric NAT on at least one side (phone hotspot, office or campus network); a direct path does not exist between these two networks';
    else why = 'candidates never arrived from the other side: the offer reached it over the relays but its answer or candidates did not come back';
    var hidden = (d.local.host > 0 && d.local.mdns >= d.local.host) || (d.remote.host > 0 && d.remote.mdns >= d.remote.host);
    if (hidden) why += '. Local addresses were hidden behind .local names on at least one side, which school and office networks cannot look up: '
      + 'allow the microphone for this page on BOTH machines and join again, so the browsers trade real addresses (this is what the same Wi-Fi or a shared hotspot needs)';
    return 'local [' + describe(d.local) + '] remote [' + describe(d.remote) + '] state ' + d.state + ': ' + why;
  }
  function watchPeerConnection(peerId, pc) {
    if (!pc || pc.__atckWatched) return;
    pc.__atckWatched = true;
    pc.__atckKey = peerId;
    var d = diagFor(peerId);
    pc.addEventListener('icecandidate', function (e) { countCandidate(d.local, e.candidate); });
    pc.addEventListener('iceconnectionstatechange', function () {
      d.state = pc.iceConnectionState;
      log('ice', pc.__atckKey, d.state);
      if (d.state === 'connected' || d.state === 'completed') reportSelectedPair(peerId, pc);
      if (d.state === 'failed') { remember('warn', ['ice failed', pc.__atckKey, diagnose(pc.__atckKey)]); console.warn(TAG, 'ice failed', pc.__atckKey, diagnose(pc.__atckKey)); }
    });
    var origAdd = pc.addIceCandidate.bind(pc);
    pc.addIceCandidate = function (cand) { countCandidate(d.remote, cand); return origAdd(cand); };
    var origSet = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = function (desc) {
      try {
        var sdp = desc && desc.sdp ? desc.sdp : '';
        var lines = sdp.split('\n');
        for (var i = 0; i < lines.length; i++) if (lines[i].indexOf('a=candidate:') === 0) countCandidate(d.remote, { candidate: lines[i].slice(2) });
      } catch (e) { }
      return origSet(desc);
    };
  }
  function reportSelectedPair(peerId, pc) {
    if (!pc.getStats) return;
    pc.getStats().then(function (stats) {
      var pairs = {}, cands = {};
      stats.forEach(function (r) { if (r.type === 'candidate-pair') pairs[r.id] = r; else if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r; });
      Object.keys(pairs).forEach(function (id) {
        var p = pairs[id];
        if (p.state !== 'succeeded' || !(p.selected || p.nominated)) return;
        var l = cands[p.localCandidateId] || {}, r = cands[p.remoteCandidateId] || {};
        log('connected', peerId, 'via', (l.candidateType || '?') + '->' + (r.candidateType || '?'), (l.protocol || ''), (l.address && l.address.indexOf(':') >= 0) ? 'ipv6' : 'ipv4');
      });
    }).catch(function () { });
  }
  var pcSeq = 0;
  function WatchedPeerConnection(config, constraints) {
    var pc = new window.RTCPeerConnection(config, constraints);
    try { watchPeerConnection('connection ' + (++pcSeq), pc); } catch (e) { }
    return pc;
  }
  function watchAllPeers() {
    if (!room || typeof room.getPeers !== 'function') return;
    try {
      var peers = room.getPeers() || {};
      Object.keys(peers).forEach(function (id) {
        var pc = peers[id];
        if (pc && pc.__atckWatched && pc.__atckKey && pc.__atckKey !== id && iceDiag[pc.__atckKey]) {
          iceDiag[id] = iceDiag[pc.__atckKey];
          delete iceDiag[pc.__atckKey];
          pc.__atckKey = id;
        } else watchPeerConnection(id, pc);
      });
    } catch (e) { }
  }
  var TAG = '[AHNet]';

  var room = null;
  var sendAction = null;
  var currentRoomCode = null;
  var selfIdCached = null;
  var isHostSession = false;

  var localSink = null;    // spike page event receiver
  var unityIsReady = false;
  var pending = [];        // buffered events until a sink can take them
  var flushTimer = null;

  var stats = { tx: 0, rx: 0, lastTx: 0, lastRx: 0 };
  var statsTimer = null;
  var relayTimer = null;
  var relayWatchdog = null;
  var relayState = {};     // url -> last logged readyState

  // Presence keepalive. It lives HERE, not in C#: a hidden browser tab gets
  // no requestAnimationFrame, so Unity's whole main loop freezes and any
  // C#-driven keepalive stops - every peer then culls the hidden player as
  // timed out (and lobby players send no transforms at all). setInterval
  // still fires in hidden tabs (throttled to ~1/s - exactly our cadence).
  // 0x03 = M0Messages.TypePing; the liveness table below refreshes on receipt.
  var PING_MS = 1000;
  var PING_PAYLOAD = new Uint8Array([0x03]);
  var pingTimer = null;

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () {
      if (!sendAction) return;
      stats.tx++;
      try {
        sendAction(PING_PAYLOAD).catch(function () {});
      } catch (e) {}
    }, PING_MS);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  var netLog = [];            // the last few hundred lines, for the COPY NETWORK LOG button
  function remember(level, args) {
    try {
      var parts = Array.prototype.slice.call(args).map(function (a) {
        if (a instanceof Error) return a.name + ': ' + a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
      });
      netLog.push(new Date().toISOString().slice(11, 23) + ' ' + level + ' ' + parts.join(' '));
      if (netLog.length > 400) netLog.splice(0, netLog.length - 400);
    } catch (e) { }
  }
  function log() {
    remember('log', arguments);
    console.log.apply(console, [TAG].concat(Array.prototype.slice.call(arguments)));
  }
  function dumpLog() {
    var head = 'Pesky Weapons network log  ' + new Date().toISOString() + '  ' + navigator.userAgent + '\n'
      + 'room ' + currentRoomCode + (isHostSession ? ' (host)' : ' (client)') + '  self ' + (function () { try { return getSelfId(); } catch (e) { return '?'; } })() + '\n';
    var diag = '';
    try { Object.keys(iceDiag).forEach(function (id) { var d = iceDiag[id]; if (meaningful(d)) diag += id + ': ' + diagnose(id) + '\n'; }); } catch (e) { }
    return head + (diag ? '--- connections\n' + diag : '') + '--- log\n' + netLog.join('\n');
  }
  var logButton = null;
  function showLogButton() {
    try {
      if (logButton) return;
      var b = document.createElement('button');
      b.textContent = 'COPY NETWORK LOG';
      b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;padding:8px 12px;font:12px monospace;'
        + 'color:#9fe6b0;background:#10161a;border:1px solid #3a6b4a;cursor:pointer;opacity:0.92';
      function done(word) { b.textContent = word; setTimeout(hideLogButton, 2500); }
      b.onclick = function () {
        var textOut = dumpLog();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(textOut).then(function () { done('COPIED. PASTE IT TO CLAUDE'); }, function () { fallback(); });
        } else fallback();
        function fallback() {
          var ta = document.createElement('textarea'); ta.value = textOut; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done('COPIED. PASTE IT TO CLAUDE'); } catch (e) { done('COPY FAILED'); }
          document.body.removeChild(ta);
        }
      };
      document.body.appendChild(b);
      logButton = b;
      setTimeout(hideLogButton, 120000);
    } catch (e) { }
  }
  function hideLogButton() {
    if (logButton && logButton.parentNode) logButton.parentNode.removeChild(logButton);
    logButton = null;
  }

  // ---- peer liveness (wall clock) --------------------------------------
  // Liveness is a JavaScript job, not a Unity one: this timer keeps firing
  // in a hidden tab while Unity's main loop is frozen. Every received
  // action payload (the 1 Hz 0x03 PING included) stamps its sender. A peer
  // silent for PEER_TIMEOUT_MS gets exactly one OnPeerLeft and is forgotten;
  // a later packet from it raises OnPeerJoined again. trystero's own
  // onPeerLeave is kept as the fast path for a clean tab close. Unity
  // therefore sees one OnPeerJoined and one OnPeerLeft per liveness episode.

  var PEER_TIMEOUT_MS = 15000;
  var LIVENESS_TICK_MS = 1000;
  var peerLastSeen = {};       // peerId -> Date.now() of the last packet or join
  var livenessTimer = null;

  function isKnownPeer(peerId) {
    return Object.prototype.hasOwnProperty.call(peerLastSeen, peerId);
  }

  // A packet or a join from peerId. Emits OnPeerJoined only when the peer
  // was unknown (new, or forgotten after a timeout).
  function markPeerAlive(peerId, why) {
    var known = isKnownPeer(peerId);
    peerLastSeen[peerId] = Date.now();
    if (known) return;
    log('peer alive (' + why + '):', peerId);
    emit('OnPeerJoined', peerId);
  }

  // Emits OnPeerLeft once and forgets the peer. Safe to call twice.
  function markPeerGone(peerId, why) {
    if (!isKnownPeer(peerId)) return;
    delete peerLastSeen[peerId];
    log('peer gone (' + why + '):', peerId);
    emit('OnPeerLeft', peerId);
  }

  function livenessTick() {
    var now = Date.now();
    Object.keys(peerLastSeen).forEach(function (peerId) {
      var silentMs = now - peerLastSeen[peerId];
      if (silentMs > PEER_TIMEOUT_MS) {
        markPeerGone(peerId, 'silent ' + Math.round(silentMs / 1000) + 's');
      }
    });
  }

  function startLiveness() {
    stopLiveness();
    livenessTimer = setInterval(livenessTick, LIVENESS_TICK_MS);
  }

  function stopLiveness() {
    if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null; }
    peerLastSeen = {};
  }

  // ---- event delivery --------------------------------------------------

  function sinkAvailable() {
    if (localSink) return true;
    return unityIsReady && !!window.AH_UnityInstance;
  }

  function deliver(method, arg) {
    // An exception inside SendMessage can kill the trystero callback chain
    // silently — never let one escape.
    try {
      if (localSink) {
        localSink(method, arg);
      } else {
        window.AH_UnityInstance.SendMessage('NetBridge', method, arg);
      }
    } catch (e) {
      console.error(TAG, 'deliver(' + method + ') failed:', e);
    }
  }

  function flushPending() {
    while (pending.length > 0) {
      var ev = pending.shift();
      deliver(ev[0], ev[1]);
    }
  }

  function emit(method, arg) {
    if (sinkAvailable()) {
      flushPending();
      deliver(method, arg);
    } else {
      pending.push([method, arg]);
      if (!flushTimer) {
        flushTimer = setInterval(function () {
          if (sinkAvailable()) {
            clearInterval(flushTimer);
            flushTimer = null;
            flushPending();
          }
        }, 50);
      }
    }
  }

  // ---- base64 <-> bytes ------------------------------------------------
  // Payloads are small (19 bytes at 15 Hz, FRAMEs under 16 KB); simple
  // loops are plenty.

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function toUint8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  // ---- diagnostics -----------------------------------------------------

  function logRelayChanges() {
    var sockets = {};
    try { sockets = trystero.getRelaySockets() || {}; } catch (e) { return; }
    var states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    Object.keys(sockets).forEach(function (url) {
      var ws = sockets[url];
      var state = ws && states[ws.readyState] !== undefined ? states[ws.readyState] : 'UNKNOWN';
      if (relayState[url] !== state) {
        relayState[url] = state;
        // A room that fails to form is usually a dead relay, not your code.
        log('relay', state.toLowerCase() + ':', url);
      }
    });
  }

  function anyRelayOpen() {
    try {
      var sockets = trystero.getRelaySockets() || {};
      return Object.keys(sockets).some(function (url) {
        return sockets[url] && sockets[url].readyState === 1;
      });
    } catch (e) {
      return false;
    }
  }

  function startDiagnostics() {
    stopDiagnostics();
    relayState = {};
    relayTimer = setInterval(function () {
      logRelayChanges();
      hookRelaySockets();
    }, 1000);
    statsTimer = setInterval(function () {
      var peers = 0;
      try { peers = room ? Object.keys(room.getPeers()).length : 0; } catch (e) {}
      log('tx/s:', stats.tx - stats.lastTx, 'rx/s:', stats.rx - stats.lastRx,
          'total tx:', stats.tx, 'rx:', stats.rx, 'peers:', peers,
          'alive:', Object.keys(peerLastSeen).length);
      stats.lastTx = stats.tx;
      stats.lastRx = stats.rx;
    }, 1000);
    relayWatchdog = setTimeout(function () {
      if (!anyRelayOpen()) {
        emit('OnNetError', 'no signaling relay connected after 12s — network or relay outage');
      }
    }, 12000);
  }

  function stopDiagnostics() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    if (relayTimer) { clearInterval(relayTimer); relayTimer = null; }
    if (relayWatchdog) { clearTimeout(relayWatchdog); relayWatchdog = null; }
  }

  // ---- relay refresh (host only) ---------------------------------------
  // Why this exists: a room idle for ~5 minutes stopped being discoverable
  // by new joiners (After Hours known issue 1). Reading trystero 0.25.3: a
  // non-passive room re-publishes its announce (an ephemeral nostr event on
  // the room's root topic) to every relay every 5.3 s for as long as the
  // room exists and never deactivates, so there is no missing announce to
  // add — and the room object exposes no announce call anyway (the root
  // topic is an internal hash). What trystero cannot see is a relay
  // WebSocket that is still OPEN but no longer delivers (half-open TCP, or
  // a relay that dropped the subscription or rate-limited the key): it only
  // reconnects on the socket's close event, and a joiner subscribing with
  // since=now never sees announces published into a dead socket.
  //
  // Relay sockets carry signaling only, so closing one never touches an
  // RTCPeerConnection or its data channel: trystero reconnects it with its
  // own backoff (3.3 s, doubling to 60 s, reset on open), re-issues the REQ
  // subscriptions on open, and the announce loop publishes on the fresh
  // socket within 5.3 s. A healthy relay answers every announce with an OK
  // frame, so a socket with no inbound frame for a whole refresh window is
  // the stale case; one that talked recently is left alone. Host only: the
  // room is found through the host's announce.

  var RELAY_REFRESH_MS = 180000;   // 3 minutes, wall clock
  var relayLastRx = {};            // url -> Date.now() of the last inbound frame
  var relayRefreshTimer = null;

  function hookRelaySockets() {
    var sockets = {};
    try { sockets = trystero.getRelaySockets() || {}; } catch (e) { return; }
    Object.keys(sockets).forEach(function (url) {
      var ws = sockets[url];
      if (!ws || ws.__atckHooked) return;
      ws.__atckHooked = true;
      relayLastRx[url] = Date.now(); // a fresh socket gets a full window
      ws.addEventListener('message', function () { relayLastRx[url] = Date.now(); });
    });
  }

  function refreshRelays() {
    if (!room || !isHostSession) return;
    var sockets = {};
    try { sockets = trystero.getRelaySockets() || {}; } catch (e) { return; }
    var now = Date.now();
    Object.keys(sockets).forEach(function (url) {
      var ws = sockets[url];
      if (!ws || ws.readyState !== 1) return; // not OPEN: trystero's reconnect owns it
      var silentMs = now - (relayLastRx[url] || 0);
      if (silentMs < RELAY_REFRESH_MS) return; // heard from it this window: announces land
      log('relay silent for', Math.round(silentMs / 1000) + 's, recycling for a fresh announce:', url);
      try { ws.close(); } catch (e) {}
    });
  }

  function startRelayRefresh() {
    stopRelayRefresh();
    relayLastRx = {};
    if (!isHostSession) return;
    relayRefreshTimer = setInterval(refreshRelays, RELAY_REFRESH_MS);
  }

  function stopRelayRefresh() {
    if (relayRefreshTimer) { clearInterval(relayRefreshTimer); relayRefreshTimer = null; }
  }

  // ---- proximity voice -------------------------------------------------
  // Raw WebRTC media streams on the same peer connections as the data
  // action - no game messages involved. Unity owns the policy (settings
  // mode, per-peer distance falloff, the ring); this side owns the mic,
  // the VAD and the hidden <audio> element per peer. Hidden tabs keep
  // WebAudio and getUserMedia alive; setInterval throttles to ~1s so the
  // VAD cadence degrades there - acceptable.

  var VOICE_OFF = 0, VOICE_OPEN = 1, VOICE_AUTO = 2;
  var VAD_INTERVAL_MS = 100;
  var VAD_HANGOVER_MS = 400;   // keeps word tails from gating off mid-word
  var voiceMode = VOICE_OFF;
  var voiceThresholdDb = -42;  // dBFS gate for AUTO and the speaking report
  var micStream = null;
  var micTrack = null;
  var micPending = false;      // getUserMedia prompt in flight
  var voiceCtx = null;
  var voiceAnalyser = null;
  var voiceSamples = null;
  var vadTimer = null;
  var lastLoudMs = 0;
  var speaking = false;
  var peerAudio = {};          // peerId -> hidden <audio> element

  function voiceSetMode(mode) {
    voiceMode = mode | 0;
    if (voiceMode === VOICE_OFF) {
      voiceStop();
      return;
    }
    if (micStream) {
      applyVoiceMode();
      return;
    }
    if (primeStream) {
      // the join already asked for the mic (primeLocalAddresses): adopt that stream instead of prompting twice
      micStream = primeStream;
      primeStream = null;
      if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
      micTrack = micStream.getAudioTracks()[0] || null;
      log('mic granted (asked at join)');
      startVad();
      applyVoiceMode();
      if (room) shareMic(null);
      return;
    }
    if (micPending) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      voiceMode = VOICE_OFF;
      emit('OnVoiceError', 'MIC BLOCKED');
      return;
    }
    micPending = true;
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    }).then(function (stream) {
      micPending = false;
      if (voiceMode === VOICE_OFF) {
        // cycled back to OFF while the permission prompt was up
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      micStream = stream;
      micTrack = stream.getAudioTracks()[0] || null;
      log('mic granted');
      startVad();
      applyVoiceMode();
      if (room) shareMic(null);
    }).catch(function (e) {
      micPending = false;
      voiceMode = VOICE_OFF;
      console.error(TAG, 'getUserMedia failed:', e);
      emit('OnVoiceError', 'MIC BLOCKED');
    });
  }

  function voiceStop() {
    stopVad();
    if (!micStream) return;
    if (room) {
      try { room.removeStream(micStream); } catch (e) {}
    }
    micStream.getTracks().forEach(function (t) { t.stop(); });
    micStream = null;
    micTrack = null;
    log('mic released');
  }

  // OPEN MIC: the track always transmits. AUTO: only while the VAD says
  // speaking. Both report speaking to Unity - it drives the ring and the
  // hostile-noise beacon either way.
  function applyVoiceMode() {
    if (!micTrack) return;
    micTrack.enabled = voiceMode === VOICE_OPEN
      || (voiceMode === VOICE_AUTO && speaking);
  }

  function startVad() {
    stopVad();
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      voiceCtx = new Ctx();
      var source = voiceCtx.createMediaStreamSource(micStream);
      voiceAnalyser = voiceCtx.createAnalyser();
      voiceAnalyser.fftSize = 1024;
      source.connect(voiceAnalyser);
      voiceSamples = new Float32Array(voiceAnalyser.fftSize);
    } catch (e) {
      console.error(TAG, 'vad setup failed:', e);
      voiceCtx = null;
      voiceAnalyser = null;
      return;
    }
    vadTimer = setInterval(vadTick, VAD_INTERVAL_MS);
  }

  function stopVad() {
    if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
    if (voiceCtx) {
      try { voiceCtx.close(); } catch (e) {}
      voiceCtx = null;
    }
    voiceAnalyser = null;
    setSpeaking(false);
  }

  function vadTick() {
    if (!voiceAnalyser || !voiceCtx) return;
    // The enabling click happens inside Unity's canvas loop, not a plain
    // DOM gesture - the context can start suspended. Keep nudging it.
    if (voiceCtx.state === 'suspended') {
      try { voiceCtx.resume(); } catch (e) {}
    }
    voiceAnalyser.getFloatTimeDomainData(voiceSamples);
    var sum = 0;
    for (var i = 0; i < voiceSamples.length; i++) {
      sum += voiceSamples[i] * voiceSamples[i];
    }
    var rms = Math.sqrt(sum / voiceSamples.length);
    var db = rms > 0 ? 20 * Math.log10(rms) : -100;
    var now = Date.now();
    if (db >= voiceThresholdDb) lastLoudMs = now;
    setSpeaking(now - lastLoudMs <= VAD_HANGOVER_MS);
  }

  function setSpeaking(on) {
    if (speaking === on) return;
    speaking = on;
    applyVoiceMode();
    emit('OnVoiceActivity', on ? '1' : '0');
  }

  // trystero only sends streams to peers connected at addStream time, so
  // every later joiner needs a targeted re-send (see start's onPeerJoin).
  function shareMic(peerId) {
    if (!room || !micStream) return;
    try {
      room.addStream(micStream, peerId ? { target: peerId } : undefined);
    } catch (e) {
      console.error(TAG, 'addStream failed:', e);
    }
  }

  function attachPeerAudio(peerId, stream) {
    removePeerAudio(peerId);
    var el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
    el.style.display = 'none';
    el.volume = 0; // silent until Unity's proximity math says otherwise
    el.srcObject = stream;
    document.body.appendChild(el);
    peerAudio[peerId] = el;
    var p = el.play();
    if (p && p.catch) p.catch(function () {}); // autoplay policy; retried on volume pushes
    log('voice stream from', peerId);
  }

  function removePeerAudio(peerId) {
    var el = peerAudio[peerId];
    if (!el) return;
    try {
      el.srcObject = null;
      el.remove();
    } catch (e) {}
    delete peerAudio[peerId];
  }

  function voiceSetPeerVolume(peerId, gain) {
    var el = peerAudio[peerId];
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, gain));
    if (el.paused) {
      var p = el.play(); // autoplay unblocks once the page has a gesture
      if (p && p.catch) p.catch(function () {});
    }
  }

  function voiceSetThreshold(dbfs) {
    voiceThresholdDb = dbfs;
  }

  // ---- public API ------------------------------------------------------

  // A browser without microphone permission offers only its default route's address, hidden behind a
  // .local name. That cannot connect two machines on a school or office Wi-Fi (the names cannot be looked
  // up there), nor a laptop sharing a hotspot (its hotspot address is not on the default route). With the
  // permission granted it offers every interface with real addresses. So the join asks first, waits a
  // little for the answer, and joins either way. The stream is muted, handed to the voice path if voice
  // is on, and released shortly after the join if it is not.
  var primeStream = null;
  var primeTimer = null;
  var startToken = 0;
  function releasePrime() {
    if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
    if (primeStream) { primeStream.getTracks().forEach(function (t) { t.stop(); }); primeStream = null; }
  }
  function primeLocalAddresses(done) {
    var finished = false;
    function go() { if (finished) return; finished = true; done(); }
    if (micStream || primeStream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { go(); return; }
    if (micPending) {
      // the voice setting is already asking: wait for that answer instead of prompting twice
      var waited = 0;
      var poll = setInterval(function () { waited += 250; if (!micPending || waited >= 20000) { clearInterval(poll); go(); } }, 250);
      return;
    }
    log('asking for the microphone before joining, so this browser offers real local addresses');
    var giveUp = setTimeout(function () { log('no answer to the microphone prompt; joining anyway'); go(); }, 20000);
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      clearTimeout(giveUp);
      stream.getAudioTracks().forEach(function (t) { t.enabled = false; });
      if (micStream || primeStream) { stream.getTracks().forEach(function (t) { t.stop(); }); go(); return; }
      primeStream = stream;
      primeTimer = setTimeout(releasePrime, 45000);
      go();
    }).catch(function (e) {
      clearTimeout(giveUp);
      log('microphone not granted (' + (e && e.name) + '); joining with hidden local addresses');
      go();
    });
  }

  function start(roomCode, isHost) {
    var mine = ++startToken;
    primeLocalAddresses(function () { if (mine === startToken) startNow(roomCode, isHost); });
  }

  function startNow(roomCode, isHost) {
    if (room) leave();
    iceDiag = {};
    pcSeq = 0;
    currentRoomCode = String(roomCode || '').toUpperCase();
    isHostSession = !!isHost;
    log('joining room', currentRoomCode, isHostSession ? '(host)' : '(client)',
        'appId:', APP_ID);

    var joined;
    try {
      joined = trystero.joinRoom(
        { appId: APP_ID, relayConfig: { redundancy: RELAY_REDUNDANCY }, rtcConfig: { iceServers: iceServers() }, rtcPolyfill: WatchedPeerConnection },
        ROOM_PREFIX + currentRoomCode,
        {
          onJoinError: function (details) {
            console.error(TAG, 'join error:', details);
            remember('error', ['join error', details]);
            var why = '';
            try { why = bestDiagnosis(); } catch (e) { }
            var msg = 'join failed: ' + (details && details.error) + ' | ' + why;
            if (msg.length > 520) msg = msg.slice(0, 517) + '...';
            showLogButton();
            emit('OnNetError', msg);
          },
          // the library allows 10 s for its hello after a connection opens; a shared radio needs longer
          handshakeTimeoutMs: 30000
        }
      );
    } catch (e) {
      console.error(TAG, 'joinRoom threw:', e);
      emit('OnNetError', 'joinRoom threw: ' + (e && e.message));
      return;
    }
    room = joined;
    selfIdCached = trystero.selfId;
    // Before the handlers: assigning room.onPeerJoin replays already-connected
    // peers into it, and those must land in a fresh liveness table.
    startLiveness();
    var peerWatchTimer = setInterval(watchAllPeers, 500);
    setTimeout(function () { clearInterval(peerWatchTimer); }, 120000);
    watchAllPeers();

    // NOTE (known issue, spec §5.2): trystero 0.25 does not expose per-action
    // RTCDataChannel options, so the channel is ordered+reliable rather than
    // {ordered:false, maxRetransmits:0}. Sequence numbers still discard
    // out-of-order data. Do not fork the library.
    var action = room.makeAction(ACTION, {
      onMessage: function (data, ctx) {
        stats.rx++;
        var bytes = toUint8(data);
        if (!bytes) {
          log('dropping non-binary message from', ctx && ctx.peerId);
          return;
        }
        // ANY payload proves liveness, the 0x03 PING included. A packet from
        // a forgotten peer re-raises OnPeerJoined before the message itself.
        markPeerAlive(ctx.peerId, 'packet');
        // Two values packed in one string because SendMessage takes a single
        // argument. Peer ids contain no '|'.
        emit('OnNetMessage', ctx.peerId + '|' + bytesToB64(bytes));
      }
    });
    sendAction = action.send;

    room.onPeerJoin = function (peerId) {
      log('peer joined:', peerId);
      shareMic(peerId); // no-op unless voice is enabled
      markPeerAlive(peerId, 'trystero join');
    };
    room.onPeerLeave = function (peerId) {
      log('peer left:', peerId);
      removePeerAudio(peerId);
      markPeerGone(peerId, 'trystero leave');
    };
    room.onPeerStream = function (stream, peerId) {
      attachPeerAudio(peerId, stream);
    };
    // rejoining with voice already enabled: re-offer the mic (covers any
    // already-connected peers; onPeerJoin covers everyone later)
    if (micStream) shareMic(null);

    startDiagnostics();
    startRelayRefresh();
    startPing();
    log('self id:', selfIdCached);
    emit('OnNetReady', selfIdCached);
  }

  function leave() {
    startToken++; // a join still waiting on the microphone prompt is abandoned
    stopDiagnostics();
    stopRelayRefresh();
    stopPing();
    stopLiveness();
    // the mic and its VAD survive a leave (the mode is a persisted
    // setting); only the per-peer playback elements go
    Object.keys(peerAudio).forEach(removePeerAudio);
    if (room) {
      log('leaving room', currentRoomCode);
      try { room.leave(); } catch (e) { console.error(TAG, 'leave failed:', e); }
    }
    room = null;
    sendAction = null;
    currentRoomCode = null;
    isHostSession = false;
  }

  function broadcast(payloadB64) {
    if (!sendAction) return;
    stats.tx++;
    try {
      sendAction(b64ToBytes(payloadB64)).catch(function (e) {
        console.error(TAG, 'broadcast failed:', e);
      });
    } catch (e) {
      console.error(TAG, 'broadcast threw:', e);
    }
  }

  function sendTo(peerId, payloadB64) {
    if (!sendAction) return;
    stats.tx++;
    try {
      sendAction(b64ToBytes(payloadB64), { target: peerId }).catch(function (e) {
        console.error(TAG, 'sendTo failed:', e);
      });
    } catch (e) {
      console.error(TAG, 'sendTo threw:', e);
    }
  }

  function getSelfId() {
    return selfIdCached || '';
  }

  function getPeerIds() {
    var ids = [];
    try { if (room) ids = Object.keys(room.getPeers()); } catch (e) {}
    return JSON.stringify(ids);
  }

  function unityReady() {
    unityIsReady = true;
    log('unity sink registered,', pending.length, 'buffered events waiting');
    if (sinkAvailable()) flushPending();
    // else the flush interval started by emit() picks them up once
    // window.AH_UnityInstance is assigned by the template.
  }

  function setLocalSink(fn) {
    localSink = fn;
    flushPending();
  }

  window.AH_Net = {
    start: start,
    leave: leave,
    broadcast: broadcast,
    sendTo: sendTo,
    getSelfId: getSelfId,
    getPeerIds: getPeerIds,
    voiceSetMode: voiceSetMode,
    voiceSetPeerVolume: voiceSetPeerVolume,
    voiceSetThreshold: voiceSetThreshold,
    unityReady: unityReady,
    setLocalSink: setLocalSink,
    dumpLog: dumpLog
  };
})();
