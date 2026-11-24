
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

  values.forEach(v => {
    counts[v] = (counts[v] || 0) + 1;
  });

  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const highest = Math.max(...values);

  const combo = {
    size: cards.length,
    power: highest,
    suitPower: Math.max(
      ...cards.filter(c => rank(c) === highest).map(suitValue)
    )
  };

  if (cards.length === 1) return { ...combo, type: "single" };

  if (cards.length === 2 && unique.length === 1)
    return { ...combo, type: "pair" };

  if (cards.length === 3 && unique.length === 1)
    return { ...combo, type: "triple" };

  if (cards.length === 4 && unique.length === 1)
    return { ...combo, type: "four" };

  if (
    cards.length >= 3 &&
    unique.length === cards.length &&
    highest < 15 &&
    unique.every((v, i) => i === 0 || v === unique[i - 1] + 1)
  ) {
    return { ...combo, type: "straight" };
  }

  if (
    cards.length === 6 &&
    unique.length === 3 &&
    unique.every(v => counts[v] === 2) &&
    unique.every((v, i) => i === 0 || v === unique[i - 1] + 1)
  ) {
    return { ...combo, type: "threePairs" };
  }

  if (
    cards.length === 8 &&
    unique.length === 4 &&
    unique.every(v => counts[v] === 2) &&
    unique.every((v, i) => i === 0 || v === unique[i - 1] + 1)
  ) {
    return { ...combo, type: "fourPairs" };
  }

  return null;
}

function beats(next, previous) {
  if (!previous) return true;

  const singleTwo =
    previous.type === "single" && previous.power === 15;

  const pairTwo =
    previous.type === "pair" && previous.power === 15;

  // Bốn đôi thông chặt heo, đôi heo, 3 đôi thông và tứ quý.
  if (
    next.type === "fourPairs" &&
    ["single", "pair", "threePairs", "four"].includes(previous.type)
  ) {
    if (singleTwo || pairTwo ||
        previous.type === "threePairs" ||
        previous.type === "four") {
      return true;
    }
  }

  // Tứ quý chặt heo, đôi heo và 3 đôi thông.
  if (
    next.type === "four" &&
    (singleTwo || pairTwo || previous.type === "threePairs")
  ) {
    return true;
  }

  // 3 đôi thông chặt một con heo.
  if (next.type === "threePairs" && singleTwo) {
    return true;
  }

  // Hàng cùng loại phải mạnh hơn hàng trước.
  if (
    next.type !== previous.type ||
    next.size !== previous.size
  ) {
    return false;
  }

  if (next.power !== previous.power) {
    return next.power > previous.power;
  }

  return next.suitPower > previous.suitPower;
}

function activePlayers(room) {
  return room.players.filter(p => p.hand.length > 0);
}

function playerSignature(room) {
  return room.players.map(p => p.id).sort().join("|");
}

function findWhiteWin(player, firstRound) {
  const cards = player.hand;
  const counts = {};

  cards.forEach(card => {
    const value = rank(card);
    counts[value] = (counts[value] || 0) + 1;
  });

  const values = Object.keys(counts).map(Number).sort((a, b) => a - b);

  // Bốn con heo.
  if (counts[15] === 4) return "Tứ quý 2";

  // Sáu đôi bất kỳ, không cần liên tiếp.
  if (values.filter(v => counts[v] >= 2).length >= 6)
    return "6 đôi thông thường";

  // Sảnh đủ 12 lá từ 3 đến A.
  const straight12 = RANKS.slice(0, 12).every(value =>
    cards.some(card => card.startsWith(value))
  );

  if (straight12) return "Sảnh 3 đến A";

  // Ván đầu: tứ quý 3.
  if (firstRound && counts[3] === 4)
    return "Tứ quý 3 ván đầu";

  return null;
}

function resultRows(room) {
  const total = room.roundPlayerIds.length;

  const labels = total === 2
    ? ["Thắng", "Thua"]
    : ["Nhất", "Nhì", "Ba", "Tư"];

  return room.rankings.map((id, index) => {
    const player = room.players.find(p => p.id === id);

    return {
      rank: labels[index] || "Hạng " + (index + 1),
      name: player ? player.name : "Người chơi đã rời phòng"
    };
  });
}

function finishRound(room) {
  const remaining = activePlayers(room);

  if (remaining.length === 1) {
    room.rankings.push(remaining[0].id);
  }

  if (remaining.length > 1) return false;

  room.winnerId = room.rankings[0] || null;
  room.results = resultRows(room);

  room.winner = room.results
    .map(item => item.rank + ": " + item.name)
    .join(" | ");

  room.message = "🏆 Ván đấu đã kết thúc!";

  return true;
}

function finishWhiteWin(room, player, reason) {
  room.rankings = [player.id];
  room.winnerId = player.id;
  room.results = [{
    rank: "TỚI TRẮNG",
    name: player.name
  }];

  room.winner = "TỚI TRẮNG: " + player.name;
  room.started = true;
  room.currentPlayerId = null;
  room.lastCards = [];
  room.lastPlay = null;
  room.message = "🏆 " + player.name + " TỚI TRẮNG! (" + reason + ")";
}

function sendState(room) {
  io.to(room.code).emit("roomState", {
    code: room.code,
    started: room.started,
    hostId: room.host,
    currentPlayerId: room.currentPlayerId,
    lastPlayerId: room.lastPlayerId,
    lastCards: room.lastCards || [],
    lastPlayerName: room.lastPlayerName || "",
    message: room.message,
    winner: room.winner,
    winnerId: room.winnerId,
    results: room.results || [],
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      count: p.hand.length
    }))
  });

  room.players.forEach(player => {
    io.to(player.id).emit("myHand", player.hand);
  });
}

