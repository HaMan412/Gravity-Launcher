const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

// Global log broadcast function (shared from instances.js)
let broadcastGlobalLogFn = null;

// Set broadcast function (called from server.js)
function setBroadcastGlobalLog(fn) {
    broadcastGlobalLogFn = fn;
}

// Execute System Command
router.post('/command', (req, res) => {
    const { command, cwd } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }

    // Echo command to system log
    if (broadcastGlobalLogFn) {
        broadcastGlobalLogFn(`[SYSTEM] > ${command}`);
    }

    try {
        // Execute command in PowerShell
        const child = spawn('powershell', ['-Command', command], {
            cwd: cwd || process.cwd(),
            shell: true,
            encoding: 'utf8'
        });

        // Stream stdout to global log
        child.stdout.on('data', (data) => {
            const text = data.toString().trim();
            if (text && broadcastGlobalLogFn) {
                broadcastGlobalLogFn(text);
            }
        });

        // Stream stderr to global log
        child.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (text && broadcastGlobalLogFn) {
                broadcastGlobalLogFn(`[ERROR] ${text}`);
            }
        });

        // Handle exit
        child.on('close', (code) => {
            if (broadcastGlobalLogFn) {
                if (code === 0) {
                    broadcastGlobalLogFn(`[SYSTEM] Command completed successfully`);
                } else {
                    broadcastGlobalLogFn(`[SYSTEM] Command exited with code ${code}`);
                }
            }
        });

        // Handle errors
        child.on('error', (error) => {
            if (broadcastGlobalLogFn) {
                broadcastGlobalLogFn(`[ERROR] Failed to execute command: ${error.message}`);
            }
        });

        res.json({ success: true, message: 'Command executing' });
    } catch (error) {
        console.error('System command execution error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = { router, setBroadcastGlobalLog };
