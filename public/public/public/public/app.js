const CLIENT_VERSION = "1.0.0";

let token =
  localStorage.getItem("arena_token");

let currentUser = null;
let socket = null;

let scene;
let camera;
let renderer;
let clock;

let gameRunning = false;

const playerMeshes = new Map();

const keys = {
  up: false,
  down: false,
  left: false,
  right: false,
  attack: false
};

let lastInput = 0;

const inputInterval = 50;

const $ = (id) =>
  document.getElementById(id);

function show(id) {
  $(id).classList.remove("hidden");
}

function hide(id) {
  $(id).classList.add("hidden");
}

function message(elementId, text) {
  $(elementId).textContent = text;
}

function notify(text) {
  const box = $("notification");

  box.textContent = text;

  show("notification");

  setTimeout(() => {
    hide("notification");
  }, 3000);
}

function saveToken(value) {
  token = value;

  localStorage.setItem(
    "arena_token",
    value
  );
}

function clearSession() {
  token = null;
  currentUser = null;

  localStorage.removeItem(
    "arena_token"
  );
}

async function api(url, options = {}) {
  const headers = {
    "Content-Type":
      "application/json",
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization =
      `Bearer ${token}`;
  }

  const response = await fetch(
    url,
    {
      ...options,
      headers
    }
  );

  const data =
    await response.json()
      .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error ||
      "Error del servidor"
    );
  }

  return data;
}

function showLogin() {
  $("loginTab")
    .classList.add("active");

  $("registerTab")
    .classList.remove("active");

  show("loginForm");
  hide("registerForm");
}

function showRegister() {
  $("registerTab")
    .classList.add("active");

  $("loginTab")
    .classList.remove("active");

  hide("loginForm");
  show("registerForm");
}

$("loginTab")
  .addEventListener(
    "click",
    showLogin
  );

$("registerTab")
  .addEventListener(
    "click",
    showRegister
  );

$("loginForm")
  .addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      message(
        "authMessage",
        "Iniciando sesión..."
      );

      try {
        const result =
          await api("/api/login", {
            method: "POST",
            body: JSON.stringify({
              email:
                $("loginEmail").value,
              password:
                $("loginPassword").value
            })
          });

        saveToken(result.token);

        currentUser =
          result.user;

        enterLobby();
      } catch (error) {
        message(
          "authMessage",
          error.message
        );
      }
    }
  );

$("registerForm")
  .addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      message(
        "authMessage",
        "Creando cuenta..."
      );

      try {
        const result =
          await api("/api/register", {
            method: "POST",
            body: JSON.stringify({
              name:
                $("registerName").value,
              email:
                $("registerEmail").value,
              password:
                $("registerPassword").value
            })
          });

        saveToken(result.token);

        currentUser =
          result.user;

        enterLobby();
      } catch (error) {
        message(
          "authMessage",
          error.message
        );
      }
    }
  );

async function checkExistingSession() {
  if (!token) {
    hide("loading");
    show("authScreen");
    return;
  }

  try {
    const result =
      await api("/api/me");

    currentUser =
      result.user;

    enterLobby();
  } catch {
    clearSession();

    show("authScreen");
  }

  hide("loading");
}

