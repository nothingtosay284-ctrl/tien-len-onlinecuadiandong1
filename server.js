
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};
const SUITS = ["♠", "♣", "♦", "♥"];
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];

function rank(card) {
  return RANKS.indexOf(card.slice(0, -1)) + 3;
}

function suitValue(card) {
  return SUITS.indexOf(card.slice(-1));
}

function sortCards(cards) {
  return cards.sort((a, b) =>
    rank(a) - rank(b) || suitValue(a) - suitValue(b)
  );
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of RANKS) deck.push(value + suit);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function getCombo(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;

  const values = cards.map(rank).sort((a, b) => a - b);
  const counts = {};
  values.forEach(v => counts[v] = (counts[v] || 0) + 1);

  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const highest = Math.max(...values);

  if (cards.length === 1) {
    return { type: "single", size: 1, power: highest };
  }

  if (cards.length === 2 && unique.length === 1) {
    return { type: "pair", size: 2, power: highest };
  }

  if (cards.length === 3 && unique.length === 1) {
    return { type: "triple", size: 3, power: highest };
  }

  if (cards.length === 4 && unique.length === 1) {
    return { type: "four", size: 4, power: highest };
  }

  if (
    cards.length >= 3 &&
    unique.length === cards.length &&
    highest < 15 &&
    unique.every((v, i) => i === 0 || v === unique[i - 1] + 1)
  ) {
    return { type: "straight", size: cards.length, power: highest };
  }

  return null;
}

function beats(next, previous) {
  if (!previous) return true;

  if (
    next.type === "four" &&
    previous.type === "single" &&
    previous.power === 15
  ) return true;

  if (
    next.type !== previous.type ||
    next.size !== previous.size
  ) return false;

  if (next.power !== previous.power) {
    return next.power > previous.power;
  }

  return next.suitPower > previous.suitPower;
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
    lastCards: room.lastCards || [],
    lastPlayerName: room.lastPlayerName || "",
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

  room.players.forEach(player => {
    io.to(player.id).emit("myHand", player.hand);
  });
}

function nextTurn(room, playerId) {
  const active = activePlayers(room);
  if (!active.length) return;

  const index = active.findIndex(p => p.id === playerId);
  room.currentPlayerId = active[(index + 1 + active.length) % active.length].id;
}

function makeRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[code]);
  return code;
}

