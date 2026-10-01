const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const { Server } = require("socket.io");

const APP_VERSION = "1.0.0";
const API_VERSION = "v1";

const PORT = process.env.PORT || 3000;
const JWT_SECRET =
  process.env.JWT_SECRET || "CAMBIA_ESTA_CLAVE_EN_RENDER";

const MAX_PLAYERS_PER_ROOM = 8;
const ARENA_SIZE = 15;
const PLAYER_SPEED = 5;
const PLAYER_RADIUS = 0.55;
const ATTACK_DISTANCE = 2.0;
const ATTACK_DAMAGE = 25;
const ATTACK_COOLDOWN = 650;
const RESPAWN_TIME = 2500;

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultDatabase() {
  return {
    schemaVersion: 1,
    users: {}
  };
}

function loadDatabase() {
  if (!fs.existsSync(USERS_FILE)) {
    const db = defaultDatabase();
    saveDatabase(db);
    return db;
  }

  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const db = JSON.parse(raw);

    if (!db.schemaVersion) {
      db.schemaVersion = 1;
    }

    if (!db.users) {
      db.users = {};
    }

    return db;
  } catch (error) {
    console.error("No se pudo leer users.json:", error);
    return defaultDatabase();
  }
}

function saveDatabase(db) {
  const temp = USERS_FILE + ".tmp";

  fs.writeFileSync(
    temp,
    JSON.stringify(db, null, 2),
    "utf8"
  );

  fs.renameSync(temp, USERS_FILE);
}

let database = loadDatabase();

function migrateDatabase() {
  if (!database.schemaVersion) {
    database.schemaVersion = 1;
  }

  if (!database.users) {
    database.users = {};
  }

  saveDatabase(database);
}

migrateDatabase();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "50kb" }));

app.use(express.static(path.join(__dirname, "public")));

const onlinePlayers = new Map();
const rooms = new Map();
const socketUsers = new Map();

function cleanText(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, maxLength);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generatePlayerId() {
  let id;

  do {
    const random = crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase();

    id = `PLR-${random}`;
  } while (database.users[id]);

  return id;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code;

  do {
    code = "";

    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

function createToken(user) {
  return jwt.sign(
    {
      playerId: user.playerId,
      email: user.email
    },
    JWT_SECRET,
    {
      expiresIn: "30d"
    }
  );
}

function getUserFromToken(token) {
  if (!token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    return database.users[payload.playerId] || null;
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "No autenticado"
    });
  }

  const token = header.substring(7);
  const user = getUserFromToken(token);

  if (!user) {
    return res.status(401).json({
      error: "Sesión inválida o expirada"
    });
  }

  req.user = user;
  next();
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    playerId: user.playerId,
    name: user.name,
    createdAt: user.createdAt
  };
}

function getRoomPlayers(room) {
  return [...room.players.values()].map((player) => ({
    playerId: player.playerId,
    name: player.name,
    x: player.x,
    z: player.z,
    rotation: player.rotation,
    health: player.health,
    maxHealth: player.maxHealth,
    score: player.score,
    alive: player.alive
  }));
}

function sendRoomState(room) {
  io.to(room.code).emit("gameState", {
    version: APP_VERSION,
    roomCode: room.code,
    players: getRoomPlayers(room),
    timestamp: Date.now()
  });
}

function randomSpawn() {
  const limit = ARENA_SIZE / 2 - 1;

  return {
    x: (Math.random() * 2 - 1) * limit,
    z: (Math.random() * 2 - 1) * limit
  };
}

function createPlayerState(user) {
  const spawn = randomSpawn();

  return {
    playerId: user.playerId,
    name: user.name,

    x: spawn.x,
    z: spawn.z,

    rotation: 0,

    health: 100,
    maxHealth: 100,

    score: 0,

    alive: true,

    lastAttack: 0,
    respawnAt: 0
  };
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;

  return Math.sqrt(dx * dx + dz * dz);
}

function clampPlayer(player) {
  const limit =
    ARENA_SIZE / 2 - PLAYER_RADIUS;

  player.x = Math.max(
    -limit,
    Math.min(limit, player.x)
  );

  player.z = Math.max(
    -limit,
    Math.min(limit, player.z)
  );
}

function leaveRoom(socket) {
  const playerId = socketUsers.get(socket.id);

  if (!playerId) {
    return;
  }

  const roomCode = socket.data.roomCode;

  if (!roomCode) {
    return;
  }

  const room = rooms.get(roomCode);

  if (!room) {
    socket.data.roomCode = null;
    return;
  }

  room.players.delete(playerId);

  socket.leave(roomCode);

  socket.data.roomCode = null;

  io.to(roomCode).emit("playerLeft", {
    playerId
  });

  if (room.players.size === 0) {
    rooms.delete(roomCode);
  } else {
    sendRoomState(room);
  }
}