function enterLobby() {
  hide("authScreen");
  hide("gameScreen");
  show("lobbyScreen");

  $("playerName").textContent =
    currentUser.name;

  $("playerId").textContent =
    currentUser.playerId;

  connectSocket();
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io({
    auth: {
      token
    }
  });

  socket.on(
    "connect",
    () => {
      message(
        "lobbyMessage",
        "Conectado al servidor."
      );
    }
  );

  socket.on(
    "connect_error",
    (error) => {
      message(
        "lobbyMessage",
        "Error de conexión: " +
          error.message
      );
    }
  );

  socket.on(
    "connected",
    (data) => {
      console.log(
        "Servidor:",
        data
      );
    }
  );

  socket.on(
    "roomCreated",
    (data) => {
      startGame(data.code);
    }
  );

  socket.on(
    "roomJoined",
    (data) => {
      startGame(data.code);
    }
  );

  socket.on(
    "errorMessage",
    (data) => {
      notify(data.message);
    }
  );

  socket.on(
    "infoMessage",
    (data) => {
      notify(data.message);
    }
  );

  socket.on(
    "gameState",
    (state) => {
      updateGameState(state);
    }
  );

  socket.on(
    "chat",
    (data) => {
      addChatMessage(data);
    }
  );

  socket.on(
    "friendInvite",
    (data) => {
      const accepted =
        confirm(
          `${data.from.name} (${data.from.playerId}) te invitó a una partida.\n\nSala: ${data.roomCode}\n\n¿Entrar?`
        );

      if (accepted) {
        socket.emit(
          "joinRoom",
          data.roomCode
        );
      }
    }
  );

  socket.on(
    "attack",
    (data) => {
      animateAttack(
        data.playerId
      );
    }
  );

  socket.on(
    "damage",
    (data) => {
      if (
        data.targetId ===
        currentUser.playerId
      ) {
        updateHealth(
          data.health,
          100
        );
      }
    }
  );

  socket.on(
    "playerDefeated",
    (data) => {
      if (
        data.targetId ===
        currentUser.playerId
      ) {
        notify(
          "Has sido derrotado."
        );
      }

      if (
        data.attackerId ===
        currentUser.playerId
      ) {
        notify(
          "+1 punto"
        );
      }
    }
  );

  socket.on(
    "playerRespawned",
    (data) => {
      if (
        data.playerId ===
        currentUser.playerId
      ) {
        notify(
          "Has reaparecido."
        );
      }
    }
  );

  socket.on(
    "playerJoined",
    (data) => {
      notify(
        `${data.player.name} entró a la sala.`
      );
    }
  );

  socket.on(
    "playerLeft",
    (data) => {
      removePlayerMesh(
        data.playerId
      );
    }
  );
}

$("createRoomButton")
  .addEventListener(
    "click",
    () => {
      if (!socket) {
        return;
      }

      socket.emit(
        "createRoom"
      );
    }
  );

$("joinRoomButton")
  .addEventListener(
    "click",
    () => {
      const code =
        $("roomCodeInput")
          .value
          .trim()
          .toUpperCase();

      if (
        code.length !== 6
      ) {
        message(
          "lobbyMessage",
          "El código debe tener 6 caracteres."
        );

        return;
      }

      socket.emit(
        "joinRoom",
        code
      );
    }
  );

$("inviteButton")
  .addEventListener(
    "click",
    () => {
      const id =
        $("friendIdInput")
          .value
          .trim()
          .toUpperCase();

      if (!id) {
        message(
          "lobbyMessage",
          "Escribe el ID del jugador."
        );

        return;
      }

      socket.emit(
        "invitePlayer",
        id
      );
    }
  );

$("logoutButton")
  .addEventListener(
    "click",
    () => {
      if (socket) {
        socket.disconnect();
        socket = null;
      }

      clearSession();

      hide("lobbyScreen");
      hide("gameScreen");

      show("authScreen");

      showLogin();
    }
  );

$("leaveGameButton")
  .addEventListener(
    "click",
    () => {
      if (socket) {
        socket.emit(
          "leaveRoom"
        );
      }

      stopGame();

      hide("gameScreen");
      show("lobbyScreen");
    }
  );

function startGame(roomCode) {
  hide("lobbyScreen");
  show("gameScreen");

  $("roomCodeDisplay")
    .textContent = roomCode;

  initializeThree();

  gameRunning = true;

  requestAnimationFrame(
    renderLoop
  );

  notify(
    "Entraste a la sala " +
      roomCode
  );
}

function stopGame() {
  gameRunning = false;

  for (
    const mesh
    of playerMeshes.values()
  ) {
    scene?.remove(mesh);
  }

  playerMeshes.clear();

  if (renderer) {
    renderer.dispose();
  }

  const container =
    $("gameContainer");

  container.innerHTML = "";

  scene = null;
  camera = null;
  renderer = null;
}

