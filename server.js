const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const http = require('node:http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, 'data');
const usersFile = path.join(dataDirectory, 'users.json');
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-secret-change-before-deploying');

if (!sessionSecret) throw new Error('Set SESSION_SECRET before starting in production.');

fs.mkdirSync(dataDirectory, { recursive: true });
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '[]', 'utf8');

function readUsers() {
  return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
}

function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), 'utf8');
}

const sessionMiddleware = session({
  name: 'chat.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 },
});

app.use(express.json({ limit: '16kb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_request, response) => {
  response.status(200).send('ok');
});

function publicUser(user) {
  return { firstName: user.firstName, lastName: user.lastName, birthYear: user.birthYear, email: user.email };
}

function saveUserSession(request, response, user, status = 200) {
  request.session.regenerate((regenerateError) => {
    if (regenerateError) return response.status(500).json({ error: 'Не удалось создать сессию.' });
    request.session.userId = user.id;
    request.session.save((saveError) => {
      if (saveError) return response.status(500).json({ error: 'Не удалось сохранить сессию.' });
      response.status(status).json({ user: publicUser(user) });
    });
  });
}

function requireAuth(request, response, next) {
  if (!request.session.userId) return response.status(401).json({ error: 'Войдите в аккаунт, чтобы продолжить.' });
  const user = readUsers().find((entry) => entry.id === request.session.userId);
  if (!user) {
    request.session.destroy(() => {});
    return response.status(401).json({ error: 'Сессия завершилась. Войдите снова.' });
  }
  request.user = user;
  next();
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = storedHash.split(':');
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      const expected = Buffer.from(key, 'hex');
      resolve(expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

app.post('/api/register', async (request, response) => {
  const firstName = String(request.body.firstName || '').trim();
  const lastName = String(request.body.lastName || '').trim();
  const email = String(request.body.email || '').trim().toLowerCase();
  const password = String(request.body.password || '');
  const birthYear = Number(request.body.birthYear);
  const currentYear = new Date().getFullYear();

  if (!firstName || firstName.length > 50 || !lastName || lastName.length > 50) {
    return response.status(400).json({ error: 'Укажите имя и фамилию (до 50 символов).' });
  }
  if (!/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@gmail\.com$/i.test(email)) {
    return response.status(400).json({ error: 'Для регистрации нужен адрес Gmail.' });
  }
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > currentYear - 18) {
    return response.status(400).json({ error: 'Сервис доступен только пользователям от 18 лет.' });
  }
  if (password.length < 8 || password.length > 128) {
    return response.status(400).json({ error: 'Пароль должен содержать от 8 до 128 символов.' });
  }

  const users = readUsers();
  if (users.some((user) => user.email === email)) {
    return response.status(409).json({ error: 'Этот Gmail уже зарегистрирован.' });
  }

  try {
    const user = {
      id: crypto.randomUUID(),
      firstName,
      lastName,
      birthYear,
      email,
      passwordHash: await hashPassword(password),
    };
    users.push(user);
    writeUsers(users);
    saveUserSession(request, response, user, 201);
  } catch {
    response.status(500).json({ error: 'Не удалось создать аккаунт. Попробуйте ещё раз.' });
  }
});

app.post('/api/login', async (request, response) => {
  const email = String(request.body.email || '').trim().toLowerCase();
  const password = String(request.body.password || '');
  const user = readUsers().find((entry) => entry.email === email);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return response.status(401).json({ error: 'Неверный Gmail или пароль.' });
  }
  saveUserSession(request, response, user);
});

app.get('/api/me', requireAuth, (request, response) => {
  response.json({ user: publicUser(request.user) });
});

app.post('/api/logout', (request, response) => {
  request.session.destroy((error) => {
    if (error) return response.status(500).json({ error: 'Не удалось завершить сессию.' });
    response.clearCookie('chat.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    response.json({ ok: true });
  });
});

const waiting = [];
const waitingSet = new Set();
const partnerBySocket = new Map();

function broadcastOnlineCount() {
  io.emit('online-count', io.engine.clientsCount);
}

function removeFromWaiting(socketId) {
  if (!waitingSet.delete(socketId)) return;
  const index = waiting.indexOf(socketId);
  if (index !== -1) waiting.splice(index, 1);
}

function findPartner(socket) {
  removeFromWaiting(socket.id);
  if (partnerBySocket.has(socket.id)) return;

  let partnerId;
  while (waiting.length && !partnerId) {
    const candidateId = waiting.shift();
    waitingSet.delete(candidateId);
    const candidate = io.sockets.sockets.get(candidateId);
    if (candidate?.connected && candidateId !== socket.id && !partnerBySocket.has(candidateId)) {
      partnerId = candidateId;
    }
  }

  if (!partnerId) {
    waiting.push(socket.id);
    waitingSet.add(socket.id);
    socket.emit('waiting');
    return;
  }

  partnerBySocket.set(socket.id, partnerId);
  partnerBySocket.set(partnerId, socket.id);
  const socketStarts = crypto.randomInt(2) === 0;
  socket.emit('matched', { initiator: socketStarts });
  io.to(partnerId).emit('matched', { initiator: !socketStarts });
}

function detachPartner(socket, notify = true) {
  const partnerId = partnerBySocket.get(socket.id);
  if (!partnerId) return;
  partnerBySocket.delete(socket.id);
  partnerBySocket.delete(partnerId);
  if (notify) io.to(partnerId).emit('partner-left');
}

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('AUTH_REQUIRED'));
  socket.userId = socket.request.session.userId;
  next();
});

io.on('connection', (socket) => {
  broadcastOnlineCount();

  socket.on('find-partner', () => findPartner(socket));
  socket.on('signal', (signal) => {
    const partnerId = partnerBySocket.get(socket.id);
    if (partnerId) io.to(partnerId).emit('signal', signal);
  });
  socket.on('next-partner', () => {
    removeFromWaiting(socket.id);
    detachPartner(socket);
    findPartner(socket);
  });
  socket.on('stop-search', () => {
    removeFromWaiting(socket.id);
    detachPartner(socket);
  });
  socket.on('disconnect', () => {
    removeFromWaiting(socket.id);
    detachPartner(socket);
    broadcastOnlineCount();
  });
});

server.listen(port, () => {
  console.log(`Chat app is running at http://localhost:${port}`);
});
