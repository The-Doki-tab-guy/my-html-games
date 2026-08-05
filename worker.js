// ============================================================
//  SYNTH PURGE - Full Worker (HTML + WebSocket Server)
//  Deploy this to Cloudflare Workers
// ============================================================

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // --- WebSocket upgrade ---
    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected websocket', { status: 400 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // --- Serve the HTML page ---
    // Return the full HTML from the previous response (the game)
    return new Response(HTML_CONTENT, {
      headers: { 'Content-Type': 'text/html' },
    });
  }
};

// ============================================================
//  WebSocket Logic (copied from earlier server.js)
// ============================================================
const rooms = new Map();
const players = new Map();

class Room {
  constructor(roomCode, hostId, hostName) {
    this.code = roomCode;
    this.hostId = hostId;
    this.hostName = hostName;
    this.players = new Map();
    this.started = false;
    this.gameState = null;
    this.createdAt = Date.now();
    this.maxPlayers = 8;
    this.players.set(hostId, { name: hostName, ws: null, ready: false, isOperator: true });
  }
  addPlayer(playerId, name, ws) {
    if (this.players.size >= this.maxPlayers || this.players.has(playerId)) return false;
    this.players.set(playerId, { name, ws, ready: false, isOperator: false });
    return true;
  }
  removePlayer(playerId) {
    this.players.delete(playerId);
    if (playerId === this.hostId && this.players.size > 0) {
      const first = Array.from(this.players.keys())[0];
      this.hostId = first;
      this.players.get(first).isOperator = true;
      this.hostName = this.players.get(first).name;
    }
  }
  getPlayerList() {
    return Array.from(this.players.entries()).map(([id, data]) => ({
      id, name: data.name, ready: data.ready, isOperator: data.isOperator, isHost: id === this.hostId
    }));
  }
  setReady(playerId, ready) {
    if (this.players.has(playerId)) { this.players.get(playerId).ready = ready; return true; }
    return false;
  }
  setOperator(playerId, isOperator) {
    if (this.players.has(playerId) && playerId !== this.hostId) {
      this.players.get(playerId).isOperator = isOperator;
      return true;
    }
    return false;
  }
  allReady() {
    if (this.players.size < 2) return false;
    return Array.from(this.players.values()).every(p => p.ready === true);
  }
  startGame() {
    if (this.allReady() && !this.started) {
      this.started = true;
      this.gameState = { wave: 1, enemies: [], players: {}, startedAt: Date.now() };
      return true;
    }
    return false;
  }
}