function initializeThree() {
  const container =
    $("gameContainer");

  container.innerHTML = "";

  scene =
    new THREE.Scene();

  scene.background =
    new THREE.Color(
      0x080b12
    );

  scene.fog =
    new THREE.Fog(
      0x080b12,
      20,
      45
    );

  camera =
    new THREE.PerspectiveCamera(
      60,
      window.innerWidth /
        window.innerHeight,
      0.1,
      100
    );

  camera.position.set(
    0,
    14,
    14
  );

  camera.lookAt(
    0,
    0,
    0
  );

  renderer =
    new THREE.WebGLRenderer({
      antialias: true
    });

  renderer.setPixelRatio(
    Math.min(
      window.devicePixelRatio,
      2
    )
  );

  renderer.setSize(
    window.innerWidth,
    window.innerHeight
  );

  container.appendChild(
    renderer.domElement
  );

  clock =
    new THREE.Clock();

  createWorld();

  window.addEventListener(
    "resize",
    resizeGame
  );
}

function createWorld() {
  const ambient =
    new THREE.AmbientLight(
      0xffffff,
      1.5
    );

  scene.add(
    ambient
  );

  const directional =
    new THREE.DirectionalLight(
      0xffffff,
      2
    );

  directional.position.set(
    5,
    15,
    5
  );

  scene.add(
    directional
  );

  const floorGeometry =
    new THREE.BoxGeometry(
      15,
      0.2,
      15
    );

  const floorMaterial =
    new THREE.MeshStandardMaterial({
      color: 0x202838,
      roughness: .9
    });

  const floor =
    new THREE.Mesh(
      floorGeometry,
      floorMaterial
    );

  floor.position.y = -0.1;

  scene.add(floor);

  const grid =
    new THREE.GridHelper(
      15,
      15,
      0x53617a,
      0x2c3545
    );

  grid.position.y = 0.02;

  scene.add(grid);

  createWall(
    0,
    1,
    -7.6,
    15,
    .4
  );

  createWall(
    0,
    1,
    7.6,
    15,
    .4
  );

  createWall(
    -7.6,
    1,
    0,
    .4,
    15
  );

  createWall(
    7.6,
    1,
    0,
    .4,
    15
  );

  for (let i = 0; i < 12; i++) {
    createDecoration();
  }
}

function createWall(
  x,
  y,
  z,
  width,
  depth
) {
  const geometry =
    new THREE.BoxGeometry(
      width,
      2,
      depth
    );

  const material =
    new THREE.MeshStandardMaterial({
      color: 0x111827
    });

  const wall =
    new THREE.Mesh(
      geometry,
      material
    );

  wall.position.set(
    x,
    y,
    z
  );

  scene.add(wall);
}

function createDecoration() {
  const geometry =
    new THREE.BoxGeometry(
      .5,
      1,
      .5
    );

  const material =
    new THREE.MeshStandardMaterial({
      color: 0x39455c
    });

  const object =
    new THREE.Mesh(
      geometry,
      material
    );

  object.position.set(
    (Math.random() * 2 - 1) * 6,
    .5,
    (Math.random() * 2 - 1) * 6
  );

  scene.add(object);
}

