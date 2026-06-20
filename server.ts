import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GameRoom, Player, GameStatus } from "./src/types";

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory games storage
const games = new Map<string, GameRoom>();

// Map of roomId -> Array of SSE client response objects
const SSE_CLIENTS = new Map<string, Array<{ playerId: string; res: express.Response }>>();

// Helper of game cleanup: remove games older than 4 hours
setInterval(() => {
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, game] of games.entries()) {
    if (game.updatedAt < fourHoursAgo) {
      console.log(`Garbage collecting inactive game room: ${id}`);
      games.delete(id);
      SSE_CLIENTS.delete(id);
    }
  }
}, 30 * 60 * 1000); // run every 30 minutes

// Helper to broadcast game state updates to all connected players in a room
function broadcastToRoom(roomId: string, game: GameRoom) {
  const roomClients = SSE_CLIENTS.get(roomId) || [];
  const payload = JSON.stringify({ type: 'sync', game });
  
  roomClients.forEach(client => {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.error(`Error writing SSE data to client in room ${roomId}:`, err);
    }
  });
}

// Generate random uppercase, readable game code
function generateRoomId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // readable chars (removed I, O, 0, 1)
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// API endpoint: Create game
app.post("/api/games", (req, res) => {
  const { size, creatorId, creatorName, creatorColor, customRoomId, maxPlayers } = req.body;
  
  const gridSize = Math.max(2, Math.min(10, size || 4)); // clamp between 2x2 and 10x10 boxes
  const chosenMaxPlayers = Math.max(2, Math.min(6, maxPlayers || 4)); // default to 4, clamp between 2 and 6
  
  let roomId = "";
  if (customRoomId && typeof customRoomId === "string" && customRoomId.trim().length > 0) {
    const cleanId = customRoomId.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cleanId.length < 2 || cleanId.length > 10) {
      res.status(400).json({ error: "Custom Game Code must be between 2 and 10 alphanumeric characters." });
      return;
    }
    if (games.has(cleanId)) {
      res.status(400).json({ error: `Game Room ID '${cleanId}' is already taken.` });
      return;
    }
    roomId = cleanId;
  } else {
    roomId = generateRoomId();
    // Guarantee uniqueness
    while (games.has(roomId)) {
      roomId = generateRoomId();
    }
  }
  
  const initialPlayer: Player = {
    id: creatorId,
    name: creatorName || "Player 1",
    color: creatorColor || "indigo-500",
    score: 0,
    isActive: false, // will become active upon SSE connection
  };
  
  const newGame: GameRoom = {
    id: roomId,
    size: gridSize,
    status: 'lobby',
    players: [initialPlayer],
    maxPlayers: chosenMaxPlayers,
    currentTurnPlayerId: null,
    creatorId: creatorId,
    lines: {
      horizontal: {},
      vertical: {}
    },
    boxes: {},
    logs: [`Game room ${roomId} created by ${initialPlayer.name}.`],
    updatedAt: Date.now()
  };
  
  games.set(roomId, newGame);
  console.log(`Created room ${roomId} of box size ${gridSize}x${gridSize} with limit ${chosenMaxPlayers} players.`);
  res.json({ roomId, game: newGame });
});

// API endpoint: Log room list (Admin/Debug / Join helper)
app.get("/api/games", (req, res) => {
  const activeRooms = Array.from(games.values()).map(g => ({
    id: g.id,
    size: g.size,
    status: g.status,
    playerCount: g.players.length,
    maxPlayers: g.maxPlayers,
  }));
  res.json(activeRooms);
});

// API endpoint: Join or Update Player Profile in Room
app.post("/api/games/:roomId/join", (req, res) => {
  const { roomId } = req.params;
  const { playerId, playerName, playerColor } = req.body;
  
  const game = games.get(roomId);
  if (!game) {
    res.status(404).json({ error: "Game room not found." });
    return;
  }
  
  if (game.status !== 'lobby') {
    // If player is already in the game, allow rejoining
    const existing = game.players.find(p => p.id === playerId);
    if (existing) {
      existing.name = playerName || existing.name;
      existing.color = playerColor || existing.color;
      game.updatedAt = Date.now();
      broadcastToRoom(roomId, game);
      res.json({ game });
      return;
    }
    res.status(400).json({ error: "Cannot join an active or completed game as a new player." });
    return;
  }
  
  // Check if player already registered in lobby
  let player = game.players.find(p => p.id === playerId);
  if (player) {
    player.name = playerName || player.name;
    player.color = playerColor || player.color;
    game.logs.unshift(`${player.name} updated their profile.`);
  } else {
    // Prevent rooms exceeding customized maxPlayers limit
    const limit = game.maxPlayers || 4;
    if (game.players.length >= limit) {
      res.status(400).json({ error: `Game lobby is full (max ${limit} players for this room).` });
      return;
    }
    
    player = {
      id: playerId,
      name: playerName || `Player ${game.players.length + 1}`,
      color: playerColor || "rose-500",
      score: 0,
      isActive: false
    };
    game.players.push(player);
    game.logs.unshift(`${player.name} joined the lobby.`);
  }
  
  game.updatedAt = Date.now();
  broadcastToRoom(roomId, game);
  res.json({ game });
});

