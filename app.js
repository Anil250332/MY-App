// ══════════════════════════════════════════════
//  Remote Camera Viewer — Protected Dashboard app.js
//  Requires JWT Login before accessing camera/audio
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
const pairingInput    = document.getElementById('pairingCodeInput');
const qrFileInput     = document.getElementById('qrFileInput');
const btnConnect      = document.getElementById('btnConnect');
const btnStartStream  = document.getElementById('btnStartStream');
const btnStopStream   = document.getElementById('btnStopStream');
const btnDisconnect   = document.getElementById('btnDisconnect');
const btnRefresh      = document.getElementById('btnRefresh');
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
  authToken = '';
  authEmail = '';
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  localStorage.removeItem(STORAGE_EMAIL_KEY);
  showLoginGate();
}

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
    // Server unreachable on load; let user login/retry
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
    btnLoginSubmit.textContent = '🔐 Login to Dashboard';
  }
});

btnLogout.addEventListener('click', logout);

// ── Connection Badge ───────────────────────────
function setConnected(yes) {
  if (yes) {
    connBadge.className = 'flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-900 flex-shrink-0';
    connBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span>Connected</span>';
    btnStartStream.disabled = false;
    btnRefresh.disabled = false;
  } else {
    connBadge.className = 'flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-red-950 text-red-400 border border-red-900 flex-shrink-0';
    connBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span><span>Disconnected</span>';
    btnStartStream.disabled = true;
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
    btnMuteAudio.classList.remove('hidden');
    btnScreenshot.classList.remove('hidden');
    btnDisconnect.classList.remove('hidden');
    btnStopStream.classList.remove('hidden');
    btnStartStream.classList.add('hidden');
  } else {
    streamDot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
    streamLabel.textContent = 'No Camera Stream';
    liveBadge.classList.add('hidden');
    iceStateBadge.classList.add('hidden');
    btnMuteAudio.classList.add('hidden');
    btnScreenshot.classList.add('hidden');
    btnDisconnect.classList.add('hidden');
    btnStopStream.classList.add('hidden');
    btnStartStream.classList.remove('hidden');
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
      deviceName: 'Web Dashboard Viewer',
      deviceType: 'viewer',
      token: authToken
    });

    fetchDevices();
  });

  socket.on('registered', data => {
    log('Authenticated & registered on signaling server', 'success');
    if (data.iceServers && data.iceServers.length) {
      iceServersConfig = data.iceServers;
    }
  });

  socket.on('disconnect', () => {
    log('Disconnected from signaling server', 'warn');
    setConnected(false);
    if (isStreaming) teardownPeer();
  });

  socket.on('stream-request-sent', data => {
    log(`Stream consent request sent → session: ${data.sessionId}`, 'info');
    sessionIdLabel.textContent = data.sessionId.substring(0, 12) + '...';
    placeholderText.textContent = 'Mobile पर Approve करें...';
  });

  socket.on('stream-approved', async data => {
    log(`Stream APPROVED ✓ Camera device: ${data.cameraDeviceId}`, 'success');
    if (data.iceServers && data.iceServers.length) iceServersConfig = data.iceServers;
    currentSession = { sessionId: data.sessionId, cameraDeviceId: data.cameraDeviceId };
    sessionIdLabel.textContent = data.sessionId.substring(0, 12) + '...';
    await initWebRtc(data.cameraDeviceId, data.sessionId);
  });

  socket.on('stream-rejected', data => {
    log(`Stream REJECTED — ${data.message}`, 'error');
    placeholderText.textContent = 'Stream reject हो गया। फिर से try करें।';
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
    placeholderText.textContent = 'Camera device से connect करें';
    currentSession = null;
  }
}

// ── Request Stream ─────────────────────────────
function requestStream(cameraDeviceId) {
  if (!socket || !socket.connected) {
    alert('पहले server से connect करें।');
    return;
  }
  log(`Stream request → Camera: ${cameraDeviceId}`, 'info');
  placeholderText.textContent = 'Stream request भेजी जा रही है...';
  videoPlaceholder.classList.remove('hidden');

  socket.emit('request-stream', {
    viewerDeviceId,
    viewerName: `Dashboard (${authEmail})`,
    cameraDeviceId
  });
}