function createPlayerMesh(
  player
) {
  const group =
    new THREE.Group();

  const bodyGeometry =
    new THREE.CapsuleGeometry(
      .42,
      .9,
      6,
      12
    );

  const bodyMaterial =
    new THREE.MeshStandardMaterial({
      color:
        player.playerId ===
        currentUser.playerId
          ? 0x3974ff
          : 0xff4757
    });

  const body =
    new THREE.Mesh(
      bodyGeometry,
      bodyMaterial
    );

  body.position.y =
    1;

  group.add(body);

  const headGeometry =
    new THREE.SphereGeometry(
      .35,
      16,
      16
    );

  const headMaterial =
    new THREE.MeshStandardMaterial({
      color: 0xe8c5a0
    });

  const head =
    new THREE.Mesh(
      headGeometry,
      headMaterial
    );

  head.position.y =
    1.85;

  group.add(head);

  const weaponGeometry =
    new THREE.BoxGeometry(
      .12,
      .12,
      .9
    );

  const weaponMaterial =
    new THREE.MeshStandardMaterial({
      color: 0xd5dbe8,
      metalness: .8
    });

  const weapon =
    new THREE.Mesh(
      weaponGeometry,
      weaponMaterial
    );

  weapon.position.set(
    .55,
    1,
    .25
  );

  weapon.rotation.x =
    Math.PI / 2;

  group.add(weapon);

  group.position.set(
    player.x,
    0,
    player.z
  );

  group.rotation.y =
    player.rotation;

  scene.add(group);

  group.userData.playerId =
    player.playerId;

  group.userData.attackTimer =
    0;

  playerMeshes.set(
    player.playerId,
    group
  );

  return group;
}

function updateGameState(state) {
  if (!gameRunning) {
    return;
  }

  $("playersCount")
    .textContent =
      state.players.length;

  let myPlayer = null;

  const existing =
    new Set();

  for (
    const player
    of state.players
  ) {
    existing.add(
      player.playerId
    );

    if (
      player.playerId ===
      currentUser.playerId
    ) {
      myPlayer = player;
    }

    let mesh =
      playerMeshes.get(
        player.playerId
      );

    if (!mesh) {
      mesh =
        createPlayerMesh(
          player
        );
    }

    mesh.position.x =
      player.x;

    mesh.position.z =
      player.z;

    mesh.rotation.y =
      player.rotation;

    mesh.visible =
      player.alive;

    mesh.userData.health =
      player.health;

    mesh.userData.score =
      player.score;
  }

  for (
    const [playerId]
    of playerMeshes
  ) {
    if (!existing.has(playerId)) {
      removePlayerMesh(
        playerId
      );
    }
  }

  if (myPlayer) {
    updateHealth(
      myPlayer.health,
      myPlayer.maxHealth
    );

    $("scoreDisplay")
      .textContent =
        myPlayer.score;
  }
}

function removePlayerMesh(
  playerId
) {
  const mesh =
    playerMeshes.get(
      playerId
    );

  if (!mesh) {
    return;
  }

  scene.remove(mesh);

  playerMeshes.delete(
    playerId
  );
}

function updateHealth(
  health,
  maxHealth
) {
  const percentage =
    Math.max(
      0,
      Math.min(
        100,
        (health / maxHealth) * 100
      )
    );

  $("healthBar")
    .style.width =
      percentage + "%";

  $("healthText")
    .textContent =
      `${health} / ${maxHealth}`;
}

function animateAttack(
  playerId
) {
  const mesh =
    playerMeshes.get(
      playerId
    );

  if (!mesh) {
    return;
  }

  mesh.userData.attackTimer =
    0.25;

  mesh.scale.set(
    1.25,
    1.1,
    1.25
  );

  setTimeout(() => {
    if (mesh) {
      mesh.scale.set(
        1,
        1,
        1
      );
    }
  }, 180);
}

function resizeGame() {
  if (!renderer || !camera) {
    return;
  }

  camera.aspect =
    window.innerWidth /
    window.innerHeight;

  camera.updateProjectionMatrix();

  renderer.setSize(
    window.innerWidth,
    window.innerHeight
  );
}

function sendInput() {
  if (
    !socket ||
    !socket.connected ||
    !gameRunning
  ) {
    return;
  }

  let x = 0;
  let z = 0;

  if (keys.left) {
    x -= 1;
  }

  if (keys.right) {
    x += 1;
  }

  if (keys.up) {
    z -= 1;
  }

  if (keys.down) {
    z += 1;
  }

  socket.emit(
    "input",
    {
      x,
      z,
      attack: keys.attack
    }
  );

  keys.attack = false;
}