io.on("connection", socket => {

  socket.on("createRoom", data => {
    data = data || {};
    const code = makeRoomCode();

    rooms[code] = {
      code,
      host: socket.id,
      players: [{
        id: socket.id,
        name: String(data.name || "Người chơi").trim().slice(0, 16),
        hand: []
      }],
      started: false,
      currentPlayerId: null,
      lastPlayerId: null,
      lastPlayerName: "",
      lastCards: [],
      lastPlay: null,
      passes: 0,
      mustPlayThree: false,
      message: "Đang chờ người chơi tham gia...",
      winner: null
    };

    socket.join(code);
    socket.emit("roomCreated", { code });
    sendState(rooms[code]);
  });

  socket.on("joinRoom", data => {
    data = data || {};
    const code = String(data.code || "").trim().toUpperCase();
    const room = rooms[code];

    if (!room) {
      socket.emit("errorMessage", "Không tìm thấy phòng!");
      return;
    }

    if (room.started || room.players.length >= 4) {
      socket.emit("errorMessage", "Phòng đã đầy hoặc trận đã bắt đầu!");
      return;
    }

    room.players.push({
      id: socket.id,
      name: String(data.name || "Người chơi").trim().slice(0, 16),
      hand: []
    });

    socket.join(code);
    socket.emit("joinedRoom", { code });
    room.message = "Có người chơi mới tham gia!";
    sendState(room);
  });

  socket.on("startGame", data => {
    const room = rooms[data && data.code];

    if (!room || room.host !== socket.id) return;
    if (room.started || room.players.length < 2) return;

    const deck = makeDeck();

    room.players.forEach(player => {
      player.hand = sortCards(deck.splice(0, 13));
    });

    const firstPlayer = room.players.find(p => p.hand.includes("3♠"));

    room.started = true;
    room.currentPlayerId = firstPlayer.id;
    room.lastPlayerId = null;
    room.lastPlayerName = "";
    room.lastCards = [];
    room.lastPlay = null;
    room.passes = 0;
    room.mustPlayThree = true;
    room.winner = null;
    room.message = "Trận đấu bắt đầu! Người có 3♠ đánh trước.";

    sendState(room);
  });

  socket.on("playCards", data => {
    const room = rooms[data && data.code];

    if (!room || !room.started || room.winner) return;

    if (room.currentPlayerId !== socket.id) {
      socket.emit("errorMessage", "Chưa đến lượt bạn!");
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const cards = data.cards;

    if (!Array.isArray(cards) || cards.length === 0 || cards.length > 13) {
      socket.emit("errorMessage", "Bạn hãy chọn bài hợp lệ!");
      return;
    }

    if (new Set(cards).size !== cards.length) {
      socket.emit("errorMessage", "Bạn đã chọn bài trùng!");
      return;
    }

    if (!cards.every(card => player.hand.includes(card))) {
      socket.emit("errorMessage", "Bạn không có lá bài đó!");
      return;
    }

    const combo = getCombo(cards);

    if (!combo) {
      socket.emit("errorMessage", "Bộ bài không hợp lệ!");
      return;
    }

    combo.suitPower = Math.max(...cards.map(suitValue));

    if (room.mustPlayThree && !cards.includes("3♠")) {
      socket.emit("errorMessage", "Lượt đầu tiên phải có lá 3♠!");
      return;
    }

    if (!beats(combo, room.lastPlay)) {
      socket.emit("errorMessage", "Bài của bạn không chặn được bài trước!");
      return;
    }

    player.hand = sortCards(player.hand.filter(card => !cards.includes(card)));

    room.lastPlay = combo;
    room.lastCards = cards;
    room.lastPlayerId = socket.id;
    room.lastPlayerName = player.name;
    room.passes = 0;
    room.mustPlayThree = false;
    room.message = player.name + " đã đánh " + cards.join(" ");

    if (player.hand.length === 0) {
      room.winner = player.name;
      room.message = "🏆 " + player.name + " đã chiến thắng!";
    } else {
      nextTurn(room, socket.id);
    }

    sendState(room);
  });

  socket.on("passTurn", data => {
    const room = rooms[data && data.code];

    if (!room || !room.started || room.winner) return;

    if (room.currentPlayerId !== socket.id) {
      socket.emit("errorMessage", "Chưa đến lượt bạn!");
      return;
    }

    if (!room.lastPlay || !room.lastPlayerId) {
      socket.emit("errorMessage", "Bạn đang có quyền đánh mở vòng, không thể bỏ lượt!");
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    room.passes++;
    room.message = player.name + " đã bỏ lượt.";

    const active = activePlayers(room);

    if (room.passes >= active.length - 1) {
      room.currentPlayerId = room.lastPlayerId;
      room.lastPlay = null;
      room.lastCards = [];
      room.passes = 0;
      room.message = room.lastPlayerName + " được đánh vòng mới.";
    } else {
      nextTurn(room, socket.id);
    }

    sendState(room);
  });

  socket.on("disconnect", () => {
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      const wasCurrent = room.currentPlayerId === socket.id;

      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.players.length === 0) {
        delete rooms[code];
        continue;
      }

      if (room.host === socket.id) {
        room.host = room.players[0].id;
      }

      if (room.started && wasCurrent) {
        nextTurn(room, socket.id);
        room.message = "Một người chơi đã rời phòng. Đã chuyển lượt.";
      }

      if (room.started && room.players.length < 2) {
        room.started = false;
        room.currentPlayerId = null;
        room.message = "Không đủ người chơi để tiếp tục. Hãy bắt đầu ván mới.";
      }

      sendState(room);
    }
  });
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Royal Tien Len server is running");
});
