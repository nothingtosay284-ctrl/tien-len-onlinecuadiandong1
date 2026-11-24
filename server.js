
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};
const suits = ["♠", "♥", "♦", "♣"];
const ranks = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"];

function rank(card) {
  return ranks.indexOf(card.slice(0, -1)) + 3;
}

function sortCards(cards) {
  return cards.sort((a, b) =>
    rank(a) - rank(b) ||
    suits.indexOf(a.slice(-1)) - suits.indexOf(b.slice(-1))
  );
}

function makeDeck() {
  const deck = [];
  suits.forEach(s => ranks.forEach(r => deck.push(r + s)));

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getCombo(cards) {
  if (!cards || cards.length === 0) return null;

  const values = cards.map(rank).sort((a, b) => a - b);
  const counts = {};
  values.forEach(v => counts[v] = (counts[v] || 0) + 1);

  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const max = values[values.length - 1];

  if (cards.length === 1) return { type: "single", size: 1, power: max };
  if (cards.length === 2 && unique.length === 1)
    return { type: "pair", size: 2, power: max };
  if (cards.length === 3 && unique.length === 1)
    return { type: "triple", size: 3, power: max };
  if (cards.length === 4 && unique.length === 1)
    return { type: "four", size: 4, power: max };

  if (cards.length >= 3 &&
      unique.length === cards.length &&
      max < 15 &&
      unique.every((v, i) => i === 0 || v === unique[i - 1] + 1)) {
    return { type: "straight", size: cards.length, power: max };
  }

  return null;
}

function beats(next, previous) {
  if (!previous) return true;

  if (next.type === "four" && previous.type === "single" && previous.power === 15)
    return true;

  if (next.type !== previous.type || next.size !== previous.size)
    return false;

  return next.power > previous.power;
}

function activePlayers(room) {
  return room.players.filter(p => p.hand.length > 0);
}

function publicState(room) {
  return {
    code: room.code,
    started: room.started,
    hostId: room.host,
    currentPlayerId: room.currentPlayerId,
    lastPlayerId: room.lastPlayerId,
    lastPlay: room.lastPlay,
    message: room.message,
    winner: room.winner,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      count: p.hand.length
    }))
  };
}

function sendState(room) {
  io.to(room.code).emit("roomState", publicState(room));
  room.players.forEach(p => {
    io.to(p.id).emit("myHand", p.hand);
  });
}

function nextTurn(room, fromId) {
  const active = activePlayers(room);
  if (!active.length) return;

  let index = active.findIndex(p => p.id === fromId);
  room.currentPlayerId = active[(index + 1 + active.length) % active.length].id;
}

function createRoom(socket, data) {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();

  rooms[code] = {
    code,
    host: socket.id,
    players: [{
      id: socket.id,
      name: String(data.name || "Người chơi").slice(0, 16),
      hand: []
    }],
    started: false,
    currentPlayerId: null,
    lastPlayerId: null,
    lastPlay: null,
    passes: 0,
    message: "Đang chờ người chơi...",
    winner: null
  };

  socket.join(code);
  socket.emit("roomCreated", { code });
  sendState(rooms[code]);
}

io.on("connection", socket => {
  socket.on("createRoom", data => createRoom(socket, data || {}));

  socket.on("joinRoom", data => {
    const code = String(data.code || "").toUpperCase();
    const room = rooms[code];

    if (!room) return socket.emit("errorMessage", "Không tìm thấy phòng!");
    if (room.started || room.players.length >= 4)
      return socket.emit("errorMessage", "Phòng đã đầy hoặc đã bắt đầu!");

    room.players.push({
      id: socket.id,
      name: String(data.name || "Người chơi").slice(0, 16),
      hand: []
    });

    socket.join(code);
    socket.emit("joinedRoom", { code });
    room.message = "Có người chơi mới tham gia!";
    sendState(room);
  });

  socket.on("startGame", data => {
    const room = rooms[data.code];
    if (!room || room.host !== socket.id || room.players.length < 2) return;

    const deck = makeDeck();
    room.players.forEach(p => p.hand = sortCards(deck.splice(0, 13)));

    const first = room.players.find(p => p.hand.includes("3♠"));
    room.started = true;
    room.currentPlayerId = first.id;
    room.lastPlayerId = null;
    room.lastPlay = null;
    room.passes = 0;
    room.winner = null;
    room.message = "Trận đấu bắt đầu! Người có 3♠ đi trước.";
    sendState(room);
  });

  socket.on("playCards", data => {
    const room = rooms[data.code];
    if (!room || !room.started || room.winner) return;
    if (room.currentPlayerId !== socket.id) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const cards = Array.isArray(data.cards) ? data.cards : [];
    if (!cards.length || new Set(cards).size !== cards.length) return;

    if (!cards.every(c => player.hand.includes(c))) {
      socket.emit("errorMessage", "Bạn không có những lá bài này!");
      return;
    }

    const combo = getCombo(cards);
    if (!combo) {
      socket.emit("errorMessage", "Bộ bài không hợp lệ!");
      return;
    }

    if (!beats(combo, room.lastPlay)) {
      socket.emit("errorMessage", "Bài của bạn chưa chặn được!");
      return;
    }

    if (!room.lastPlay && !cards.includes("3♠") &&
        room.players.every(p => p.hand.includes("3♠"))) {
      socket.emit("errorMessage", "Lượt đầu tiên phải có lá 3♠!");
      return;
    }

    player.hand = sortCards(player.hand.filter(c => !cards.includes(c)));
    room.lastPlay = combo;
    room.lastPlayerId = socket.id;
    room.passes = 0;
    room.message = player.name + " đã đánh " + cards.join(" ");
    room.lastCards = cards;

    if (player.hand.length === 0) {
      room.winner = player.name;
      room.message = "🏆 " + player.name + " đã chiến thắng!";
    } else {
      nextTurn(room, socket.id);
    }

    sendState(room);
  });

  socket.on("passTurn", data => {
    const room = rooms[data.code];
    if (!room || !room.started || room.winner) return;
    if (room.currentPlayerId !== socket.id || !room.lastPlay) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    room.passes++;
    room.message = player.name + " đã bỏ lượt.";

    const active = activePlayers(room);

    if (room.passes >= active.length - 1) {
      room.lastPlay = null;
      room.lastCards = [];
      room.passes = 0;
      room.currentPlayerId = room.lastPlayerId;
      room.message = "Vòng mới! Người đánh cuối được đi tiếp.";
    } else {
      nextTurn(room, socket.id);
    }

    sendState(room);
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      const wasCurrent = room.currentPlayerId === socket.id;

      room.players = room.players.filter(p => p.id !== socket.id);

      if (!room.players.length) {
        delete rooms[code];
        continue;
      }

      if (room.host === socket.id) room.host = room.players[0].id;

      if (room.started && wasCurrent) {
        nextTurn(room, socket.id);
        room.message = "Một người chơi đã thoát.";
      }

      if (room.players.length < 2 && room.started) {
        room.started = false;
        room.message = "Không đủ người chơi. Hãy tạo ván mới.";
      }

      sendState(room);
    }
  });
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Tien Len server is running");
});