window.addEventListener(
  "keydown",
  (event) => {
    if (
      event.code ===
      "KeyW" ||
      event.code ===
      "ArrowUp"
    ) {
      keys.up = true;
    }

    if (
      event.code ===
      "KeyS" ||
      event.code ===
      "ArrowDown"
    ) {
      keys.down = true;
    }

    if (
      event.code ===
      "KeyA" ||
      event.code ===
      "ArrowLeft"
    ) {
      keys.left = true;
    }

    if (
      event.code ===
      "KeyD" ||
      event.code ===
      "ArrowRight"
    ) {
      keys.right = true;
    }

    if (
      event.code ===
      "Space"
    ) {
      event.preventDefault();

      keys.attack = true;
    }
  }
);

window.addEventListener(
  "keyup",
  (event) => {
    if (
      event.code ===
      "KeyW" ||
      event.code ===
      "ArrowUp"
    ) {
      keys.up = false;
    }

    if (
      event.code ===
      "KeyS" ||
      event.code ===
      "ArrowDown"
    ) {
      keys.down = false;
    }

    if (
      event.code ===
      "KeyA" ||
      event.code ===
      "ArrowLeft"
    ) {
      keys.left = false;
    }

    if (
      event.code ===
      "KeyD" ||
      event.code ===
      "ArrowRight"
    ) {
      keys.right = false;
    }
  }
);

document
  .querySelectorAll(
    ".joystick button"
  )
  .forEach((button) => {
    const key =
      button.dataset.key;

    const start = (event) => {
      event.preventDefault();

      keys[key] = true;
    };

    const end = (event) => {
      event.preventDefault();

      keys[key] = false;
    };

    button.addEventListener(
      "touchstart",
      start,
      {
        passive: false
      }
    );

    button.addEventListener(
      "touchend",
      end,
      {
        passive: false
      }
    );

    button.addEventListener(
      "mousedown",
      start
    );

    button.addEventListener(
      "mouseup",
      end
    );

    button.addEventListener(
      "mouseleave",
      end
    );
  });

$("mobileAttack")
  .addEventListener(
    "touchstart",
    (event) => {
      event.preventDefault();

      keys.attack = true;
    },
    {
      passive: false
    }
  );

$("chatForm")
  .addEventListener(
    "submit",
    (event) => {
      event.preventDefault();

      const input =
        $("chatInput");

      const text =
        input.value.trim();

      if (
        !text ||
        !socket
      ) {
        return;
      }

      socket.emit(
        "chat",
        text
      );

      input.value = "";
    }
  );

function addChatMessage(data) {
  const container =
    $("chatMessages");

  const item =
    document.createElement(
      "div"
    );

  item.className =
    "chat-message";

  const name =
    document.createElement(
      "strong"
    );

  name.textContent =
    data.name + ": ";

  const text =
    document.createTextNode(
      data.message
    );

  item.appendChild(name);
  item.appendChild(text);

  container.appendChild(item);

  container.scrollTop =
    container.scrollHeight;

  while (
    container.children.length >
    30
  ) {
    container.removeChild(
      container.firstChild
    );
  }
}

function renderLoop() {
  if (!gameRunning) {
    return;
  }

  requestAnimationFrame(
    renderLoop
  );

  const now =
    performance.now();

  if (
    now - lastInput >=
    inputInterval
  ) {
    sendInput();

    lastInput = now;
  }

  updateCamera();

  renderer.render(
    scene,
    camera
  );
}

function updateCamera() {
  const me =
    playerMeshes.get(
      currentUser.playerId
    );

  if (!me) {
    return;
  }

  const targetX =
    me.position.x;

  const targetZ =
    me.position.z;

  const desired =
    new THREE.Vector3(
      targetX,
      12,
      targetZ + 10
    );

  camera.position.lerp(
    desired,
    0.08
  );

  camera.lookAt(
    targetX,
    0,
    targetZ
  );
}

checkExistingSession();