function handleWebSocket(server) {
  let playerId = null;
  let currentRoom = null;
  server.accept();

  server.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'auth': handleAuth(server, data); break;
        case 'create_room': handleCreateRoom(server, data); break;
        case 'join_room': handleJoinRoom(server, data); break;
        case 'leave_room': handleLeaveRoom(server); break;
        case 'set_ready': handleSetReady(server, data); break;
        case 'promote_operator': handlePromoteOperator(server, data); break;
        case 'start_game': handleStartGame(server); break;
        case 'game_update': handleGameUpdate(server, data); break;
        case 'player_action': handlePlayerAction(server, data); break;
        case 'ping': server.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp })); break;
      }
    } catch (e) { console.error('WS error:', e); }
  });

  server.addEventListener('close', () => handleDisconnect(playerId));

  // Helper functions (same as before, simplified)
  function handleAuth(server, data) {
    const id = 'player_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
    playerId = id;
    server._playerId = id;
    players.set(id, { name: data.name || 'UNKNOWN', ws: server, room: null });
    server.send(JSON.stringify({ type: 'auth_success', playerId: id, name: data.name }));
  }

  function handleCreateRoom(server, data) {
    if (!playerId) return server.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    const { roomCode, playerName } = data;
    if (rooms.has(roomCode)) return server.send(JSON.stringify({ type: 'error', message: 'Room exists' }));
    if (players.get(playerId)?.room) return server.send(JSON.stringify({ type: 'error', message: 'Already in room' }));
    const room = new Room(roomCode, playerId, playerName);
    rooms.set(roomCode, room);
    players.get(playerId).room = roomCode;
    currentRoom = room;
    const pData = room.players.get(playerId);
    if (pData) { pData.ws = server; pData.name = playerName; }
    server.send(JSON.stringify({ type: 'room_created', roomCode, players: room.getPlayerList(), isHost: true }));
    broadcastRoomUpdate(roomCode);
  }

  function handleJoinRoom(server, data) {
    if (!playerId) return server.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    const { roomCode, playerName } = data;
    if (!rooms.has(roomCode)) return server.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    const room = rooms.get(roomCode);
    if (room.players.size >= room.maxPlayers) return server.send(JSON.stringify({ type: 'error', message: 'Room full' }));
    if (players.get(playerId)?.room) return server.send(JSON.stringify({ type: 'error', message: 'Already in room' }));
    if (!room.addPlayer(playerId, playerName, server)) return server.send(JSON.stringify({ type: 'error', message: 'Failed to join' }));
    players.get(playerId).room = roomCode;
    currentRoom = room;
    server.send(JSON.stringify({ type: 'room_joined', roomCode, players: room.getPlayerList(), isHost: false }));
    broadcastRoomUpdate(roomCode);
  }

  function handleLeaveRoom(server) {
    if (!playerId || !currentRoom) return server.send(JSON.stringify({ type: 'error', message: 'Not in room' }));
    const roomCode = currentRoom.code;
    currentRoom.removePlayer(playerId);
    players.get(playerId).room = null;
    currentRoom = null;
    if (currentRoom.players.size === 0) {
      rooms.delete(roomCode);
      server.send(JSON.stringify({ type: 'room_closed' }));
    } else {
      broadcastRoomUpdate(roomCode);
      server.send(JSON.stringify({ type: 'left_room' }));
    }
  }

  function handleSetReady(server, data) {
    if (!playerId || !currentRoom) return;
    currentRoom.setReady(playerId, data.ready);
    broadcastRoomUpdate(currentRoom.code);
  }

  function handlePromoteOperator(server, data) {
    if (!playerId || !currentRoom || playerId !== currentRoom.hostId) return;
    currentRoom.setOperator(data.targetPlayerId, data.promote);
    broadcastRoomUpdate(currentRoom.code);
  }

  function handleStartGame(server) {
    if (!playerId || !currentRoom || playerId !== currentRoom.hostId) return;
    if (currentRoom.startGame()) {
      broadcastRoomUpdate(currentRoom.code);
      broadcastToRoom(currentRoom.code, { type: 'game_started', gameState: currentRoom.gameState, players: currentRoom.getPlayerList() });
    } else {
      server.send(JSON.stringify({ type: 'error', message: 'Not all ready' }));
    }
  }

  function handleGameUpdate(server, data) {
    if (!playerId || !currentRoom || !currentRoom.started) return;
    if (!currentRoom.gameState) currentRoom.gameState = { players: {}, enemies: [], wave: 1 };
    currentRoom.gameState.players[playerId] = data.playerState;
    if (data.enemies) currentRoom.gameState.enemies = data.enemies;
    if (data.wave) currentRoom.gameState.wave = data.wave;
    broadcastToRoom(currentRoom.code, { type: 'game_state_update', gameState: currentRoom.gameState, playerId }, [playerId]);
  }

  function handlePlayerAction(server, data) {
    if (!playerId || !currentRoom || !currentRoom.started) return;
    broadcastToRoom(currentRoom.code, { type: 'player_action', playerId, action: data.action, data: data.data }, [playerId]);
  }

  function handleDisconnect(id) {
    if (!id) return;
    if (players.has(id)) {
      const pData = players.get(id);
      const roomCode = pData.room;
      if (roomCode && rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        room.removePlayer(id);
        if (room.players.size === 0) rooms.delete(roomCode);
        else { broadcastRoomUpdate(roomCode); broadcastToRoom(roomCode, { type: 'player_disconnected', playerId: id }); }
      }
      players.delete(id);
    }
  }

  function broadcastRoomUpdate(roomCode) {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);
    broadcastToRoom(roomCode, { type: 'room_update', players: room.getPlayerList(), isStarted: room.started, hostId: room.hostId, hostName: room.hostName });
  }

  function broadcastToRoom(roomCode, message, excludeIds = []) {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);
    const msg = JSON.stringify(message);
    room.players.forEach((p, id) => {
      if (!excludeIds.includes(id) && p.ws) {
        try { p.ws.send(msg); } catch (e) {}
      }
    });
  }
}

// ============================================================
//  HTML CONTENT (the complete game HTML)
//  Paste your full game HTML here (including all styles and scripts)
// ============================================================
const HTML_CONTENT = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SYNTH PURGE - OVERDRIVE V5</title>
  <style>
    /* All CSS from your game goes here */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: 100vw; height: 100vh; overflow: hidden; font-family: 'Trebuchet MS', Arial, sans-serif; background: #000; }
    canvas { display: block; }
    /* ... (copy all the styles from the previous version) ... */
  </style>
</head>
<body>
  <!-- All HTML elements from your game -->
  <div id="main-menu">...</div>
  <!-- ... -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script>
    // ============================================================
    //  CLIENT-SIDE GAME CODE
    //  (the entire JavaScript from the previous answer)
    //  BUT with one change: auto-detect WebSocket URL
    // ============================================================
    // Replace the hardcoded server URL with:
    const serverUrlInput = document.getElementById('server-url');
    if (serverUrlInput) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      serverUrlInput.value = protocol + '//' + host + '/ws';
    }
    // ... rest of your game code ...
  </script>
</body>
</html>`;