function findRoomOfPlayer(playerId) {
  const online = onlinePlayers.get(playerId);

  if (!online) {
    return null;
  }

  return online.socket.data.roomCode || null;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    api: API_VERSION,
    playersOnline: onlinePlayers.size,
    rooms: rooms.size,
    time: Date.now()
  });
});

app.get("/api/version", (req, res) => {
  res.json({
    version: APP_VERSION,
    apiVersion: API_VERSION
  });
});

app.post("/api/register", (req, res) => {
  const name = cleanText(req.body.name, 20);
  const email = cleanText(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || "");

  if (name.length < 3) {
    return res.status(400).json({
      error: "El nombre debe tener al menos 3 caracteres."
    });
  }

  if (!validEmail(email)) {
    return res.status(400).json({
      error: "Email inválido."
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "La contraseña debe tener al menos 6 caracteres."
    });
  }

  const existing = Object.values(database.users).find(
    (user) => user.email === email
  );

  if (existing) {
    return res.status(409).json({
      error: "Ese email ya está registrado."
    });
  }

  const playerId = generatePlayerId();

  const user = {
    playerId,
    name,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  database.users[playerId] = user;

  saveDatabase(database);

  const token = createToken(user);

  res.json({
    ok: true,
    token,
    user: publicUser(user),
    version: APP_VERSION
  });
});

app.post("/api/login", (req, res) => {
  const email = cleanText(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || "");

  const user = Object.values(database.users).find(
    (item) => item.email === email
  );

  if (!user) {
    return res.status(401).json({
      error: "Email o contraseña incorrectos."
    });
  }

  const valid = bcrypt.compareSync(
    password,
    user.passwordHash
  );

  if (!valid) {
    return res.status(401).json({
      error: "Email o contraseña incorrectos."
    });
  }

  const token = createToken(user);

  res.json({
    ok: true,
    token,
    user: publicUser(user),
    version: APP_VERSION
  });
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({
    ok: true,
    user: publicUser(req.user),
    online: onlinePlayers.has(req.user.playerId),
    roomCode:
      findRoomOfPlayer(req.user.playerId) || null,
    version: APP_VERSION
  });
});

app.get(
  "/api/player/:playerId",
  authMiddleware,
  (req, res) => {
    const playerId = cleanText(
      req.params.playerId,
      30
    ).toUpperCase();

    const user = database.users[playerId];

    if (!user) {
      return res.status(404).json({
        error: "Jugador no encontrado."
      });
    }

    res.json({
      ok: true,
      player: {
        ...publicUser(user),
        online: onlinePlayers.has(playerId),
        roomCode: findRoomOfPlayer(playerId)
      }
    });
  }
);

io.use((socket, next) => {
  const token =
    socket.handshake.auth &&
    socket.handshake.auth.token;

  const user = getUserFromToken(token);

  if (!user) {
    return next(
      new Error("No autenticado")
    );
  }

  socket.user = user;
  next();
});

io.on("connection", (socket) => {
  const user = socket.user;

  socketUsers.set(socket.id, user.playerId);

  onlinePlayers.set(user.playerId, {
    socket,
    name: user.name
  });

  socket.emit("connected", {
    playerId: user.playerId,
    name: user.name,
    version: APP_VERSION
  });

  socket.on("createRoom", () => {
    leaveRoom(socket);

    const code = generateRoomCode();

    const room = {
      code,
      createdAt: Date.now(),
      hostId: user.playerId,
      players: new Map()
    };

    rooms.set(code, room);

    room.players.set(
      user.playerId,
      createPlayerState(user)
    );

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("roomCreated", {
      code,
      hostId: user.playerId
    });

    sendRoomState(room);
  });

  socket.on("joinRoom", (rawCode) => {
    const code = cleanText(rawCode, 10)
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return socket.emit("errorMessage", {
        message: "La sala no existe."
      });
    }

    if (
      room.players.size >=
      MAX_PLAYERS_PER_ROOM
    ) {
      return socket.emit("errorMessage", {
        message: "La sala está llena."
      });
    }

    leaveRoom(socket);

    room.players.set(
      user.playerId,
      createPlayerState(user)
    );

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit("roomJoined", {
      code,
      hostId: room.hostId
    });

    io.to(code).emit("playerJoined", {
      player: publicUser(user)
    });

    sendRoomState(room);
  });

  socket.on("leaveRoom", () => {
    leaveRoom(socket);
  });

  socket.on("invitePlayer", (rawPlayerId) => {
    const targetId = cleanText(
      rawPlayerId,
      30
    ).toUpperCase();

    const target = onlinePlayers.get(targetId);

    if (!database.users[targetId]) {
      return socket.emit("errorMessage", {
        message: "Ese jugador no existe."
      });
    }

    if (!target) {
      return socket.emit("errorMessage", {
        message: "El jugador está desconectado."
      });
    }

    const roomCode = socket.data.roomCode;

    if (!roomCode) {
      return socket.emit("errorMessage", {
        message: "Primero debes crear o entrar a una sala."
      });
    }

    target.socket.emit("friendInvite", {
      from: publicUser(user),
      roomCode
    });

    socket.emit("infoMessage", {
      message: "Invitación enviada."
    });
  });

  socket.on("input", (input) => {
    const roomCode = socket.data.roomCode;

    if (!roomCode) {
      return;
    }

    const room = rooms.get(roomCode);

    if (!room) {
      return;
    }

    const player = room.players.get(
      user.playerId
    );

    if (!player || !player.alive) {
      return;
    }

    let x = Number(input && input.x);
    let z = Number(input && input.z);

    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(z)) z = 0;

    const length = Math.sqrt(
      x * x + z * z
    );

    if (length > 1) {
      x /= length;
      z /= length;
    }

    const dt = 1 / 20;

    player.x +=
      x * PLAYER_SPEED * dt;

    player.z +=
      z * PLAYER_SPEED * dt;

    if (x !== 0 || z !== 0) {
      player.rotation =
        Math.atan2(x, z);
    }

    clampPlayer(player);

    if (input && input.attack) {
      performAttack(room, player);
    }
  });

  socket.on("chat", (rawMessage) => {
    const roomCode = socket.data.roomCode;

    if (!roomCode) {
      return;
    }

    const message = cleanText(
      rawMessage,
      150
    );

    if (!message) {
      return;
    }

    io.to(roomCode).emit("chat", {
      playerId: user.playerId,
      name: user.name,
      message,
      time: Date.now()
    });
  });

  socket.on("disconnect", () => {
    const playerId =
      socketUsers.get(socket.id);

    socketUsers.delete(socket.id);

    const current =
      onlinePlayers.get(playerId);

    if (
      current &&
      current.socket.id === socket.id
    ) {
      onlinePlayers.delete(playerId);
    }

    leaveRoom(socket);
  });
});

