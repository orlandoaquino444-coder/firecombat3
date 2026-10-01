const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

// ===============================
// SOCKET.IO
// ===============================

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ===============================
// ARCHIVOS DEL JUEGO
// ===============================

// Carpeta principal del proyecto
const publicPath = path.join(__dirname, "public");

// Permitir JSON
app.use(express.json());

// Servir archivos del juego
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
} else {
    app.use(express.static(__dirname));
}

// ===============================
// PÁGINA PRINCIPAL
// ===============================

app.get("/", (req, res) => {

    const indexPath = path.join(publicPath, "index.html");

    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }

    const rootIndexPath = path.join(__dirname, "index.html");

    if (fs.existsSync(rootIndexPath)) {
        return res.sendFile(rootIndexPath);
    }

    const gamePath = path.join(publicPath, "juego.html");

    if (fs.existsSync(gamePath)) {
        return res.sendFile(gamePath);
    }

    const rootGamePath = path.join(__dirname, "juego.html");

    if (fs.existsSync(rootGamePath)) {
        return res.sendFile(rootGamePath);
    }

    res.status(404).send(`
        <h1>Videojuego no encontrado</h1>
        <p>No se encontró index.html ni juego.html.</p>
    `);
});

// ===============================
// ESTADO DE LOS JUGADORES
// ===============================

const players = {};

// ===============================
// CONEXIÓN MULTIJUGADOR
// ===============================

io.on("connection", (socket) => {

    console.log("Jugador conectado:", socket.id);

    // Crear jugador
    players[socket.id] = {
        id: socket.id,
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        hp: 10000,
        name: "Jugador"
    };

    // Enviar estado actual al jugador
    socket.emit("currentPlayers", players);

    // Avisar a los demás jugadores
    socket.broadcast.emit("playerJoined", players[socket.id]);

    // ===============================
    // REGISTRAR INFORMACIÓN DEL JUGADOR
    // ===============================

    socket.on("playerInfo", (data) => {

        if (!players[socket.id]) return;

        if (typeof data.name === "string") {
            players[socket.id].name = data.name.substring(0, 30);
        }

        io.emit("playerUpdated", players[socket.id]);
    });

    // ===============================
    // MOVIMIENTO
    // ===============================

    socket.on("playerMovement", (data) => {

        if (!players[socket.id]) return;

        if (typeof data.x === "number") {
            players[socket.id].x = data.x;
        }

        if (typeof data.y === "number") {
            players[socket.id].y = data.y;
        }

        if (typeof data.z === "number") {
            players[socket.id].z = data.z;
        }

        if (typeof data.rotation === "number") {
            players[socket.id].rotation = data.rotation;
        }

        socket.broadcast.emit(
            "playerMoved",
            players[socket.id]
        );
    });

    // ===============================
    // ATAQUE
    // ===============================

    socket.on("playerAttack", (data) => {

        if (!data || !data.targetId) return;

        const target = players[data.targetId];

        if (!target) return;

        let damage = Number(data.damage);

        if (!Number.isFinite(damage)) {
            damage = 0;
        }

        // Evitar valores absurdos
        damage = Math.max(0, Math.min(damage, 5000));

        target.hp -= damage;

        if (target.hp < 0) {
            target.hp = 0;
        }

        io.emit("playerDamaged", {
            attackerId: socket.id,
            targetId: target.id,
            damage: damage,
            hp: target.hp
        });

        // Jugador derrotado
        if (target.hp <= 0) {

            io.emit("playerDefeated", {
                playerId: target.id,
                defeatedBy: socket.id
            });
        }
    });

    // ===============================
    // REINICIAR VIDA
    // ===============================

    socket.on("resetHealth", () => {

        if (!players[socket.id]) return;

        players[socket.id].hp = 10000;

        io.emit("playerHealthReset", {
            playerId: socket.id,
            hp: 10000
        });
    });

    // ===============================
    // DESCONEXIÓN
    // ===============================

    socket.on("disconnect", () => {

        console.log("Jugador desconectado:", socket.id);

        delete players[socket.id];

        io.emit("playerLeft", socket.id);
    });

});

// ===============================
// INICIAR SERVIDOR
// ===============================

server.listen(PORT, "0.0.0.0", () => {

    console.log("--------------------------------");
    console.log("SERVIDOR DEL VIDEOJUEGO INICIADO");
    console.log("--------------------------------");
    console.log("Puerto:", PORT);
    console.log("Servidor listo para conexiones.");
});
