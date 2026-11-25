// ══════════════════════════════════════════════
//  CamGuard Viewer — Auto-Connect Dashboard app.js
//  Login -> Auto-connect to online camera
//  Logout -> Disconnect stream & return camera to Standby
// ══════════════════════════════════════════════

'use strict';

const STORAGE_TOKEN_KEY = 'rs_auth_token';
const STORAGE_EMAIL_KEY = 'rs_auth_email';
const STORAGE_SERVER_KEY = 'rs_server_url';
const STORAGE_VIEWER_ID_KEY = 'rs_viewer_device_id';

// ── State ──────────────────────────────────────
let authToken       = localStorage.getItem(STORAGE_TOKEN_KEY) || '';
let authEmail       = localStorage.getItem(STORAGE_EMAIL_KEY) || '';
let socket          = null;
let peerConnection  = null;
let currentSession  = null;
let audioEnabled    = true;
let isStreaming     = false;

let viewerDeviceId = localStorage.getItem(STORAGE_VIEWER_ID_KEY);
if (!viewerDeviceId) {
  viewerDeviceId = 'web_' + Math.random().toString(36).substring(2, 10);
  localStorage.setItem(STORAGE_VIEWER_ID_KEY, viewerDeviceId);
}

let iceServersConfig = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

// ── UI Refs ────────────────────────────────────
const loginGate       = document.getElementById('loginGate');
const appShell        = document.getElementById('appShell');
const loginForm       = document.getElementById('loginForm');
const loginServerUrl  = document.getElementById('loginServerUrl');
const loginEmail      = document.getElementById('loginEmail');
const loginPassword   = document.getElementById('loginPassword');
const loginError      = document.getElementById('loginError');
const btnLoginSubmit  = document.getElementById('btnLoginSubmit');
const btnLogout       = document.getElementById('btnLogout');
const loggedInUserLbl = document.getElementById('loggedInUserLabel');

const serverUrlInput  = document.getElementById('serverUrlInput');
const btnConnect      = document.getElementById('btnConnect');
const btnDisconnect   = document.getElementById('btnDisconnect');
const btnRefresh      = document.getElementById('btnRefresh');
const btnSwitchCamera = document.getElementById('btnSwitchCamera');
const btnMuteAudio    = document.getElementById('btnMuteAudio');
const btnFullscreen   = document.getElementById('btnFullscreen');
const btnScreenshot   = document.getElementById('btnScreenshot');
const connBadge       = document.getElementById('connBadge');
const streamDot       = document.getElementById('streamDot');
const streamLabel     = document.getElementById('streamLabel');
const videoPlaceholder= document.getElementById('videoPlaceholder');
const placeholderText = document.getElementById('placeholderText');
const liveBadge       = document.getElementById('liveBadge');
const iceStateBadge   = document.getElementById('iceStateBadge');
const iceStateText    = document.getElementById('iceStateText');
const iceState2       = document.getElementById('iceState2');
const sessionIdLabel  = document.getElementById('sessionIdLabel');
const deviceListEl    = document.getElementById('deviceList');
const remoteVideo     = document.getElementById('remoteVideo');
const logEl           = document.getElementById('logEl');

// ── Logging ────────────────────────────────────
function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = 'log-entry ' + ({
    info: 'text-slate-400', success: 'text-emerald-400',
    warn: 'text-amber-400', error: 'text-rose-400', stream: 'text-blue-400'
  }[type] || 'text-slate-400');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
window.clearLog = () => logEl.innerHTML = '';

// ── Auth Gate Management ───────────────────────
function showLoginGate(errorMsg = '') {
  teardownPeer();
  if (socket) { socket.disconnect(); socket = null; }
  appShell.classList.add('hidden');
  loginGate.classList.remove('hidden');
  if (errorMsg) {
    loginError.textContent = errorMsg;
    loginError.classList.remove('hidden');
  } else {
    loginError.classList.add('hidden');
  }
}

function showDashboard() {
  loginGate.classList.add('hidden');
  appShell.classList.remove('hidden');
  loggedInUserLbl.textContent = `Logged in: ${authEmail}`;
  connectSignaling();
}

function logout() {
  if (currentSession && socket && socket.connected) {
    socket.emit('end-stream', {
      sessionId: currentSession.sessionId,
      targetDeviceId: currentSession.cameraDeviceId
    });
  }
  authToken = '';
  authEmail = '';
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(STORAGE_EMAIL_KEY);
  showLoginGate();
}