function nextTurn(room, playerId) {
  const active = activePlayers(room);

  if (!active.length) return;

  const index = active.findIndex(p => p.id === playerId);

  room.currentPlayerId =
    active[(index + 1 + active.length) % active.length].id;
}

function leadAfter(room, playerId) {
  const active = activePlayers(room);

  if (!active.length) return;

  const oldIndex = room.players.findIndex(p => p.id === playerId);

  for (let step = 1; step <= room.players.length; step++) {
    const candidate = room.players[
      (oldIndex + step + room.players.length) % room.players.length
    ];

    if (candidate && candidate.hand.length > 0) {
      room.currentPlayerId = candidate.id;
      return;
    }
  }

  room.currentPlayerId = active[0].id;
}

function makeRoomCode() {
  let code;

  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[code]);

  return code;
}

function dealRound(room, preferredPlayerId) {
  const deck = makeDeck();

  room.players.forEach(player => {
    player.hand = sortCards(deck.splice(0, 13));
  });

  room.roundNumber++;
  room.rankings = [];
  room.results = [];
  room.winner = null;
  room.winnerId = null;
  room.lastPlayerId = null;
  room.lastPlayerName = "";
  room.lastCards = [];
  room.lastPlay = null;
  room.passes = 0;
  room.roundPlayerIds = room.players.map(p => p.id);
  room.roundSignature = playerSignature(room);

  // Tới trắng được kiểm tra ngay sau khi chia bài.
  for (const player of room.players) {
    const reason = findWhiteWin(player, room.roundNumber === 1);

    if (reason) {
      finishWhiteWin(room, player, reason);
      sendState(room);
      return;
    }
  }

  let firstPlayer = preferredPlayerId
    ? room.players.find(p => p.id === preferredPlayerId)
    : null;

  if (!firstPlayer) {
    firstPlayer = room.players.find(p => p.hand.includes("3♠"));
  }

  room.started = true;
  room.currentPlayerId = firstPlayer.id;
  room.mustPlayThree = !preferredPlayerId;

  room.message = preferredPlayerId
    ? "Ván mới! Người thắng ván trước được đi trước."
    : "Ván mới! Người có 3♠ được đi trước.";

  sendState(room);
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
      winner: null,
      winnerId: null,
      rankings: [],
      results: [],
      roundNumber: 0,
      roundPlayerIds: [],
      roundSignature: ""
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

    if ((room.started && !room.winner) || room.players.length >= 4) {
      socket.emit("errorMessage", "Phòng đang chơi hoặc đã đủ 4 người!");
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

    dealRound(room, null);
  });

  socket.on("nextRound", data => {
    const room = rooms[data && data.code];

    if (!room || room.host !== socket.id) return;
    if (!room.winner || room.players.length < 2) return;

    const samePlayers =
      room.roundSignature === playerSignature(room);

    dealRound(room, samePlayers ? room.winnerId : null);
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

    if (!Array.isArray(cards) || !cards.length || cards.length > 13) {
      socket.emit("errorMessage", "Hãy chọn bài hợp lệ!");
      return;
    }

    if (new Set(cards).size !== cards.length ||
        !cards.every(card => player.hand.includes(card))) {
      socket.emit("errorMessage", "Lá bài được chọn không hợp lệ!");
      return;
    }

    const combo = getCombo(cards);

    if (!combo) {
      socket.emit("errorMessage", "Bộ bài không hợp lệ!");
      return;
    }

    if (room.mustPlayThree && !cards.includes("3♠")) {
      socket.emit("errorMessage", "Lượt đầu tiên phải có lá 3♠!");
      return;
    }

    if (!beats(combo, room.lastPlay)) {
      socket.emit("errorMessage", "Bài của bạn không chặn được bài trước!");
      return;
    }

    player.hand = sortCards(
      player.hand.filter(card => !cards.includes(card))
    );

    room.lastPlay = combo;
    room.lastCards = cards;
    room.lastPlayerId = socket.id;
    room.lastPlayerName = player.name;
    room.passes = 0;
    room.mustPlayThree = false;

    room.message = player.name + " đã đánh " + cards.join(" ");

    if (player.hand.length === 0) {
      room.rankings.push(player.id);

      if (activePlayers(room).length <= 1) {
        finishRound(room);
      } else {
        nextTurn(room, socket.id);
      }
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
      socket.emit("errorMessage", "Bạn không thể bỏ lượt khi mở vòng!");
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    room.passes++;
    room.message = player.name + " đã bỏ lượt.";

    const active = activePlayers(room);
    const lastPlayerStillActive =
      active.some(p => p.id === room.lastPlayerId);

    const neededPasses = active.length -
      (lastPlayerStillActive ? 1 : 0);

    if (room.passes >= neededPasses) {
      const oldLastPlayer = room.lastPlayerId;

      room.lastPlay = null;
      room.lastCards = [];
      room.passes = 0;

      if (lastPlayerStillActive) {
        room.currentPlayerId = oldLastPlayer;
      } else {
        leadAfter(room, oldLastPlayer);
      }

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

      if (!room.players.length) {
        delete rooms[code];
        continue;
      }

      if (room.host === socket.id) {
        room.host = room.players[0].id;
      }

      if (room.started && !room.winner) {
        if (room.players.length < 2) {
          room.started = false;
          room.currentPlayerId = null;
          room.message = "Không đủ người chơi. Hãy bắt đầu ván mới.";
        } else if (wasCurrent) {
          nextTurn(room, socket.id);
          room.message = "Một người chơi đã rời phòng. Đã chuyển lượt.";
        }
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
