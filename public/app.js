const authScreen = document.querySelector('#authScreen');
const chatScreen = document.querySelector('#chatScreen');
const authForm = document.querySelector('#authForm');
const registerFields = document.querySelector('#registerFields');
const authTitle = document.querySelector('#authTitle');
const authSubtitle = document.querySelector('#authSubtitle');
const authSubmit = document.querySelector('#authSubmit');
const authError = document.querySelector('#authError');
const toast = document.querySelector('#toast');
const localVideo = document.querySelector('#localVideo');
const remoteVideo = document.querySelector('#remoteVideo');
const localPlaceholder = document.querySelector('#localPlaceholder');
const remotePlaceholder = document.querySelector('#remotePlaceholder');
const remoteStatus = document.querySelector('#remoteStatus');
const connectionStatus = document.querySelector('#connectionStatus');
const connectionPulse = document.querySelector('.connection-pulse');
const micButton = document.querySelector('#micButton');
const cameraButton = document.querySelector('#cameraButton');
const nextButton = document.querySelector('#nextButton');
const nextLabel = document.querySelector('#nextLabel');

let authMode = 'register';
let currentUser = null;
let socket = null;
let localStream = null;
let peerConnection = null;
let pendingCandidates = [];
let isMatched = false;
let isWaiting = false;
let isSearching = false;
let meetings = 0;
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function updateAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === 'register';
  registerFields.hidden = !isRegister;
  registerFields.querySelectorAll('input').forEach((input) => { input.required = isRegister; });
  authForm.elements.password.autocomplete = isRegister ? 'new-password' : 'current-password';
  authTitle.textContent = isRegister ? 'Создать аккаунт' : 'С возвращением';
  authSubtitle.textContent = isRegister ? 'Это займёт всего минуту.' : 'Войдите, чтобы продолжить.';
  authSubmit.querySelector('span:first-child').textContent = isRegister ? 'Создать аккаунт' : 'Войти в чат';
  document.querySelectorAll('[data-auth-mode]').forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  authError.hidden = true;
  authError.textContent = '';
}

document.querySelectorAll('[data-auth-mode]').forEach((tab) => {
  tab.addEventListener('click', () => updateAuthMode(tab.dataset.authMode));
});

function showChat(user) {
  currentUser = user;
  authScreen.hidden = true;
  chatScreen.hidden = false;
  document.querySelector('#userName').textContent = user.firstName;
  connectSocket();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'same-origin',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.');
  return result;
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.hidden = true;
  const values = Object.fromEntries(new FormData(authForm).entries());
  const requestBody = authMode === 'register'
    ? { ...values, birthYear: Number(values.birthYear) }
    : { email: values.email, password: values.password };

  authSubmit.disabled = true;
  authSubmit.querySelector('span:first-child').textContent = 'Подождите…';
  try {
    const result = await api(`/api/${authMode}`, { method: 'POST', body: JSON.stringify(requestBody) });
    showChat(result.user);
  } catch (error) {
    authError.textContent = error.message;
    authError.hidden = false;
  } finally {
    authSubmit.disabled = false;
    authSubmit.querySelector('span:first-child').textContent = authMode === 'register' ? 'Создать аккаунт' : 'Войти в чат';
  }
});

async function initialize() {
  const yearInput = authForm.elements.birthYear;
  yearInput.max = String(new Date().getFullYear() - 18);
  yearInput.placeholder = String(new Date().getFullYear() - 25);
  try {
    const result = await api('/api/me');
    showChat(result.user);
  } catch {
    authScreen.hidden = false;
    chatScreen.hidden = true;
  }
}

function setConnectionStatus(text, waiting = false) {
  connectionStatus.textContent = text;
  connectionPulse.classList.toggle('is-waiting', waiting);
}

function updateNextButton() {
  nextLabel.textContent = isWaiting ? 'Ищем собеседника' : isMatched ? 'Следующий' : 'Найти собеседника';
  nextButton.disabled = isWaiting;
}

function updateLocalControls() {
  const audioTrack = localStream?.getAudioTracks()[0];
  const videoTrack = localStream?.getVideoTracks()[0];
  const hasMedia = Boolean(audioTrack || videoTrack);
  micButton.disabled = !audioTrack;
  cameraButton.disabled = !videoTrack;
  micButton.classList.toggle('is-off', Boolean(audioTrack && !audioTrack.enabled));
  cameraButton.classList.toggle('is-off', Boolean(videoTrack && !videoTrack.enabled));
  micButton.setAttribute('aria-label', audioTrack?.enabled ? 'Выключить микрофон' : 'Включить микрофон');
  micButton.title = audioTrack?.enabled ? 'Выключить микрофон' : 'Включить микрофон';
  document.querySelector('#micLabel').textContent = audioTrack?.enabled ? 'ЗВУК ВКЛ' : 'ЗВУК ВЫКЛ';
  cameraButton.setAttribute('aria-label', videoTrack?.enabled ? 'Выключить камеру' : 'Включить камеру');
  cameraButton.title = videoTrack?.enabled ? 'Выключить камеру' : 'Включить камеру';
  document.querySelector('#cameraLabel').textContent = videoTrack?.enabled ? 'КАМЕРА ВКЛ' : 'КАМЕРА ВЫКЛ';
  localPlaceholder.hidden = Boolean(videoTrack?.enabled);
  localPlaceholder.querySelector('span:last-child').textContent = hasMedia ? 'Камера выключена' : 'Ваше видео';
}

