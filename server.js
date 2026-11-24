const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function makeDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"];
  const deck = [];

  suits.forEach(suit => {
    ranks.forEach(rank => deck.push(rank + suit));
  });

  return deck.sort(() => Math.random() - 0.5);
}

io.on("connection", socket => {

  socket.on("createRoom", data => {
    const code = makeCode();

    rooms[code] = {
      host: socket.id,
      players: [{
        id: socket.id,
        name: String(data.name || "Người chơi").slice(0, 16)
      }],
      started: false
    };

    socket.join(code);
    socket.emit("roomCreated", { code });
    updateRoom(code);
  });

  socket.on("joinRoom", data => {
    const code = String(data.code || "").toUpperCase();
    const room = rooms[code];

    if (!room) {
      socket.emit("errorMessage", "Không tìm thấy phòng!");
      return;
    }

    if (room.started || room.players.length >= 4) {
      socket.emit("errorMessage", "Phòng đã đầy hoặc đã bắt đầu!");
      return;
    }

    room.players.push({
      id: socket.id,
      name: String(data.name || "Người chơi").slice(0, 16)
    });

    socket.join(code);
    socket.emit("joinedRoom", { code });
    updateRoom(code);
  });

  socket.on("startGame", data => {
    const room = rooms[data.code];

    if (!room || room.host !== socket.id) return;
    if (room.players.length < 2) return;

    room.started = true;
    const deck = makeDeck();

    room.players.forEach(player => {
      const hand = deck.splice(0, 13);
      io.to(player.id).emit("gameStarted", { hand });
    });
  });

  socket.on("playCards", data => {
    const room = rooms[data.code];
    if (!room || !room.started) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const cards = Array.isArray(data.cards) ? data.cards : [];

    io.to(data.code).emit("cardsPlayed", {
      message: player.name + " đã đánh " + cards.join(" ")
    });
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.players.length === 0) {
        delete rooms[code];
      } else {
        if (room.host === socket.id) {
          room.host = room.players[0].id;
        }
        updateRoom(code);
      }
    }
  });

});

function updateRoom(code) {
  const room = rooms[code];
  if (!room) return;

  io.to(code).emit("roomUpdate", {
    players: room.players.map(p => ({ name: p.name })),
    isHost: false
  });

  io.to(room.host).emit("roomUpdate", {
    players: room.players.map(p => ({ name: p.name })),
    isHost: true
  });
}

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Tien Len server is running");
});
