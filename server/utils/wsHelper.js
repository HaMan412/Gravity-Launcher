const WebSocket = require('ws');

let wss = null;
const connectionHandlers = [];
const globalLogHistory = [];
const MAX_HISTORY = 500;

function init(server) {
    wss = new WebSocket.Server({ server });
    console.log('WebSocket Server initialized');

    wss.on('connection', (ws) => {
        console.log('New client connected');

        // Handle socket errors
        ws.on('error', (err) => {
            console.error('[WS] Socket error:', err.message);
        });

        try {
            ws.send(JSON.stringify({ type: 'WELCOME', message: 'Connected to Launcher Server' }));

            // Send global history
            globalLogHistory.forEach(msg => {
                try {
                    ws.send(JSON.stringify({ type: 'GLOBAL_LOG', data: msg }));
                } catch (e) {
                    console.error('[WS] Send history error:', e.message);
                }
            });

            connectionHandlers.forEach(handler => {
                try {
                    handler(ws);
                } catch (e) {
                    console.error('[WS] Handler error:', e.message);
                }
            });
        } catch (err) {
            console.error('[WS] Connection setup error:', err.message);
        }
    });

    wss.on('error', (err) => {
        console.error('[WS] Server error:', err.message);
    });

    return wss;
}

function registerConnectionHandler(handler) {
    connectionHandlers.push(handler);
}

function broadcast(data) {
    if (!wss) return;
    wss.clients.forEach(client => {
        try {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        } catch (err) {
            console.error('[WS] Broadcast error:', err.message);
        }
    });
}

function broadcastLog(instanceId, data) {
    broadcast({ type: 'LOG', instanceId, data });
}

function broadcastGlobalLog(message) {
    // Store in history with truncation
    globalLogHistory.push(message);
    if (globalLogHistory.length > MAX_HISTORY) {
        globalLogHistory.shift();
    }
    broadcast({ type: 'GLOBAL_LOG', data: message });
}

function broadcastStatus(instanceId, status) {
    broadcast({ type: 'STATUS', instanceId, status });
}

module.exports = { init, broadcastLog, broadcastGlobalLog, broadcastStatus, registerConnectionHandler, broadcast };
