const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// Active rooms storage: roomCode -> { players: Map(ws -> playerData), hostId: string, operators: Set<string> }
const rooms = new Map();

// Helper to generate 5-character alphanumeric room codes
function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 7).toUpperCase();
    } while (rooms.has(code));
    return code;
}

// Broadcast JSON data to all clients in a room (optionally excluding one socket)
function broadcastToRoom(room, data, excludeWs = null) {
    const message = JSON.stringify(data);
    for (const clientWs of room.players.keys()) {
        if (clientWs !== excludeWs && clientWs.readyState === 1) { // 1 = OPEN
            clientWs.send(message);
        }
    }
}

// Send updated player list and permissions to everyone in a room
function broadcastRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const playerList = Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        isOp: room.operators.has(p.id),
        isHost: p.id === room.hostId
    }));

    broadcastToRoom(room, {
        type: 'room_state_update',
        players: playerList,
        hostId: room.hostId
    });
}

// Clean up player upon disconnect or leave
function handleDisconnect(ws) {
    if (!ws.currentRoom) return;

    const roomCode = ws.currentRoom;
    const room = rooms.get(roomCode);

    if (room) {
        const playerData = room.players.get(ws);
        const playerOp = room.operators.has(ws.id);

        room.players.delete(ws);
        room.operators.delete(ws.id);

        console.log(`[DISCONNECT] ${playerData?.name || ws.id} left room ${roomCode}`);

        if (room.players.size === 0) {
            // Delete empty room
            rooms.delete(roomCode);
            console.log(`[ROOM CLOSED] Room ${roomCode} deleted (empty).`);
        } else {
            // Re-assign Host & OP if Host left
            if (ws.id === room.hostId) {
                const nextWs = room.players.keys().next().value;
                const nextPlayer = room.players.get(nextWs);

                room.hostId = nextPlayer.id;
                room.operators.add(nextPlayer.id);

                console.log(`[HOST MIGRATION] Room ${roomCode} host assigned to ${nextPlayer.name}`);
            }
            broadcastRoomState(roomCode);
        }
    }

    ws.currentRoom = null;
}

wss.on('connection', (ws) => {
    ws.id = Math.random().toString(36).substring(2, 9);
    ws.currentRoom = null;

    console.log(`[CONNECTED] Client connected (ID: ${ws.id})`);

    ws.on('message', (rawMessage) => {
        try {
            const data = JSON.parse(rawMessage);

            // --- 1. CREATE ROOM ---
            if (data.type === 'create_room') {
                const roomCode = generateRoomCode();
                const room = {
                    players: new Map(),
                    hostId: ws.id,
                    operators: new Set([ws.id])
                };

                const playerData = {
                    id: ws.id,
                    name: data.name || 'PILOT'
                };

                room.players.set(ws, playerData);
                rooms.set(roomCode, room);
                ws.currentRoom = roomCode;

                ws.send(JSON.stringify({
                    type: 'room_created',
                    roomCode: roomCode,
                    playerId: ws.id,
                    isOp: true,
                    isHost: true
                }));

                broadcastRoomState(roomCode);
                console.log(`[ROOM CREATED] ${playerData.name} created room ${roomCode}`);
            }

            // --- 2. JOIN ROOM ---
            else if (data.type === 'join_room') {
                const targetCode = (data.roomCode || '').toUpperCase();
                const room = rooms.get(targetCode);

                if (!room) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found!' }));
                    return;
                }

                const playerData = {
                    id: ws.id,
                    name: data.name || 'PILOT'
                };

                room.players.set(ws, playerData);
                ws.currentRoom = targetCode;

                ws.send(JSON.stringify({
                    type: 'room_joined',
                    roomCode: targetCode,
                    playerId: ws.id,
                    isOp: false,
                    isHost: false
                }));

                broadcastRoomState(targetCode);
                console.log(`[JOIN] ${playerData.name} joined room ${targetCode}`);
            }

            // --- 3. TOGGLE OPERATOR PERMISSIONS ---
            else if (data.type === 'toggle_op') {
                const room = rooms.get(ws.currentRoom);
                if (!room) return;

                // Validate that request sender is an Operator
                if (!room.operators.has(ws.id)) {
                    ws.send(JSON.stringify({ type: 'cheat_result', success: false, message: 'UNAUTHORIZED ACCESS.' }));
                    return;
                }

                const targetId = data.targetPlayerId;

                // Toggle logic (Host status cannot be removed via toggle)
                if (room.operators.has(targetId)) {
                    if (targetId !== room.hostId) {
                        room.operators.delete(targetId);
                        console.log(`[OP DEMOTE] Target ${targetId} demoted in room ${ws.currentRoom}`);
                    }
                } else {
                    room.operators.add(targetId);
                    console.log(`[OP PROMOTE] Target ${targetId} made OP in room ${ws.currentRoom}`);
                }

                broadcastRoomState(ws.currentRoom);
            }

            // --- 4. CHEAT COMMAND EXECUTION ---
            else if (data.type === 'cheat_command') {
                const room = rooms.get(ws.currentRoom);
                if (!room) return;

                // Server-side OP validation
                if (!room.operators.has(ws.id)) {
                    ws.send(JSON.stringify({ type: 'cheat_result', success: false, message: 'OPERATOR RIGHTS REQUIRED.' }));
                    return;
                }

                const senderData = room.players.get(ws);
                const cmd = (data.cmd || '').trim().toLowerCase();

                // Confirm success back to sender
                ws.send(JSON.stringify({ type: 'cheat_result', success: true, message: `COMMAND EXEC: [${cmd.toUpperCase()}]` }));

                // Notify all players in room of cheat execution
                broadcastToRoom(room, {
                    type: 'cheat_executed',
                    executorName: senderData?.name || 'OPERATOR',
                    cmd: cmd
                });
            }

            // --- 5. REAL-TIME MOVEMENT SYNC ---
            else if (data.type === 'player_update') {
                const room = rooms.get(ws.currentRoom);
                if (!room) return;

                broadcastToRoom(room, {
                    type: 'player_moved',
                    playerId: ws.id,
                    transform: data.transform
                }, ws); // Exclude sender from receiving their own transform echo
            }

        } catch (err) {
            console.error('[ERROR] Failed to parse socket message:', err);
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error(`[SOCKET ERROR] Client ${ws.id}:`, error);
    });
});

console.log(`========================================`);
console.log(`SYNTH PURGE V5 SERVER ACTIVE ON PORT ${PORT}`);
console.log(`Listening for local & network socket calls...`);
console.log(`========================================`);