function clearPeer() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
    peerConnection = null;
  }
  pendingCandidates = [];
  remoteVideo.srcObject = null;
  remotePlaceholder.hidden = false;
  remoteStatus.textContent = 'Собеседник появится здесь';
}

function makePeerConnection() {
  clearPeer();
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remotePlaceholder.hidden = true;
    document.querySelector('#remoteLabel').textContent = 'ВЫ НА СВЯЗИ';
  };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket?.connected) socket.emit('signal', { type: 'candidate', candidate: event.candidate });
  };
  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === 'connected') setConnectionStatus('ВЫ НА СВЯЗИ');
    if (peerConnection.connectionState === 'failed') {
      setConnectionStatus('НЕ УДАЛОСЬ СОЕДИНИТЬСЯ');
      showToast('Не удалось соединить видео. Нажмите «Следующий», чтобы попробовать ещё раз.');
    }
  };
}

async function addCandidate(candidate) {
  if (!peerConnection) return;
  if (peerConnection.remoteDescription) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } else {
    pendingCandidates.push(candidate);
  }
}

async function applyPendingCandidates() {
  const candidates = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of candidates) {
    if (peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

async function handleSignal(signal) {
  if (!peerConnection || !signal) return;
  try {
    if (signal.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
      await applyPendingCandidates();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer.sdp });
    } else if (signal.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
      await applyPendingCandidates();
    } else if (signal.type === 'candidate') {
      await addCandidate(signal.candidate);
    }
  } catch (error) {
    console.error('WebRTC signaling error:', error);
    showToast('Не удалось установить видеосвязь. Попробуйте следующего собеседника.');
  }
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io();
  socket.on('connect', () => {
    if (isSearching && !isMatched && !isWaiting) socket.emit('find-partner');
  });
  socket.on('connect_error', (error) => {
    if (error.message === 'AUTH_REQUIRED') showToast('Сессия завершилась. Войдите снова.');
    else showToast('Не удалось подключиться к серверу. Обновите страницу и попробуйте снова.');
  });
  socket.on('online-count', (count) => { document.querySelector('#onlineCount').textContent = String(count); });
  socket.on('waiting', () => {
    isWaiting = true;
    isMatched = false;
    setConnectionStatus('ИЩЕМ СОБЕСЕДНИКА', true);
    remoteStatus.textContent = 'Подбираем случайную встречу…';
    updateNextButton();
  });
  socket.on('matched', async ({ initiator }) => {
    isWaiting = false;
    isMatched = true;
    meetings += 1;
    document.querySelector('#meetingCount').textContent = String(meetings).padStart(2, '0');
    document.querySelector('#remoteLabel').textContent = 'НОВЫЙ СОБЕСЕДНИК';
    remoteStatus.textContent = 'Устанавливаем видеосвязь…';
    setConnectionStatus('СОЕДИНЯЕМ ВАС');
    updateNextButton();
    try {
      makePeerConnection();
      if (initiator) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { type: 'offer', sdp: offer.sdp });
      }
    } catch (error) {
      console.error('Could not start WebRTC:', error);
      showToast('Браузер не смог начать видеосвязь. Попробуйте ещё раз.');
      setConnectionStatus('НЕ УДАЛОСЬ СОЕДИНИТЬСЯ');
    }
  });
  socket.on('signal', handleSignal);
  socket.on('partner-left', () => {
    isMatched = false;
    isWaiting = false;
    clearPeer();
    setConnectionStatus('СОБЕСЕДНИК ВЫШЕЛ');
    remoteStatus.textContent = 'Собеседник завершил разговор';
    updateNextButton();
  });
  socket.on('disconnect', () => {
    isWaiting = false;
    clearPeer();
    setConnectionStatus('НЕТ СОЕДИНЕНИЯ');
    updateNextButton();
  });
}

async function ensureLocalMedia() {
  if (localStream?.getTracks().some((track) => track.readyState === 'live')) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Камера и микрофон доступны только по HTTPS или на localhost.');
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (error) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      throw new Error('Разрешите доступ к камере и микрофону в настройках браузера.');
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      throw new Error('Камера или микрофон не найдены. Подключите устройства и попробуйте снова.');
    }
    throw new Error('Не удалось включить камеру и микрофон. Проверьте настройки устройств.');
  }
  localVideo.srcObject = localStream;
  updateLocalControls();
}

nextButton.addEventListener('click', async () => {
  nextButton.disabled = true;
  try {
    await ensureLocalMedia();
    clearPeer();
    isMatched = false;
    isWaiting = false;
    isSearching = true;
    setConnectionStatus('ИЩЕМ СОБЕСЕДНИКА', true);
    remoteStatus.textContent = 'Подбираем случайную встречу…';
    updateNextButton();
    if (socket?.connected) socket.emit('next-partner');
    else if (socket) socket.once('connect', () => socket.emit('find-partner'));
  } catch (error) {
    showToast(error.message);
    updateNextButton();
  }
});

micButton.addEventListener('click', () => {
  const track = localStream?.getAudioTracks()[0];
  if (track) { track.enabled = !track.enabled; updateLocalControls(); }
});

cameraButton.addEventListener('click', () => {
  const track = localStream?.getVideoTracks()[0];
  if (track) { track.enabled = !track.enabled; updateLocalControls(); }
});

document.querySelector('#logoutButton').addEventListener('click', async () => {
  isSearching = false;
  if (socket) socket.disconnect();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  localStream = null;
  socket = null;
  chatScreen.hidden = true;
  authScreen.hidden = false;
  authForm.reset();
  updateAuthMode('login');
});

updateAuthMode('register');
initialize();