window.addEventListener('beforeunload', () => {
  if (currentSession && socket && socket.connected) {
    socket.emit('end-stream', {
      sessionId: currentSession.sessionId,
      targetDeviceId: currentSession.cameraDeviceId
    });
  }
});

async function verifyExistingSession(serverUrl) {
  if (!authToken) {
    showLoginGate();
    return;
  }
  try {
    const res = await fetch(`${serverUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (res.ok) {
      const json = await res.json();
      authEmail = json.data?.email || authEmail;
      showDashboard();
    } else {
      logout();
    }
  } catch {
    showLoginGate();
  }
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginError.classList.add('hidden');
  btnLoginSubmit.disabled = true;
  btnLoginSubmit.textContent = 'Logging in...';

  const serverUrl = loginServerUrl.value.trim().replace(/\/+$/, '');
  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  try {
    const res = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (res.ok && data.success && data.data?.token) {
      authToken = data.data.token;
      authEmail = data.data.user?.email || email;
      localStorage.setItem(STORAGE_TOKEN_KEY, authToken);
      localStorage.setItem(STORAGE_EMAIL_KEY, authEmail);
      localStorage.setItem(STORAGE_SERVER_KEY, serverUrl);
      serverUrlInput.value = serverUrl;
      showDashboard();
    } else {
      showLoginGate(data.message || 'Invalid email or password');
    }
  } catch (err) {
    showLoginGate(`Server connection failed: ${err.message}`);
  } finally {
    btnLoginSubmit.disabled = false;
    btnLoginSubmit.textContent = '🔐 Login & Connect';
  }
});

btnLogout.addEventListener('click', logout);

// ── Connection Badge ───────────────────────────
function setConnected(yes) {
  if (yes) {
    connBadge.className = 'flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-900 flex-shrink-0';
    connBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Connected</span>';
    btnRefresh.disabled = false;
  } else {
    connBadge.className = 'flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-red-950 text-red-400 border border-red-900 flex-shrink-0';
    connBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span><span>Disconnected</span>';
    btnRefresh.disabled = true;
  }
}

// ── Stream UI State ────────────────────────────
function setStreamingUI(streaming) {
  isStreaming = streaming;
  if (streaming) {
    streamDot.className = 'w-2.5 h-2.5 rounded-full bg-red-500 pulse';
    streamLabel.textContent = 'Live Camera Stream';
    videoPlaceholder.classList.add('hidden');
    liveBadge.classList.remove('hidden');
    iceStateBadge.classList.remove('hidden');
    btnSwitchCamera.disabled = false;
    btnMuteAudio.disabled = false;
    btnScreenshot.disabled = false;
    btnDisconnect.classList.remove('hidden');
  } else {
    streamDot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
    streamLabel.textContent = 'Standby (Waiting for Camera)';
    liveBadge.classList.add('hidden');
    iceStateBadge.classList.add('hidden');
    btnSwitchCamera.disabled = true;
    btnMuteAudio.disabled = true;
    btnScreenshot.disabled = true;
    btnDisconnect.classList.add('hidden');
  }
}

function updateIceState(state) {
  iceStateText.textContent = state;
  iceState2.textContent = state;
}

// ── Connect to Signaling Server ────────────────
function loadSocketIoFallback(serverUrl) {
  return new Promise((resolve, reject) => {
    if (typeof io !== 'undefined') return resolve();
    const s = document.createElement('script');
    s.src = `${serverUrl}/socket.io/socket.io.js`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Socket.IO client from server'));
    document.head.appendChild(s);
  });
}

async function connectSignaling() {
  if (!authToken) {
    showLoginGate('Please login first.');
    return;
  }
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  if (!url) return;

  if (typeof io === 'undefined') {
    try {
      await loadSocketIoFallback(url);
    } catch (err) {
      log(err.message, 'error');
      return;
    }
  }

  if (socket) { socket.disconnect(); socket = null; }
  log(`Connecting to signaling server: ${url}...`);

  socket = io(url, {
    transports: ['websocket', 'polling'],
    auth: { token: authToken }
  });

  socket.on('connect', () => {
    log(`Connected ✓ (Socket: ${socket.id})`, 'success');
    setConnected(true);

    socket.emit('register-device', {
      deviceId: viewerDeviceId,
      deviceName: 'CamGuard Web Viewer',
      deviceType: 'viewer',
      token: authToken
    });
  });

  socket.on('registered', async data => {
    log('Authenticated & registered on signaling server', 'success');
    if (data.iceServers && data.iceServers.length) {
      iceServersConfig = data.iceServers;
    }
    // Auto-discover online camera and connect immediately
    await fetchDevices(true);
  });

  socket.on('disconnect', () => {
    log('Disconnected from signaling server', 'warn');
    setConnected(false);
    if (isStreaming) teardownPeer();
  });

  socket.on('stream-request-sent', data => {
    log(`Connecting to camera → session: ${data.sessionId}`, 'info');
    sessionIdLabel.textContent = data.sessionId.substring(0, 12) + '...';
    placeholderText.textContent = 'Camera connect ho raha hai...';
  });

  socket.on('stream-approved', async data => {
    log(`Stream connected ✓ Camera: ${data.cameraDeviceId}`, 'success');
    if (data.iceServers && data.iceServers.length) iceServersConfig = data.iceServers;
    currentSession = { sessionId: data.sessionId, cameraDeviceId: data.cameraDeviceId };
    sessionIdLabel.textContent = data.sessionId.substring(0, 12) + '...';
    await initWebRtc(data.cameraDeviceId, data.sessionId);
  });

  socket.on('stream-rejected', data => {
    log(`Stream declined — ${data.message}`, 'error');
    placeholderText.textContent = 'Camera access declined on phone.';
    setStreamingUI(false);
  });

  socket.on('stream-error', data => {
    log(`Error: ${data.message}`, 'error');
    placeholderText.textContent = data.message;
    if (data.message && data.message.toLowerCase().includes('unauthorized')) {
      logout();
    }
  });

  socket.on('offer', async data => {
    log(`WebRTC Offer received from ${data.senderDeviceId}`, 'stream');
    if (!peerConnection) await initWebRtc(data.senderDeviceId, data.sessionId, false);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', {
      targetDeviceId: data.senderDeviceId,
      sessionId: data.sessionId,
      sdp: answer
    });
    log('SDP Answer sent', 'stream');
  });

  socket.on('answer', async data => {
    log(`SDP Answer received from ${data.senderDeviceId}`, 'stream');
    if (peerConnection) await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  });

  socket.on('ice-candidate', async data => {
    if (peerConnection && data.candidate) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); }
      catch(e) { log('ICE candidate error: ' + e.message, 'warn'); }
    }
  });

  socket.on('stream-ended', data => {
    log(`Stream ended: ${data.message}`, 'warn');
    teardownPeer();
  });

  socket.on('peer-disconnected', data => {
    log(`Camera device disconnected (${data.deviceId})`, 'warn');
    teardownPeer();
  });
}

// ── WebRTC Peer Connection ─────────────────────
async function initWebRtc(targetDeviceId, sessionId, isInitiator = true) {
  teardownPeer(false);

  peerConnection = new RTCPeerConnection({
    iceServers: iceServersConfig,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });

  peerConnection.onicecandidate = e => {
    if (e.candidate && socket) {
      socket.emit('ice-candidate', {
        targetDeviceId,
        sessionId,
        candidate: e.candidate
      });
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    const st = peerConnection.iceConnectionState;
    updateIceState(st);
    log(`ICE state → ${st}`, 'stream');

    if (st === 'connected') {
      log('🎉 WebRTC Connected! Live stream is active.', 'success');
      setStreamingUI(true);
      remoteVideo.muted = !audioEnabled;
    }
    if (st === 'disconnected' || st === 'failed' || st === 'closed') {
      teardownPeer();
    }
  };

  peerConnection.ontrack = e => {
    log(`Remote track received: ${e.track.kind}`, 'success');
    if (remoteVideo.srcObject !== e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
      remoteVideo.muted = !audioEnabled;
    }
    setStreamingUI(true);
    videoPlaceholder.classList.add('hidden');
  };

  if (isInitiator) {
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    peerConnection.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { targetDeviceId, sessionId, sdp: offer });
    log('WebRTC Offer sent to camera device', 'stream');
  }
}

function teardownPeer(resetUI = true) {
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.ontrack = null;
    peerConnection.close();
    peerConnection = null;
  }
  if (remoteVideo.srcObject) {
    remoteVideo.srcObject.getTracks().forEach(t => t.stop());
    remoteVideo.srcObject = null;
  }
  if (resetUI) {
    setStreamingUI(false);
    updateIceState('—');
    sessionIdLabel.textContent = '—';
    placeholderText.textContent = 'Camera standby par hai — Refresh ya Connect dabaye';
    currentSession = null;
  }
}

// ── Request Stream ─────────────────────────────
function requestStream(cameraDeviceId) {
  if (!socket || !socket.connected) return;
  log(`Auto-connecting to camera: ${cameraDeviceId}`, 'info');
  placeholderText.textContent = 'Camera connect ho raha hai...';
  videoPlaceholder.classList.remove('hidden');

  socket.emit('request-stream', {
    viewerDeviceId,
    viewerName: `Dashboard (${authEmail})`,
    cameraDeviceId
  });
}

// ── Fetch Devices & Auto-Connect ───────────────
async function fetchDevices(autoConnect = false) {
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  if (!url || !authToken) return;
  try {
    const res = await fetch(`${url}/api/devices/cameras`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    const list = data.data || [];
    renderDevices(list);

    if (autoConnect && !isStreaming) {
      const onlineItem = list.find(item => {
        const d = item.device || item;
        return d.status === 'online' || d.status === 'streaming';
      });
      if (onlineItem) {
        const dev = onlineItem.device || onlineItem;
        requestStream(dev.id);
      } else {
        placeholderText.textContent = 'Koi camera abhi online nahi hai. Phone par CamGuard open karein.';
      }
    }
  } catch (err) {
    deviceListEl.innerHTML = `<div class="text-xs text-rose-400">Devices fetch failed: ${err.message}</div>`;
  }
}

function renderDevices(items) {
  if (!items.length) {
    deviceListEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-3">No camera devices registered yet.</div>';
    return;
  }
  deviceListEl.innerHTML = '';
  items.forEach(item => {
    const dev = item.device || item;
    const isOnline = dev.status === 'online' || dev.status === 'streaming';
    const card = document.createElement('div');
    card.className = 'bg-slate-800/70 rounded-xl p-3 flex items-center justify-between border border-slate-700/50';
    card.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-slate-500'}"></span>
        <div>
          <div class="text-xs font-semibold text-white">${dev.name || 'Camera Device'}</div>
          <div class="text-[10px] text-slate-400 font-mono">${dev.status?.toUpperCase()}</div>
        </div>
      </div>
      <button class="btn-dev text-xs bg-blue-600 text-white px-2.5 py-1 rounded-lg font-semibold"
        data-id="${dev.id}" ${!isOnline ? 'disabled style="opacity:.4"' : ''}>
        Connect
      </button>`;
    deviceListEl.appendChild(card);
  });

  document.querySelectorAll('.btn-dev').forEach(btn => {
    btn.addEventListener('click', e => {
      const devId = e.target.getAttribute('data-id');
      requestStream(devId);
    });
  });
}