// API endpoint: Start the Game
app.post("/api/games/:roomId/start", (req, res) => {
  const { roomId } = req.params;
  const { playerId } = req.body;
  
  const game = games.get(roomId);
  if (!game) {
    res.status(404).json({ error: "Game room not found." });
    return;
  }
  
  if (game.creatorId !== playerId) {
    res.status(403).json({ error: "Only the room creator can start the game." });
    return;
  }
  
  if (game.players.length < 2) {
    res.status(400).json({ error: "At least 2 players are required to start the game." });
    return;
  }
  
  game.status = 'playing';
  game.currentTurnPlayerId = game.players[0].id; // First player starts
  game.logs.unshift("The game has started! Take your turns.");
  game.updatedAt = Date.now();
  
  broadcastToRoom(roomId, game);
  res.json({ game });
});

// API endpoint: Reset/Restart Game
app.post("/api/games/:roomId/restart", (req, res) => {
  const { roomId } = req.params;
  const { playerId } = req.body;
  
  const game = games.get(roomId);
  if (!game) {
    res.status(404).json({ error: "Game room not found." });
    return;
  }
  
  // Reset scores, lines, boxes
  game.players.forEach(p => {
    p.score = 0;
  });
  game.lines = {
    horizontal: {},
    vertical: {}
  };
  game.boxes = {};
  game.status = 'playing';
  game.currentTurnPlayerId = game.players[0].id;
  game.logs.unshift("Game restarted! Play again!");
  game.updatedAt = Date.now();
  
  broadcastToRoom(roomId, game);
  res.json({ game });
});

// API endpoint: Send Message/Chat Log
app.post("/api/games/:roomId/chat", (req, res) => {
  const { roomId } = req.params;
  const { playerId, text } = req.body;
  
  const game = games.get(roomId);
  if (!game) {
    res.status(404).json({ error: "Game room not found." });
    return;
  }
  
  const player = game.players.find(p => p.id === playerId);
  if (!player) {
    res.status(403).json({ error: "You are not a player in this room." });
    return;
  }
  
  const message = `${player.name}: ${text.substring(0, 100)}`;
  game.logs.unshift(message);
  game.updatedAt = Date.now();
  
  broadcastToRoom(roomId, game);
  res.json({ status: "ok" });
});

// API endpoint: Make move
app.post("/api/games/:roomId/move", (req, res) => {
  const { roomId } = req.params;
  const { playerId, type, r, c } = req.body;
  
  const game = games.get(roomId);
  if (!game) {
    res.status(404).json({ error: "Game not found." });
    return;
  }
  
  if (game.status !== 'playing') {
    res.status(400).json({ error: "Game is not in in-progress playing state." });
    return;
  }
  
  if (game.currentTurnPlayerId !== playerId) {
    res.status(403).json({ error: "It is not your turn." });
    return;
  }
  
  const size = game.size;
  const player = game.players.find(p => p.id === playerId);
  if (!player) {
    res.status(403).json({ error: "Player not registered in this game." });
    return;
  }
  
  const key = `${r},${c}`;
  
  // Validate coordinates
  if (type === 'horizontal') {
    if (r < 0 || r > size || c < 0 || c >= size) {
      res.status(400).json({ error: "Invalid horizontal line coordinates." });
      return;
    }
    if (game.lines.horizontal[key]) {
      res.status(400).json({ error: "Horizontal line already claimed." });
      return;
    }
    game.lines.horizontal[key] = playerId;
  } else if (type === 'vertical') {
    if (r < 0 || r >= size || c < 0 || c > size) {
      res.status(400).json({ error: "Invalid vertical line coordinates." });
      return;
    }
    if (game.lines.vertical[key]) {
      res.status(400).json({ error: "Vertical line already claimed." });
      return;
    }
    game.lines.vertical[key] = playerId;
  } else {
    res.status(400).json({ error: "Invalid line type. Must be horizontal or vertical." });
    return;
  }
  
  // Sub-fn to verify if box is completed
  const isBoxCompleted = (boxR: number, boxC: number): boolean => {
    const topKey = `${boxR},${boxC}`;
    const bottomKey = `${boxR+1},${boxC}`;
    const leftKey = `${boxR},${boxC}`;
    const rightKey = `${boxR},${boxC+1}`;
    
    return !!(
      game.lines.horizontal[topKey] &&
      game.lines.horizontal[bottomKey] &&
      game.lines.vertical[leftKey] &&
      game.lines.vertical[rightKey]
    );
  };
  
  // Check which boxes get completed by this move!
  let boxesCompletedThisTurn = 0;
  const potentialBoxes: Array<{ r: number; c: number }> = [];
  
  if (type === 'horizontal') {
    // horizontal line at (r, c) forms top of box (r, c) and bottom of box (r-1, c)
    if (r > 0) potentialBoxes.push({ r: r - 1, c }); // box above
    if (r < size) potentialBoxes.push({ r, c });      // box below
  } else {
    // vertical line at (r, c) forms left of box (r, c) and right of box (r, c-1)
    if (c > 0) potentialBoxes.push({ r, c: c - 1 }); // box left
    if (c < size) potentialBoxes.push({ r, c });      // box right
  }
  
  potentialBoxes.forEach(box => {
    const boxKey = `${box.r},${box.c}`;
    // If this box isn't claimed yet, and it is fully surrounded now
    if (!game.boxes[boxKey] && isBoxCompleted(box.r, box.c)) {
      game.boxes[boxKey] = playerId;
      boxesCompletedThisTurn++;
      player.score += 1;
    }
  });
  
  const lineDesc = type === 'horizontal' 
    ? `horizontal line between (${r},${c}) and (${r},${c+1})`
    : `vertical line between (${r},${c}) and (${r+1},${c})`;
    
  if (boxesCompletedThisTurn > 0) {
    game.logs.unshift(`${player.name} completed ${boxesCompletedThisTurn} box(es) and gets another turn!`);
  } else {
    // Rotate to next turn
    const activePlayers = game.players.filter(p => p.isActive);
    const targetSearchList = activePlayers.length > 0 ? activePlayers : game.players;
    
    const currentIndex = targetSearchList.findIndex(p => p.id === playerId);
    const nextIndex = (currentIndex + 1) % targetSearchList.length;
    game.currentTurnPlayerId = targetSearchList[nextIndex].id;
    game.logs.unshift(`${player.name} connected a lines.`);
  }
  
  // Check if game complete (size * size total boxes)
  const totalBoxes = size * size;
  const claimedBoxes = Object.keys(game.boxes).length;
  
  if (claimedBoxes >= totalBoxes) {
    game.status = 'completed';
    game.currentTurnPlayerId = null;
    
    // Sort players to find maximum score
    const highestScore = Math.max(...game.players.map(p => p.score));
    const winners = game.players.filter(p => p.score === highestScore);
    
    if (winners.length === 1) {
      game.logs.unshift(`🎉 Game Completed! ${winners[0].name} wins with a score of ${highestScore}!`);
    } else {
      game.logs.unshift(`🤝 Game Completed! It's a tie between ${winners.map(w => w.name).join(", ")} with score of ${highestScore}!`);
    }
  }
  
  game.updatedAt = Date.now();
  broadcastToRoom(roomId, game);
  res.json({ game });
});