function performAttack(room, attacker) {
  const now = Date.now();

  if (
    now - attacker.lastAttack <
    ATTACK_COOLDOWN
  ) {
    return;
  }

  attacker.lastAttack = now;

  io.to(room.code).emit("attack", {
    playerId: attacker.playerId,
    time: now
  });

  for (const target of room.players.values()) {
    if (
      target.playerId ===
      attacker.playerId
    ) {
      continue;
    }

    if (!target.alive) {
      continue;
    }

    const d = distance(
      attacker,
      target
    );

    if (d <= ATTACK_DISTANCE) {
      target.health -= ATTACK_DAMAGE;

      io.to(room.code).emit(
        "damage",
        {
          attackerId:
            attacker.playerId,
          targetId:
            target.playerId,
          damage:
            ATTACK_DAMAGE,
          health:
            Math.max(
              0,
              target.health
            )
        }
      );

      if (target.health <= 0) {
        target.health = 0;
        target.alive = false;
        target.respawnAt =
          Date.now() +
          RESPAWN_TIME;

        attacker.score += 1;

        io.to(room.code).emit(
          "playerDefeated",
          {
            attackerId:
              attacker.playerId,
            targetId:
              target.playerId
          }
        );
      }
    }
  }
}

function updateRespawns() {
  const now = Date.now();

  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (
        !player.alive &&
        player.respawnAt &&
        now >= player.respawnAt
      ) {
        const spawn =
          randomSpawn();

        player.x = spawn.x;
        player.z = spawn.z;

        player.health =
          player.maxHealth;

        player.alive = true;
        player.respawnAt = 0;

        io.to(room.code).emit(
          "playerRespawned",
          {
            playerId:
              player.playerId
          }
        );
      }
    }
  }
}

setInterval(() => {
  updateRespawns();

  for (const room of rooms.values()) {
    sendRoomState(room);
  }
}, 1000 / 15);

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Servidor iniciado en puerto ${PORT}`
    );

    console.log(
      `Version ${APP_VERSION}`
    );
  }
);
