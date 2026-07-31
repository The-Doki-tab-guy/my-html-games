// SYNTH PURGE MULTIPLAYER SERVER (server.js)
// Requires: npm install ws
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Room Store: { roomCode: { hostId: string, players: Map<ws, PlayerData>, operators: Set<string> } }
const rooms = new Map();

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

wss.on('connection', (ws) => {
    ws.id = Math.random().toString(36).substring(2, 9);
    ws.roomCode = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // 1. CREATE ROOM
            if (data.type === 'create_room') {
                const roomCode = generateRoomCode();
                const room = {
                    code: roomCode,
                    hostId: ws.id,
                    players: new Map(),
                    operators: new Set([ws.id]) // Host is automatically an Operator
                };
                
                rooms.set(roomCode, room);
                ws.roomCode = roomCode;

                const playerData = { id: ws.id, name: data.name || 'Host', isOp: true, isHost: true };
                room.players.set(ws, playerData);

                ws.send(JSON.stringify({
                    type: 'room_created',
                    roomCode: roomCode,
                    playerId: ws.id,
                    isOp: true,
                    isHost: true
                }));
                
                broadcastRoomState(roomCode);
            }

            // 2. JOIN ROOM
            else if (data.type === 'join_room') {
                const roomCode = data.roomCode ? data.roomCode.toUpperCase() : '';
                const room = rooms.get(roomCode);

                if (!room) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found!' }));
                    return;
                }

                ws.roomCode = roomCode;
                const isOp = room.operators.has(ws.id);
                const playerData = { id: ws.id, name: data.name || 'Player', isOp, isHost: false };
                room.players.set(ws, playerData);

                ws.send(JSON.stringify({
                    type: 'room_joined',
                    roomCode: roomCode,
                    playerId: ws.id,
                    isOp,
                    isHost: false
                }));

                broadcastRoomState(roomCode);
            }

            // 3. TOGGLE OPERATOR (Host / OPs only)
            else if (data.type === 'toggle_op') {
                const room = rooms.get(ws.roomCode);
                if (!room) return;

                // Check if requester is an operator
                if (!room.operators.has(ws.id)) {
                    ws.send(JSON.stringify({ type: 'sys_msg', text: 'PERM DENIED: You are not an operator.' }));
                    return;
                }

                const targetId = data.targetPlayerId;
                if (room.operators.has(targetId)) {
                    // Don't un-op host
                    if (targetId !== room.hostId) {
                        room.operators.delete(targetId);
                    }
                } else {
                    room.operators.add(targetId);
                }

                // Sync OP status to player maps
                for (let [client, pData] of room.players.entries()) {
                    pData.isOp = room.operators.has(pData.id);
                }

                broadcastRoomState(ws.roomCode);
            }

            // 4. EXECUTE CHEAT COMMAND (Operator Checked)
            else if (data.type === 'cheat_command') {
                const room = rooms.get(ws.roomCode);
                if (!room) return;

                if (!room.operators.has(ws.id)) {
                    ws.send(JSON.stringify({ 
                        type: 'cheat_result', 
                        success: false, 
                        message: 'OPERATOR PRIVILEGES REQUIRED TO USE CHEATS.' 
                    }));
                    return;
                }

                // Broadcast cheat effect to room if needed
                broadcastToRoom(ws.roomCode, {
                    type: 'cheat_executed',
                    executorId: ws.id,
                    executorName: room.players.get(ws).name,
                    cmd: data.cmd
                });
            }

            // 5. MOVEMENT & STATE SYNC
            else if (data.type === 'player_update') {
                const room = rooms.get(ws.roomCode);
                if (!room) return;

                broadcastToRoom(ws.roomCode, {
                    type: 'player_moved',
                    playerId: ws.id,
                    transform: data.transform
                }, ws);
            }

            // 6. SHOOTING & COMBAT SYNC
            else if (data.type === 'player_shoot') {
                broadcastToRoom(ws.roomCode, {
                    type: 'player_shot',
                    playerId: ws.id,
                    weaponIndex: data.weaponIndex,
                    origin: data.origin,
                    direction: data.direction
                }, ws);
            }

        } catch (err) {
            console.error('Error handling message:', err);
        }
    });

    ws.on('close', () => {
        if (ws.roomCode) {
            const room = rooms.get(ws.roomCode);
            if (room) {
                room.players.delete(ws);
                room.operators.delete(ws.id);

                if (room.players.size === 0) {
                    rooms.delete(ws.roomCode);
                } else {
                    // Reassign host if host left
                    if (room.hostId === ws.id) {
                        const newHost = room.players.keys().next().value;
                        room.hostId = newHost.id;
                        room.operators.add(newHost.id);
                        room.players.get(newHost).isHost = true;
                        room.players.get(newHost).isOp = true;
                    }
                    broadcastRoomState(ws.roomCode);
                }
            }
        }
    });
});

function broadcastToRoom(roomCode, data, excludeWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const msg = JSON.stringify(data);
    for (let client of room.players.keys()) {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

function broadcastRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const playerList = [];
    for (let pData of room.players.values()) {
        playerList.push(pData);
    }

    const msg = JSON.stringify({
        type: 'room_state_update',
        players: playerList,
        hostId: room.hostId
    });

    for (let client of room.players.keys()) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

server.listen(PORT, () => {
    console.log(`[SYNTH PURGE SERVER] Listening on port ${PORT}`);
});