// SSE stream: Get real-time game updates
app.get("/api/games/:roomId/stream", (req, res) => {
  const { roomId } = req.params;
  const { playerId, name, color } = req.query as { playerId: string; name?: string; color?: string };
  
  if (!roomId || !playerId) {
    res.status(400).send("roomId and playerId are required parameters.");
    return;
  }
  
  const game = games.get(roomId);
  if (!game) {
    res.status(404).send("Game not found.");
    return;
  }
  
  // Set headers for Server-Sent Events (SSE)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Establish the connection immediately
  
  // Track that player is active/online
  const player = game.players.find(p => p.id === playerId);
  if (player) {
    player.isActive = true;
    if (name) player.name = name;
    if (color) player.color = color;
  }
  
  // Register client for broadcasts
  let roomClients = SSE_CLIENTS.get(roomId);
  if (!roomClients) {
    roomClients = [];
    SSE_CLIENTS.set(roomId, roomClients);
  }
  
  // Clean up any old duplicate connection for that player ID
  const freshClients = roomClients.filter(c => c.playerId !== playerId);
  freshClients.push({ playerId, res });
  SSE_CLIENTS.set(roomId, freshClients);
  
  game.logs.unshift(`🟢 ${player?.name || "A player"} connected to the room.`);
  game.updatedAt = Date.now();
  
  // Send initial full sync
  res.write(`data: ${JSON.stringify({ type: 'sync', game })}\n\n`);
  
  // Broadcast to other players in the room that this member is active
  broadcastToRoom(roomId, game);
  
  // Keep-alive heartbeat to prevent timeouts
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);
  
  // Clean up on connection close
  req.on('close', () => {
    clearInterval(heartbeat);
    
    // Remote client from room registration
    const curClients = SSE_CLIENTS.get(roomId) || [];
    const updatedClients = curClients.filter(c => c.res !== res);
    SSE_CLIENTS.set(roomId, updatedClients);
    
    // Check if player has other tabs or is completely disconnected
    const isStillConnected = updatedClients.some(c => c.playerId === playerId);
    if (!isStillConnected) {
      // Fetch latest game and set offline
      const latestGame = games.get(roomId);
      if (latestGame) {
        const leavePlayer = latestGame.players.find(p => p.id === playerId);
        if (leavePlayer) {
          leavePlayer.isActive = false;
          latestGame.logs.unshift(`🔴 ${leavePlayer.name} disconnected.`);
          latestGame.updatedAt = Date.now();
          broadcastToRoom(roomId, latestGame);
        }
      }
    }
  });
});

// Boot app and Vite middleware
async function startServer() {
  // Vite dev server configurations
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production serving
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Dots and Boxes Backend Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer();