// ── Fetch Devices (Authenticated) ──────────────
async function fetchDevices() {
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
    renderDevices(data.data || []);
  } catch (err) {
    deviceListEl.innerHTML = `<div class="text-xs text-rose-400">Devices fetch failed: ${err.message}</div>`;
  }
}

function renderDevices(items) {
  if (!items.length) {
    deviceListEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-3">No camera devices registered yet.<br/>Mobile पर APK open करें।</div>';
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
      pairingInput.value = '';
      requestStream(devId);
    });
  });
}

// ── Find camera by pairing code (Authenticated) ──
async function findDeviceByCode(code) {
  const url = serverUrlInput.value.trim().replace(/\/+$/, '');
  try {
    const res = await fetch(`${url}/api/devices/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ viewerDeviceId, pairingCode: code })
    });
    if (res.status === 401) {
      logout();
      return null;
    }
    const data = await res.json();
    if (data.success) {
      const devId = data.data?.pairedDevice?.id;
      log(`Device found by code: ${devId}`, 'success');
      return devId;
    } else {
      log(`Code not found: ${data.message}`, 'error');
      return null;
    }
  } catch (err) {
    log(`Error looking up pairing code: ${err.message}`, 'error');
    return null;
  }
}

// ── QR Code File Scan ──────────────────────────
qrFileInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (window.jsQR) {
        const result = jsQR(imageData.data, imageData.width, imageData.height);
        if (result && result.data) {
          try {
            const parsed = JSON.parse(result.data);
            const code = parsed.code || result.data;
            pairingInput.value = code.toUpperCase();
            log(`QR decoded: ${code}`, 'success');
            if (parsed.server) serverUrlInput.value = parsed.server;
          } catch { pairingInput.value = result.data.toUpperCase(); }
        } else {
          log('QR decode failed — code manually डालें', 'warn');
        }
      } else {
        log('QR file uploaded — code manually डालें', 'warn');
      }
    };
    img.src = URL.createObjectURL(file);
  } catch (err) {
    log('QR image error: ' + err.message, 'error');
  }
});

// ── Screenshot ─────────────────────────────────
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

// ── Audio Toggle ───────────────────────────────
btnMuteAudio.addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  remoteVideo.muted = !audioEnabled;
  btnMuteAudio.textContent = audioEnabled ? '🔊 Audio On' : '🔇 Audio Off';
  btnMuteAudio.style.background = audioEnabled ? '' : '#7f1d1d';
  log(`Audio ${audioEnabled ? 'enabled' : 'muted'}`, 'info');
});

// ── Fullscreen ─────────────────────────────────
btnFullscreen.addEventListener('click', () => {
  const container = document.getElementById('videoContainer');
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(err => alert(err.message));
  } else {
    document.exitFullscreen();
  }
});

// ── Main Buttons ───────────────────────────────
btnConnect.addEventListener('click', connectSignaling);

btnStartStream.addEventListener('click', async () => {
  const code = pairingInput.value.trim().toUpperCase();
  if (!code || code.length !== 6) {
    alert('6-character pairing code डालें (जो mobile पर दिख रहा है)');
    return;
  }
  if (!socket || !socket.connected) {
    alert('पहले server से connect करें।');
    return;
  }
  log(`Pairing code: ${code} — looking up device...`, 'info');
  const devId = await findDeviceByCode(code);
  if (devId) {
    requestStream(devId);
  }
});

btnStopStream.addEventListener('click', () => {
  if (currentSession && socket) {
    socket.emit('end-stream', {
      sessionId: currentSession.sessionId,
      targetDeviceId: currentSession.cameraDeviceId
    });
    log('Stream manually stopped from dashboard', 'warn');
  }
  teardownPeer();
});

btnDisconnect.addEventListener('click', () => {
  if (currentSession && socket) {
    socket.emit('end-stream', {
      sessionId: currentSession.sessionId,
      targetDeviceId: currentSession.cameraDeviceId
    });
  }
  teardownPeer();
});

btnRefresh.addEventListener('click', fetchDevices);

// ── Initialize on Load ─────────────────────────
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
  document.head.appendChild(s);

  const savedServer = localStorage.getItem(STORAGE_SERVER_KEY) || 'https://camera-app-backend-q7p5.onrender.com';
  loginServerUrl.value = savedServer;
  serverUrlInput.value = savedServer;
  verifyExistingSession(savedServer);
});

pairingInput.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