// ── Controls ───────────────────────────────────
btnScreenshot.addEventListener('click', () => {
  if (!remoteVideo.srcObject) return;
  const canvas = document.getElementById('screenshotCanvas');
  canvas.width = remoteVideo.videoWidth;
  canvas.height = remoteVideo.videoHeight;
  canvas.getContext('2d').drawImage(remoteVideo, 0, 0);
  const link = document.createElement('a');
  link.download = `screenshot_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  log('Screenshot saved', 'success');
});

btnSwitchCamera.addEventListener('click', () => {
  if (!currentSession || !socket || !socket.connected) return;
  socket.emit('switch-camera', { targetDeviceId: currentSession.cameraDeviceId });
  log('🔄 Switching camera (Front ↔ Back)...', 'stream');
});

btnMuteAudio.addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  remoteVideo.muted = !audioEnabled;
  btnMuteAudio.textContent = audioEnabled ? '🔊 Audio On' : '🔇 Audio Off';
  btnMuteAudio.style.background = audioEnabled ? '' : '#7f1d1d';
  log(`Audio ${audioEnabled ? 'enabled' : 'muted'}`, 'info');
});

btnFullscreen.addEventListener('click', () => {
  const container = document.getElementById('videoContainer');
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(err => alert(err.message));
  } else {
    document.exitFullscreen();
  }
});

btnConnect.addEventListener('click', connectSignaling);

btnDisconnect.addEventListener('click', () => {
  if (currentSession && socket) {
    socket.emit('end-stream', {
      sessionId: currentSession.sessionId,
      targetDeviceId: currentSession.cameraDeviceId
    });
  }
  teardownPeer();
});

btnRefresh.addEventListener('click', () => fetchDevices(false));

// ── Initialize on Load ─────────────────────────
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const savedServer = localStorage.getItem(STORAGE_SERVER_KEY) || 'https://camera-app-backend-q7p5.onrender.com';
  loginServerUrl.value = savedServer;
  serverUrlInput.value = savedServer;
  verifyExistingSession(savedServer);
});
