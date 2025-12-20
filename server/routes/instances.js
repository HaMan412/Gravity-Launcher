const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { broadcastLog: wsBroadcastLog, broadcastStatus: wsBroadcastStatus, broadcastGlobalLog, registerConnectionHandler } = require('../utils/wsHelper');
const WebSocket = require('ws');

// Constants
const DATA_FILE = path.resolve(__dirname, '../../server/data.json');
const BIN_DIR = path.resolve(__dirname, '../../bin');

// In-memory process store
const runningProcesses = {}; // { instanceId: ChildProcess }
const terminalProcesses = {}; // { instanceId: ChildProcess } - embedded terminal shells
const terminalLogs = {}; // { instanceId: string[] } - terminal output history
const logHistory = {}; // { instanceId: string[] }

// Register handler to send log history to new clients
registerConnectionHandler((ws) => {
    // Send instance log history
    Object.keys(logHistory).forEach(id => {
        logHistory[id].forEach(msg => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'LOG', instanceId: id, data: msg }));
            }
        });
    });

    // Send terminal log history and open status
    Object.keys(terminalLogs).forEach(id => {
        // Send terminal logs
        terminalLogs[id].forEach(msg => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'TERMINAL_OUTPUT', instanceId: id, data: msg }));
            }
        });
        // Send terminal open status if terminal is running
        if (terminalProcesses[id]) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'TERMINAL_OPENED', instanceId: id }));
            }
        }
    });
});


// Helper to load data
function loadData() {
    if (!fs.existsSync(DATA_FILE)) return { instances: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Helper to save data
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Helper: Get best available Node.js path
function getNodePath() {
    // 1. Check local portable node (flattened structure)
    const localNode = path.join(BIN_DIR, 'node-v24.12.0-win-x64', 'node.exe');
    if (fs.existsSync(localNode)) return localNode;

    // 2. Check old/alternative local structure
    const alternativeNode = path.join(BIN_DIR, 'node', 'node.exe');
    if (fs.existsSync(alternativeNode)) return alternativeNode;

    // 3. Fallback to global node
    return 'node';
}

// Helper: Get best available UV path
function getUvPath() {
    // 1. Check local portable uv
    const localUv = path.join(BIN_DIR, 'uv-x86_64-pc-windows-msvc', 'uv.exe');
    if (fs.existsSync(localUv)) return localUv;

    // 2. Fallback to global uv
    return 'uv';
}

// Helper: Get tool binary directory (for PATH environment)
function getNodeBinDir() {
    const nodeExe = getNodePath();
    if (nodeExe === 'node') return null;
    return path.dirname(nodeExe);
}

function getGitBinDir() {
    const gitBin = path.join(BIN_DIR, 'PortableGit', 'cmd');
    return fs.existsSync(gitBin) ? gitBin : null;
}

// Helper: Get best available Python path
function getPythonPath() {
    // 1. Check local portable python (full version - new)
    const localPythonFull = path.join(BIN_DIR, 'python-3.12.8-full-amd64', 'python.exe');
    if (fs.existsSync(localPythonFull)) return localPythonFull;

    // 2. Check old embed version (legacy support)
    const legacyPython = path.join(BIN_DIR, 'python-3.12.8-embed-amd64', 'python.exe');
    if (fs.existsSync(legacyPython)) return legacyPython;

    // 3. Fallback to global python
    return 'python';
}

// Wrapper functions that also store to logHistory
function broadcastLog(instanceId, message) {
    if (!logHistory[instanceId]) logHistory[instanceId] = [];
    logHistory[instanceId].push(message);
    if (logHistory[instanceId].length > 1000) logHistory[instanceId].shift();
    // Use wsHelper to actually broadcast
    wsBroadcastLog(instanceId, message);
}

function broadcastStatus(instanceId, status) {
    wsBroadcastStatus(instanceId, status);
}

// Regex to strip ANSI color codes
const stripAnsi = (str) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

// Routes

// Get all instances
router.get('/', (req, res) => {
    const data = loadData();
    const instancesWithStatus = data.instances.map(inst => ({
        ...inst,
        type: inst.type || 'yunzai',
        status: runningProcesses[inst.id] ? 'running' : 'stopped'
    }));
    res.json(instancesWithStatus);
});

// Start Instance
router.post('/start/:id', async (req, res) => {
    const { id } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (runningProcesses[id]) return res.status(400).json({ error: 'Already running' });

    // Redis auto-start removed (now handled independently)

    // 2. Prepare Environment - Simplified PATH building
    // Only add directories that actually exist
    const env = { ...process.env };
    let pathParts = [];

    // Use helpers to find directories
    const nodeBinDir = getNodeBinDir();
    const gitBinDir = getGitBinDir();
    const redisBinDir = path.join(BIN_DIR, 'redis');
    const pythonBinDir = path.join(BIN_DIR, 'python-3.12.8-embed-amd64');

    // Only add paths that actually exist
    if (nodeBinDir && fs.existsSync(nodeBinDir)) {
        pathParts.push(nodeBinDir);
        console.log(`Found portable Node.js: ${nodeBinDir}`);
    }
    if (fs.existsSync(gitBinDir)) {
        pathParts.push(gitBinDir);
    }
    if (fs.existsSync(redisBinDir)) {
        pathParts.push(redisBinDir);
    }
    if (fs.existsSync(pythonBinDir)) {
        pathParts.push(pythonBinDir);
    }
    const uvBinDir = path.join(BIN_DIR, 'uv-x86_64-pc-windows-msvc');
    if (fs.existsSync(uvBinDir)) {
        pathParts.push(uvBinDir);
    }

    // Handle Windows case-insensitive Path/PATH key
    let pathKey = 'PATH';
    for (const key in env) {
        if (key.toUpperCase() === 'PATH') {
            pathKey = key;
            break;
        }
    }

    // Append system PATH
    if (env[pathKey]) {
        pathParts.push(env[pathKey]);
    }

    env[pathKey] = pathParts.join(';');

    // Proxy Injection
    if (instance.proxy && instance.proxy.host) {
        const { protocol, host, port, auth, username, password } = instance.proxy;
        const proto = protocol || 'http';
        const p = port ? `:${port}` : '';
        let url = '';
        let logUrl = '';

        if (auth && username) {
            const encodedUser = encodeURIComponent(username);
            const encodedPass = encodeURIComponent(password);
            url = `${proto}://${encodedUser}:${encodedPass}@${host}${p}`;
            logUrl = `${proto}://${username}:******@${host}${p}`;
        } else {
            url = `${proto}://${host}${p}`;
            logUrl = url;
        }
        env.HTTP_PROXY = url;
        env.HTTPS_PROXY = url;
        env.ALL_PROXY = url;
        console.log(`Proxy injected: ${logUrl}`);
        broadcastLog(id, `[SYSTEM] Using Proxy: ${logUrl}`);
    }

    if (!fs.existsSync(instance.path)) {
        const error = `Instance path not found: ${instance.path}`;
        console.error(error);
        broadcastLog(id, `--- ERROR: ${error} ---`);
        return res.status(500).json({ error });
    }

    console.log(`Starting instance ${id} at ${instance.path}`);
    broadcastLog(id, `--- Starting Instance ${instance.name} ---`);
    broadcastLog(id, `Working Directory: ${instance.path}`);

    // Determine start command based on instance type
    let child;
    const instanceType = instance.type || 'yunzai';

    if (instanceType === 'gsuid') {
        // GSUID Core uses: uv run core
        console.log(`Starting GSUID Core with: uv run core`);
        broadcastLog(id, `Starting GSUID Core...`);

        // Add UTF-8 encoding environment variables to fix Windows console encoding issues
        const gsuidEnv = {
            ...env,
            PYTHONUTF8: '1',                    // Force Python to use UTF-8 encoding
            PYTHONIOENCODING: 'utf-8'           // Set IO encoding to UTF-8
        };

        child = spawn('uv', ['run', 'core'], {
            cwd: instance.path,
            env: gsuidEnv,
            shell: true
        });
    } else if (instanceType === 'nonebot') {
        // NoneBot: Check if project was created with nb-cli (has pyproject.toml)
        const pyprojectPath = path.join(instance.path, 'pyproject.toml');
        const usesNbCli = fs.existsSync(pyprojectPath);

        // Always use venv python directly to run bot.py (most reliable)
        // nb run can have issues with Python path resolution
        const venvPython = path.join(instance.path, '.venv', 'Scripts', 'python.exe');
        const botPy = path.join(instance.path, 'bot.py');

        // Check if venv exists
        if (!fs.existsSync(venvPython)) {
            broadcastLog(id, `--- ERROR: Virtual environment not found. Please recreate the instance. ---`);
            return res.status(500).json({ error: 'Virtual environment not found' });
        }

        // Check if bot.py exists
        if (!fs.existsSync(botPy)) {
            broadcastLog(id, `--- ERROR: bot.py not found. Please check the instance. ---`);
            return res.status(500).json({ error: 'bot.py not found' });
        }

        console.log(`Starting NoneBot with: ${venvPython} ${botPy}`);
        broadcastLog(id, `Starting NoneBot...`);
        broadcastLog(id, `Using Python: ${venvPython}`);

        child = spawn(venvPython, [botPy], {
            cwd: instance.path,
            env: {
                ...env,
                PYTHONUTF8: '1',
                PYTHONIOENCODING: 'utf-8',
                VIRTUAL_ENV: path.join(instance.path, '.venv')
            }
        });

    } else {
        // Yunzai-Bot uses: node app.js
        console.log(`Using Node.js: ${process.execPath}`);
        broadcastLog(id, `Using Node: ${process.execPath}`);

        const appPath = path.join(instance.path, 'app.js');
        child = spawn(process.execPath, [appPath], {
            cwd: instance.path,
            env
        });
    }

    runningProcesses[id] = child;
    let hasStarted = false;
    broadcastStatus(id, 'starting');



    child.stdout.on('data', (data) => {
        // Yunzai (Node.js) usually outputs UTF-8. 
        // If there are mixed encodings (e.g. system errors in GBK), it's hard to handle perfectly without heuristics.
        // Assuming UTF-8 as primary for Node app output.
        const text = data.toString('utf8').trim();
        if (text) {
            const cleanText = stripAnsi(text);
            console.log(`[${instance.name}] ${cleanText}`);
            broadcastLog(id, cleanText);
        }

        // Mark as running when we get first output
        if (!hasStarted) {
            hasStarted = true;
            broadcastStatus(id, 'running');
        }
    });

    child.stderr.on('data', (data) => {
        const text = data.toString('utf8').trim();
        if (text) {
            const cleanText = stripAnsi(text);
            console.error(`[${instance.name} ERR] ${cleanText}`);
            broadcastLog(id, cleanText);
        }
    });

    child.on('error', (err) => {
        console.error(`Failed to start instance ${id}:`, err);
        broadcastLog(id, `--- Launch Error: ${err.message} ---`);
        delete runningProcesses[id];
        broadcastStatus(id, 'stopped');
    });

    child.on('close', (code) => {
        console.log(`Instance ${id} exited with code ${code}`);
        broadcastLog(id, `--- Instance Exited (Code: ${code}) ---`);
        delete runningProcesses[id];
        broadcastStatus(id, 'stopped');

        // Check if this was the last running instance and Redis should be stopped
        const runningCount = Object.keys(runningProcesses).length;
        if (runningCount === 0) {
            // Check if Redis is locked (keep alive)
            const data = loadData();
            const redisLocked = data.settings?.redisKeepAlive === true;

            if (!redisLocked) {
                // Stop Redis via HTTP request to our own API
                console.log('[SYSTEM] Last instance closed, stopping Redis...');
                broadcastGlobalLog('[SYSTEM] Last instance closed, stopping Redis...');
                const http = require('http');
                const req = http.request({
                    hostname: 'localhost',
                    port: 3575,
                    path: '/api/deps/redis/stop',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                req.on('error', () => { }); // Ignore errors
                req.end();
            } else {
                console.log('[SYSTEM] Last instance closed, Redis locked - keeping alive');
                broadcastGlobalLog('[SYSTEM] Redis locked - keeping alive');
            }
        }
    });

    res.json({ message: 'Starting' });
});

// Stop Instance
router.post('/stop/:id', (req, res) => {
    const { id } = req.params;
    const child = runningProcesses[id];

    if (!child) return res.status(400).json({ error: 'Not running' });

    // Windows needs taskkill to properly terminate shell-spawned processes
    if (process.platform === 'win32') {
        const { exec } = require('child_process');
        exec(`taskkill /PID ${child.pid} /T /F`, (err) => {
            if (err) {
                console.error('taskkill error:', err);
                // Fallback to regular kill
                child.kill('SIGKILL');
            }
        });
    } else {
        child.kill('SIGKILL');
    }

    delete runningProcesses[id];
    broadcastStatus(id, 'stopped');
    broadcastLog(id, '--- Instance Stopped ---');
    res.json({ message: 'Stop signal sent' });
});

// Send Command to Instance
router.post('/command/:id', (req, res) => {
    const { id } = req.params;
    const { command } = req.body;
    const child = runningProcesses[id];

    // If instance is running, send to stdin
    if (child) {
        if (!child.stdin || child.stdin.destroyed) {
            return res.status(400).json({ error: 'Instance stdin unavailable' });
        }

        try {
            broadcastLog(id, `> ${command}`);
            child.stdin.write(command + '\n');
            return res.json({ success: true, mode: 'interactive' });
        } catch (error) {
            console.error(`Failed to send command to instance ${id}:`, error);
            return res.status(500).json({ error: error.message });
        }
    }

    // If instance is NOT running, execute as system command in instance directory
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    try {
        broadcastLog(id, `[OFFLINE] > ${command}`);

        // Spawn temporary process using PowerShell directly for better compatibility
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];

        const tempChild = spawn('powershell', args, {
            cwd: instance.path,
            env: { ...process.env, FORCE_COLOR: '1' }
        });

        tempChild.stdout.on('data', (data) => {
            // Convert buffer to string, simple conversion for now
            const output = data.toString();
            broadcastLog(id, output);
        });

        tempChild.stderr.on('data', (data) => {
            const output = data.toString();
            broadcastLog(id, output);
        });

        tempChild.on('error', (err) => {
            broadcastLog(id, `[EXEC ERR] Process start failed: ${err.message}`);
        });

        // We don't track this process in runningProcesses as it's short-lived/maintenance
        res.json({ success: true, mode: 'offline' });

    } catch (error) {
        console.error(`Failed to execute offline command for instance ${id}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Get Logs
router.get('/logs/:id', (req, res) => {
    const { id } = req.params;
    res.json({ logs: logHistory[id] || [] });
});

// Toggle AutoStart
router.post('/autostart/:id', (req, res) => {
    const { id } = req.params;
    const { autoStart } = req.body;

    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    instance.autoStart = autoStart;
    saveData(data);

    res.json({ success: true, autoStart });
});

// NoneBot: Get .env file content
router.get('/nonebot/env/:id', (req, res) => {
    const { id } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.type !== 'nonebot') return res.status(400).json({ error: 'Not a NoneBot instance' });

    const envPath = path.join(instance.path, '.env');
    if (!fs.existsSync(envPath)) {
        return res.json({ content: '' });
    }

    try {
        const content = fs.readFileSync(envPath, 'utf8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read .env file' });
    }
});

// NoneBot: Save .env file content
router.put('/nonebot/env/:id', (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.type !== 'nonebot') return res.status(400).json({ error: 'Not a NoneBot instance' });

    const envPath = path.join(instance.path, '.env');

    try {
        fs.writeFileSync(envPath, content, 'utf8');

        // Also update port in data.json if PORT changed
        const portMatch = content.match(/^PORT\s*=\s*(\d+)/m);
        if (portMatch) {
            instance.port = portMatch[1];
            saveData(data);
        }

        broadcastGlobalLog(`[SYSTEM] NoneBot .env updated for ${instance.name}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save .env file' });
    }
});

// NoneBot: Get bot.py file content
router.get('/nonebot/bot-py/:id', (req, res) => {
    const { id } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.type !== 'nonebot') return res.status(400).json({ error: 'Not a NoneBot instance' });

    const botPath = path.join(instance.path, 'bot.py');
    if (!fs.existsSync(botPath)) {
        return res.json({ content: '' });
    }

    try {
        const content = fs.readFileSync(botPath, 'utf8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read bot.py file' });
    }
});

// NoneBot: Save bot.py file content
router.put('/nonebot/bot-py/:id', (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.type !== 'nonebot') return res.status(400).json({ error: 'Not a NoneBot instance' });

    const botPath = path.join(instance.path, 'bot.py');

    try {
        fs.writeFileSync(botPath, content, 'utf8');
        broadcastGlobalLog(`[SYSTEM] NoneBot bot.py updated for ${instance.name}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save bot.py file' });
    }
});

// NoneBot: Get pyproject.toml file content
router.get('/nonebot/pyproject/:id', (req, res) => {
    const { id } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.type !== 'nonebot') return res.status(400).json({ error: 'Not a NoneBot instance' });

    const pyprojectPath = path.join(instance.path, 'pyproject.toml');

    if (!fs.existsSync(pyprojectPath)) {
        return res.json({ content: '' });
    }

    try {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read pyproject.toml file' });
    }
});

// NoneBot: Save pyproject.toml file content
router.put('/nonebot/pyproject/:id', (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (instance.type !== 'nonebot') return res.status(400).json({ error: 'Not a NoneBot instance' });

    const pyprojectPath = path.join(instance.path, 'pyproject.toml');

    try {
        fs.writeFileSync(pyprojectPath, content, 'utf8');
        broadcastGlobalLog(`[SYSTEM] NoneBot pyproject.toml updated for ${instance.name}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save pyproject.toml file' });
    }
});

// ============ LLOneBot Integration APIs ============


// Get LLOneBot path from data.json
router.get('/llonebot/path', (req, res) => {
    const data = loadData();
    res.json({ path: data.llonebotPath || '' });
});

// Save LLOneBot path to data.json
router.put('/llonebot/path', (req, res) => {
    const { path: llonebotPath } = req.body;
    const data = loadData();
    data.llonebotPath = llonebotPath;
    saveData(data);
    broadcastGlobalLog(`[SYSTEM] LLOneBot path set to: ${llonebotPath}`);
    res.json({ success: true });
});

// Detect LLOneBot configs (scan for config_*.json files)
// Supports both old (data/) and new (bin/llonebot/data/) directory structures
router.get('/llonebot/detect', (req, res) => {
    const data = loadData();
    const llonebotPath = data.llonebotPath;

    if (!llonebotPath || !fs.existsSync(llonebotPath)) {
        return res.json({ configured: false, configs: [], version: 'unknown' });
    }

    // Auto-detect directory structure: new version uses bin/llonebot/data/, old uses data/
    const newDataDir = path.join(llonebotPath, 'bin', 'llonebot', 'data');
    const oldDataDir = path.join(llonebotPath, 'data');

    let dataDir = null;
    let version = 'unknown';

    if (fs.existsSync(newDataDir)) {
        dataDir = newDataDir;
        version = 'new'; // New standalone LLOneBot (llbot.exe)
    } else if (fs.existsSync(oldDataDir)) {
        dataDir = oldDataDir;
        version = 'legacy'; // Old LiteLoaderQQNT plugin version
    }

    if (!dataDir) {
        return res.json({ configured: true, configs: [], version });
    }

    try {
        const files = fs.readdirSync(dataDir);
        const configs = files
            .filter(f => f.startsWith('config_') && f.endsWith('.json'))
            .map(f => {
                const qq = f.replace('config_', '').replace('.json', '');
                const configPath = path.join(dataDir, f);
                try {
                    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    const wsReverse = content.ob11?.connect?.find(c => c.type === 'ws-reverse');
                    return {
                        qq,
                        configPath,
                        currentUrl: wsReverse?.url || '',
                        enabled: wsReverse?.enable || false
                    };
                } catch {
                    return { qq, configPath, currentUrl: '', enabled: false };
                }
            });

        res.json({ configured: true, configs, version });
    } catch (err) {
        res.status(500).json({ error: 'Failed to scan LLOneBot configs' });
    }
});

// Helper: Resolve LLOneBot config path (auto-detect new/old structure)
function resolveLLOneBotConfigPath(llonebotPath, qq) {
    // New version: bin/llonebot/data/config_*.json
    const newPath = path.join(llonebotPath, 'bin', 'llonebot', 'data', `config_${qq}.json`);
    if (fs.existsSync(newPath)) return newPath;

    // Old version: data/config_*.json
    const oldPath = path.join(llonebotPath, 'data', `config_${qq}.json`);
    if (fs.existsSync(oldPath)) return oldPath;

    return null;
}

// Configure LLOneBot to connect to an instance
router.put('/llonebot/connect', (req, res) => {
    const { qq, instanceId, instanceName, instanceType, port } = req.body;
    const data = loadData();
    const llonebotPath = data.llonebotPath;

    if (!llonebotPath) {
        return res.status(400).json({ error: 'LLOneBot path not configured' });
    }

    // Auto-detect config path for both new and old versions
    const configPath = resolveLLOneBotConfigPath(llonebotPath, qq);
    if (!configPath) {
        return res.status(404).json({ error: 'LLOneBot config not found' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Build the connection URL based on instance type
        // NoneBot uses /onebot/v11/ws, Yunzai (TRSS) uses /OneBotv11
        const url = instanceType === 'nonebot'
            ? `ws://127.0.0.1:${port}/onebot/v11/ws`
            : `ws://127.0.0.1:${port}/OneBotv11`;

        const adapterName = `Gravity-${instanceName}`;
        let status = 'created';

        // Ensure ob11 structure exists
        if (!config.ob11) config.ob11 = { enable: true, connect: [] };
        if (!config.ob11.connect) config.ob11.connect = [];

        // Check if adapter with same name already exists
        const existingIndex = config.ob11.connect.findIndex(c => c.name === adapterName);
        if (existingIndex !== -1) {
            const existing = config.ob11.connect[existingIndex];
            // Check if content is already identical
            if (existing.url === url && existing.type === 'ws-reverse' && existing.enable === true) {
                status = 'exists';
            } else {
                // Update existing adapter with same name
                config.ob11.connect[existingIndex] = {
                    ...existing,
                    type: 'ws-reverse',
                    enable: true,
                    url,
                    name: adapterName
                };
                status = 'updated';
                broadcastGlobalLog(`[SYSTEM] Updated LLOneBot adapter: ${adapterName}`);
            }
        } else {
            // Create NEW adapter
            config.ob11.connect.push({
                type: 'ws-reverse',
                enable: true,
                url,
                name: adapterName,
                heartInterval: 5000,
                token: '',
                reportSelfMessage: false,
                reportOfflineMessage: false,
                messageFormat: 'array',
                debug: false
            });
            status = 'created';
            broadcastGlobalLog(`[SYSTEM] Created new LLOneBot adapter: ${adapterName}`);
        }

        // Ensure ob11 is enabled
        config.ob11.enable = true;

        if (status !== 'exists') {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            broadcastGlobalLog(`[SYSTEM] LLOneBot configured to connect to ${instanceName} (${url})`);
        }

        res.json({ success: true, url, adapterName, status });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update LLOneBot config' });
    }
});

const runStep = (command, args, cwd, res) => {
    return new Promise((resolve, reject) => {
        const cmdStr = `${command} ${args.join(' ')}`;
        broadcastGlobalLog(`[SYSTEM] Executing: ${cmdStr}`);

        const isWin = process.platform === 'win32';
        const cmd = isWin && (command === 'npm' || command === 'pnpm') ? `${command}.cmd` : command;

        // Prepare Environment with bundled tool paths
        const env = { ...process.env };
        const gitBin = getGitBinDir();
        const nodeBin = getNodeBinDir();
        const pythonBin = path.dirname(getPythonPath());
        const uvBin = path.join(BIN_DIR, 'uv-x86_64-pc-windows-msvc');

        // Tell UV to use local Python, not download
        env.UV_PYTHON_DOWNLOADS = 'never';

        // Prepend to PATH
        if (isWin) {
            let pathKey = 'PATH';
            for (const key in env) {
                if (key.toUpperCase() === 'PATH') {
                    pathKey = key;
                    break;
                }
            }
            const currentPath = env[pathKey] || '';
            // Only add if they exist
            const parts = [gitBin, nodeBin, pythonBin, uvBin].filter(p => fs.existsSync(p));
            env[pathKey] = `${parts.join(';')};${currentPath}`;
        } else {
            const parts = [gitBin, nodeBin, pythonBin, uvBin].filter(p => fs.existsSync(p));
            env.PATH = `${parts.join(':')}:${env.PATH}`;
        }

        // Quote command if it contains spaces (Windows shell issue)
        const quotedCmd = cmd.includes(' ') ? `"${cmd}"` : cmd;
        const proc = spawn(quotedCmd, args, { cwd, shell: true, env });

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                const cleanLine = stripAnsi(line.trim());
                if (cleanLine) broadcastGlobalLog(`[INSTALL] ${cleanLine}`);
            });
        });

        proc.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                const cleanLine = stripAnsi(line.trim());
                if (cleanLine) broadcastGlobalLog(`[INSTALL] ${cleanLine}`);
            });
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
};

// Check if port is available
const net = require('net');

function checkPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false); // Port is in use
            } else {
                resolve(false);
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(true); // Port is available
        });
        server.listen(port);
    });
}

// Helper: Get instance port from config file or data.json
function getInstancePort(instance) {
    // First check data.json port field
    if (instance.port) {
        return String(instance.port);
    }

    // Then try to read from Yunzai config/config/server.yaml
    try {
        const serverYamlPath = path.join(instance.path, 'config', 'config', 'server.yaml');
        if (fs.existsSync(serverYamlPath)) {
            const content = fs.readFileSync(serverYamlPath, 'utf8');
            const match = content.match(/port:\s*(\d+)/);
            if (match) {
                return match[1];
            }
        }
    } catch (e) {
        // Ignore errors
    }

    // Default port
    return '2536';
}

// Port availability check endpoint
router.get('/checkPort/:port', async (req, res) => {
    const port = parseInt(req.params.port);
    if (isNaN(port) || port < 1 || port > 65535) {
        return res.json({ available: false, error: 'Invalid port number' });
    }

    // Check if port is used by other instances
    let currentData = { instances: [] };
    if (fs.existsSync(DATA_FILE)) {
        currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }

    // Check each instance's actual port (from config file or data.json)
    for (const inst of currentData.instances || []) {
        const instPort = getInstancePort(inst);
        if (String(instPort) === String(port)) {
            return res.json({ available: false, usedBy: inst.name });
        }
    }

    // Also check if port is in use by other processes
    const available = await checkPortAvailable(port);
    res.json({ available, inUseBySystem: !available });
});

// Name availability check endpoint
router.get('/checkName/:name', (req, res) => {
    const name = req.params.name;
    let currentData = { instances: [] };
    if (fs.existsSync(DATA_FILE)) {
        currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
    const exists = currentData.instances?.some(i => i.name === name);
    res.json({ available: !exists });
});

// Helper to allocate LLOneBot port - Removed


router.post('/create', async (req, res) => {
    const { name, port, type, gsuidRepoSource } = req.body;
    const instanceName = name || 'Yunzai-Bot';
    const instancePort = port || '2536';
    const instanceType = type || 'yunzai';
    const gsuidRepo = gsuidRepoSource || 'gitee'; // default to gitee

    // === Validate instance name format ===
    const validNamePattern = /^[a-zA-Z0-9_-]+$/;
    if (!validNamePattern.test(instanceName)) {
        broadcastGlobalLog(`[ERR] Invalid instance name: "${instanceName}". Only English letters, numbers, hyphens and underscores allowed.`);
        return res.status(400).json({
            error: '实例名称只能包含英文字母、数字、连字符(-)和下划线(_)，不支持中文或其他特殊字符'
        });
    }

    const installPath = path.join(process.cwd(), 'instances', instanceName);

    // === Pre-flight checks ===
    if (instanceType === 'yunzai') {
        const nodeExe = getNodePath();
        const hasPortableNode = nodeExe !== 'node' && fs.existsSync(nodeExe);
        const hasSystemNode = require('child_process').spawnSync('node', ['--version'], { shell: true }).status === 0;

        if (!hasPortableNode && !hasSystemNode) {
            broadcastGlobalLog(`[ERR] Node.js not found.`);
            return res.status(400).json({ error: '未检测到 Node.js，请先安装' });
        }
    } else if (instanceType === 'gsuid') {
        // Check for UV
        const uvExe = getUvPath();
        const hasPortableUv = uvExe !== 'uv' && fs.existsSync(uvExe);
        const hasSystemUv = require('child_process').spawnSync('uv', ['--version'], { shell: true }).status === 0;

        if (!hasPortableUv && !hasSystemUv) {
            broadcastGlobalLog(`[ERR] 'uv' command not found. Please install UV in Environment Management.`);
            return res.status(400).json({ error: '未检测到 uv 命令，请在环境管理中安装 UV' });
        }
    } else if (instanceType === 'nonebot') {
        // Check for Python
        const pythonExe = getPythonPath();
        const hasPortablePython = pythonExe !== 'python' && fs.existsSync(pythonExe);
        const hasPythonInPath = require('child_process').spawnSync('python', ['--version'], { shell: true }).status === 0;

        if (!hasPortablePython && !hasPythonInPath) {
            broadcastGlobalLog(`[ERR] Python not found. Please install Python first.`);
            return res.status(400).json({ error: '未检测到 Python，请先安装 Python' });
        }
    }

    const gitBinDir = getGitBinDir();
    const hasPortableGit = gitBinDir && fs.existsSync(path.join(gitBinDir, 'git.exe'));
    const hasSystemGit = require('child_process').spawnSync('git', ['--version'], { shell: true }).status === 0;

    if (!hasPortableGit && !hasSystemGit) {
        broadcastGlobalLog(`[ERR] Git not found. Please install Git.`);
        return res.status(400).json({ error: '未检测到 Git，请先安装' });
    }
    // === End Pre-flight checks ===

    // Validate unique name
    let currentData = { instances: [] };
    if (fs.existsSync(DATA_FILE)) {
        currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }

    if (currentData.instances?.some(i => i.name === instanceName)) {
        return res.status(400).json({ error: `实例名称 "${instanceName}" 已存在` });
    }

    // Check port usage (generic)
    for (const inst of currentData.instances || []) {
        if (String(inst.port) === String(instancePort)) {
            return res.status(400).json({ error: `端口 ${instancePort} 已被实例 "${inst.name}" 使用` });
        }
    }

    if (fs.existsSync(installPath)) {
        return res.status(400).json({ error: 'Directory already exists' });
    }

    res.json({ message: 'Creation started' });

    try {
        fs.mkdirSync(path.dirname(installPath), { recursive: true });

        if (instanceType === 'yunzai') {
            // 1. Git Clone
            await runStep('git', ['clone', '--depth', '1', 'https://gitee.com/TimeRainStarSky/Yunzai', `"${installPath}"`], process.cwd());
            // 2. Install PNPM
            await runStep('npm', ['i', '-g', 'pnpm'], installPath);
            // 3. PNPM Install
            await runStep('pnpm', ['i'], installPath);

            // 4. Configure Port
            broadcastGlobalLog(`[SYSTEM] Configuring instance port: ${instancePort}`);
            const configDir = path.join(installPath, 'config', 'config');
            const serverYamlPath = path.join(configDir, 'server.yaml');
            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

            let serverConfig = `# Server Configuration\nport: ${instancePort}\nhost: "0.0.0.0"\n`;
            if (fs.existsSync(serverYamlPath)) {
                let content = fs.readFileSync(serverYamlPath, 'utf8');
                if (content.includes('port:')) {
                    content = content.replace(/port:\s*\d+/, `port: ${instancePort}`);
                } else {
                    content = `port: ${instancePort}\n` + content;
                }
                serverConfig = content;
            }
            fs.writeFileSync(serverYamlPath, serverConfig);
            broadcastGlobalLog(`[SYSTEM] Port configured: ${instancePort}`);


        } else if (instanceType === 'gsuid') {
            // GSUID Steps
            // Read selected mirror from config
            let selectedMirror = 'official'; // default
            try {
                if (fs.existsSync(DATA_FILE)) {
                    const configData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                    selectedMirror = configData.dependencies?.selectedMirror || 'official';
                    gsuidRepo = configData.dependencies?.gsuidRepo || 'github';
                }
            } catch (e) {
                broadcastGlobalLog(`[WARN] Failed to read mirror config, using official source`);
            }

            // 1. Git Clone (with repository source selection)
            let gsuidRepoUrl;

            if (gsuidRepo === 'gitee') {
                // Use Gitee mirror (fast for China)
                gsuidRepoUrl = 'https://gitee.com/hamann/gsuid_core_gitee.git';
                broadcastGlobalLog(`[SYSTEM] Using Gitee mirror (hamann/gsuid_core_gitee)`);
            } else {
                //  Use GitHub official (with mirror support if selected)
                if (selectedMirror === 'china') {
                    gsuidRepoUrl = 'https://ghproxy.net/https://github.com/Genshin-bots/gsuid_core.git';
                } else if (selectedMirror === 'ghproxy') {
                    gsuidRepoUrl = 'https://mirror.ghproxy.com/https://github.com/Genshin-bots/gsuid_core.git';
                } else if (selectedMirror === 'fastgit') {
                    gsuidRepoUrl = 'https://download.fastgit.org/Genshin-bots/gsuid_core.git';
                } else {
                    gsuidRepoUrl = 'https://github.com/Genshin-bots/gsuid_core.git';
                }
                broadcastGlobalLog(`[SYSTEM] Using GitHub official (Genshin-bots/gsuid_core)`);
            }

            broadcastGlobalLog(`[SYSTEM] Cloning GSUID Core from: ${gsuidRepoUrl}`);

            // Disable SSL verification for git clone to avoid certificate issues
            try {
                await runStep('git', ['config', '--global', 'http.sslVerify', 'false'], process.cwd());
                broadcastGlobalLog(`[SYSTEM] Temporarily disabled SSL verification`);
            } catch (e) {
                broadcastGlobalLog(`[WARN] Failed to disable SSL verification: ${e}`);
            }

            try {
                await runStep('git', ['clone', '--depth', '1', gsuidRepoUrl, `"${installPath}"`], process.cwd());
            } finally {
                // Re-enable SSL verification after clone
                try {
                    await runStep('git', ['config', '--global', 'http.sslVerify', 'true'], process.cwd());
                    broadcastGlobalLog(`[SYSTEM] Re-enabled SSL verification`);
                } catch (e) {
                    broadcastGlobalLog(`[WARN] Failed to re-enable SSL verification: ${e}`);
                }
            }


            // 2. UV Sync - installs all dependencies using local Python
            const localPython = getPythonPath();
            broadcastGlobalLog(`[SYSTEM] Installing GSUID dependencies...`);
            broadcastGlobalLog(`[SYSTEM] Using Python: ${localPython}`);
            await runStep('uv', ['sync', '--python', localPython], installPath);


            // 3. Configure Port (GSUID uses gsuid_core/data/config.json)
            broadcastGlobalLog(`[SYSTEM] Configuring GSUID port: ${instancePort}`);
            const gsuidDataDir = path.join(installPath, 'data');
            const configJsonPath = path.join(gsuidDataDir, 'config.json');

            if (!fs.existsSync(gsuidDataDir)) {
                fs.mkdirSync(gsuidDataDir, { recursive: true });
            }

            let configJson = {
                HOST: '0.0.0.0',
                PORT: parseInt(instancePort)
            };

            // If config.json already exists, merge with existing settings
            if (fs.existsSync(configJsonPath)) {
                try {
                    const existingConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
                    configJson = { ...existingConfig, HOST: '0.0.0.0', PORT: parseInt(instancePort) };
                } catch (e) {
                    broadcastGlobalLog(`[WARN] Failed to parse existing config.json, creating new one.`);
                }
            }

            fs.writeFileSync(configJsonPath, JSON.stringify(configJson, null, 2));
            broadcastGlobalLog(`[SYSTEM] GSUID port configured: ${instancePort}`);
        } else if (instanceType === 'nonebot') {
            // NoneBot Steps - Manual creation with pyproject.toml for nb run compatibility
            // Note: nb-cli's --non-interactive mode doesn't work without TTY (NoConsoleScreenBufferError)
            broadcastGlobalLog(`[SYSTEM] Creating NoneBot project...`);

            // 1. Create project directory
            fs.mkdirSync(installPath, { recursive: true });
            broadcastGlobalLog(`[SYSTEM] Created directory: ${installPath}`);

            // 2. Create virtual environment using UV (since embed Python has no venv module)
            broadcastGlobalLog(`[SYSTEM] Creating Python virtual environment...`);
            await runStep('uv', ['venv', '.venv', '--python', getPythonPath()], installPath);

            // 3. Install dependencies using UV (since embed Python has no pip module)
            const packages = ['nonebot2[fastapi]', 'nonebot-adapter-onebot'];
            broadcastGlobalLog(`[SYSTEM] Installing: ${packages.join(', ')}`);
            await runStep('uv', ['pip', 'install', '--python', path.join(installPath, '.venv', 'Scripts', 'python.exe'), ...packages], installPath);

            // 4. Generate pyproject.toml (NEW FORMAT for nb run compatibility)
            const pyprojectContent = `[project]
name = "${instanceName}"
version = "0.1.0"
description = "A NoneBot2 Project"
readme = "README.md"
requires-python = ">=3.9, <4.0"
dependencies = ["nonebot2>=2.4.4", "nonebot-adapter-onebot>=2.4.6"]

[tool.nonebot]
plugin_dirs = ["${instanceName}/plugins"]
builtin_plugins = ["echo"]

[tool.nonebot.plugins]

[tool.nonebot.adapters]
"@local" = []
nonebot-adapter-onebot = [{name = "OneBot V11", module_name = "nonebot.adapters.onebot.v11"}]
`;
            fs.writeFileSync(path.join(installPath, 'pyproject.toml'), pyprojectContent);
            broadcastGlobalLog(`[SYSTEM] Generated pyproject.toml for nb run compatibility`);

            // 5. Generate bot.py
            const botPyContent = `import nonebot
from nonebot.adapters.onebot.v11 import Adapter

nonebot.init()
driver = nonebot.get_driver()
driver.register_adapter(Adapter)

# Load plugins from pyproject.toml
nonebot.load_from_toml("pyproject.toml")

if __name__ == "__main__":
    nonebot.run()
`;
            fs.writeFileSync(path.join(installPath, 'bot.py'), botPyContent);
            broadcastGlobalLog(`[SYSTEM] Generated bot.py`);

            // 6. Create .env configuration
            const envContent = `# NoneBot 配置文件
# 详细配置请参考: https://nonebot.dev/docs/appendices/config

# ===== 基础配置 =====
HOST=0.0.0.0
PORT=${instancePort}
LOG_LEVEL=INFO
DEBUG=false

# ===== 超级用户 (机器人主人的QQ号) =====
# 格式: ["QQ号1", "QQ号2"]
SUPERUSERS=[]

# ===== 机器人昵称 =====
NICKNAME=[]

# ===== 命令配置 =====
COMMAND_START=["/", "#"]
COMMAND_SEP=["."]

# ===== 驱动器 =====
DRIVER=~fastapi

# ===== 插件兼容性配置 =====
LOCALSTORE_USE_CWD=True
`;
            fs.writeFileSync(path.join(installPath, '.env'), envContent);
            broadcastGlobalLog(`[SYSTEM] Created .env with PORT=${instancePort}`);

            // 7. Create plugins directory and README
            const pluginsDir = path.join(installPath, instanceName, 'plugins');
            fs.mkdirSync(pluginsDir, { recursive: true });
            fs.writeFileSync(path.join(installPath, 'README.md'), `# ${instanceName}\n\nA NoneBot2 project created by Gravity Launcher.\n`);

            broadcastGlobalLog(`[SYSTEM] NoneBot project created successfully!`);
        }

        // Register Instance
        const newInstance = {
            id: Date.now().toString(),
            name: instanceName,
            path: installPath,
            port: instancePort,
            redis: { mode: 'shared', port: 6379 },
            created: true,
            type: instanceType
        };

        if (fs.existsSync(DATA_FILE)) {
            currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        } else {
            currentData = { instances: [] };
        }
        currentData.instances.push(newInstance);
        fs.writeFileSync(DATA_FILE, JSON.stringify(currentData, null, 2));

        broadcastGlobalLog(`[SYSTEM] Instance created successfully!`);
        broadcastStatus(newInstance.id, 'stopped');

    } catch (error) {
        broadcastGlobalLog(`[ERR] Creation failed: ${error.message}`);
    }
});

router.post('/delete', async (req, res) => {
    const { id } = req.body;

    let currentData = { instances: [] };
    if (fs.existsSync(DATA_FILE)) {
        currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }

    const instanceIndex = currentData.instances.findIndex(i => i.id === id);
    if (instanceIndex === -1) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    const instance = currentData.instances[instanceIndex];

    try {
        // Remove directory
        if (fs.existsSync(instance.path)) {
            fs.rmSync(instance.path, { recursive: true, force: true });
        }

        // Remove from DB
        currentData.instances.splice(instanceIndex, 1);
        fs.writeFileSync(DATA_FILE, JSON.stringify(currentData, null, 2));

        broadcastGlobalLog(`[SYSTEM] Instance '${instance.name}' deleted.`);
        res.json({ success: true });
    } catch (err) {
        broadcastGlobalLog(`[ERR] Failed to delete instance: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Unbind Instance (remove from DB without deleting files - for imported instances)
router.post('/unbind', async (req, res) => {
    const { id } = req.body;

    let currentData = { instances: [] };
    if (fs.existsSync(DATA_FILE)) {
        currentData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }

    const instanceIndex = currentData.instances.findIndex(i => i.id === id);
    if (instanceIndex === -1) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    const instance = currentData.instances[instanceIndex];

    // Only allow unbinding imported instances
    if (!instance.isImported) {
        return res.status(400).json({ error: 'Only imported instances can be unbound' });
    }

    try {
        // Remove from DB only (don't delete files)
        currentData.instances.splice(instanceIndex, 1);
        fs.writeFileSync(DATA_FILE, JSON.stringify(currentData, null, 2));

        broadcastGlobalLog(`[SYSTEM] Instance '${instance.name}' unbound. Files remain at: ${instance.path}`);
        res.json({ success: true });
    } catch (err) {
        broadcastGlobalLog(`[ERR] Failed to unbind instance: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Open Directory in Explorer
router.post('/opendir', (req, res) => {
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'Path required' });

    // Use PowerShell with Shell.Application to open folder, which handles focus better
    // Use PowerShell with heavy-duty Z-order enforcement
    const psScript = `
        $path = '${dirPath.replace(/'/g, "''")}'
        $leaf = Split-Path $path -Leaf
        
        $code = @"
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
"@
        $win32 = Add-Type -MemberDefinition $code -Name "Win32Utils" -Namespace Win32 -PassThru
        
        # Launch folder
        Start-Process explorer.exe -ArgumentList $path
        
        $wshell = New-Object -ComObject WScript.Shell
        
        # Try to find the window and force it to front
        for ($i=0; $i -lt 10; $i++) {
            Start-Sleep -Milliseconds 200
            
            # Method 1: AppActivate by Title (Leaf folder name)
            if ($wshell.AppActivate($leaf)) { 
                # If AppActivate returns true, it might be enough, but we continue to ensure
            }

            # Method 2: Shell.Application specific path match
            $shell = New-Object -ComObject Shell.Application
            # Case insensitive comparison
            $window = $shell.Windows() | Where-Object { $_.Document.Folder.Self.Path -eq $path } | Select-Object -Last 1
            
            if ($window) {
                $hwnd = $window.HWND
                # 9 = SW_RESTORE, 5 = SW_SHOW, 3 = SW_MAXIMIZE, 1 = SW_NORMAL
                $win32::ShowWindow($hwnd, 9)
                $win32::SetForegroundWindow($hwnd)
                $win32::SwitchToThisWindow($hwnd, $true)
                break
            }
        }
    `;

    const child = spawn('powershell', ['-sta', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript]);

    child.on('error', (err) => {
        console.error('Failed to open directory:', err);
    });

    child.unref();
    res.json({ success: true });
});

// Open Embedded Terminal for Instance
router.post('/terminal/:id', (req, res) => {
    const { id } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    const instancePath = instance.path;
    if (!fs.existsSync(instancePath)) {
        return res.status(400).json({ error: 'Instance directory not found' });
    }

    // If terminal already running, return success
    if (terminalProcesses[id]) {
        return res.json({ success: true, alreadyOpen: true });
    }

    const instanceName = instance.name || 'Instance';

    // Initialize terminal log history
    if (!terminalLogs[id]) terminalLogs[id] = [];

    // Broadcast terminal output helper
    const broadcastTerminalOutput = (output) => {
        terminalLogs[id].push(output);
        if (terminalLogs[id].length > 500) terminalLogs[id].shift();
        // Use wsHelper broadcastGlobalLog with special format
        const { getWss } = require('../utils/wsHelper');
        const wss = getWss();
        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'TERMINAL_OUTPUT',
                        instanceId: id,
                        data: output
                    }));
                }
            });
        }
    };

    // Start cmd.exe (not PowerShell, for simpler path prompt)
    const child = spawn('cmd.exe', [], {
        cwd: instancePath,
        shell: false,
        env: { ...process.env, PROMPT: '$P$G ' }
    });

    terminalProcesses[id] = child;

    // Send welcome message
    broadcastTerminalOutput(`========================================`);
    broadcastTerminalOutput(`  Debug Terminal: ${instanceName}`);
    broadcastTerminalOutput(`  Path: ${instancePath}`);
    broadcastTerminalOutput(`========================================`);
    broadcastTerminalOutput(``);

    // Auto-activate local environment based on instance type
    setTimeout(() => {
        if (instance.type === 'nonebot') {
            // Activate Python venv for NoneBot
            const venvActivate = path.join(instancePath, '.venv', 'Scripts', 'activate.bat');
            if (fs.existsSync(venvActivate)) {
                child.stdin.write(`"${venvActivate}"\n`);
                broadcastTerminalOutput(`[SYSTEM] Activated Python virtual environment (.venv)`);
            }
        } else {
            // For Yunzai/GSUID, add local Node.js to PATH if available
            const localNodeDir = data.localDependencies?.nodejs?.path;
            if (localNodeDir && fs.existsSync(localNodeDir)) {
                child.stdin.write(`set PATH=${localNodeDir};%PATH%\n`);
                broadcastTerminalOutput(`[SYSTEM] Added local Node.js to PATH`);
            }
        }
    }, 300);

    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) broadcastTerminalOutput(line.trimEnd());
        });
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) broadcastTerminalOutput(`[ERR] ${line.trimEnd()}`);
        });
    });

    child.on('close', (code) => {
        broadcastTerminalOutput(`[SYSTEM] Terminal closed (exit code: ${code})`);
        delete terminalProcesses[id];
        // Notify frontend terminal is closed
        const { getWss } = require('../utils/wsHelper');
        const wss = getWss();
        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'TERMINAL_CLOSED',
                        instanceId: id
                    }));
                }
            });
        }
    });

    child.on('error', (err) => {
        console.error('Terminal process error:', err);
        broadcastTerminalOutput(`[ERR] Terminal error: ${err.message}`);
        delete terminalProcesses[id];
    });

    broadcastGlobalLog(`[SYSTEM] Opened embedded terminal for: ${instanceName}`);
    res.json({ success: true });
});

// Send command to embedded terminal
router.post('/terminal/:id/command', (req, res) => {
    const { id } = req.params;
    const { command } = req.body;

    const proc = terminalProcesses[id];
    if (!proc) {
        return res.status(400).json({ error: 'Terminal not open. Click "Open Terminal" first.' });
    }

    try {
        // Echo command to output first
        if (terminalLogs[id]) {
            const { getWss } = require('../utils/wsHelper');
            const wss = getWss();
            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'TERMINAL_OUTPUT',
                            instanceId: id,
                            data: `> ${command}`
                        }));
                    }
                });
            }
        }
        proc.stdin.write(command + '\n');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Close embedded terminal
router.post('/terminal/:id/close', (req, res) => {
    const { id } = req.params;
    const proc = terminalProcesses[id];
    if (proc) {
        proc.kill();
        delete terminalProcesses[id];
    }
    res.json({ success: true });
});

// Select Folder Dialog
// Select Folder Dialog
router.post('/select-folder-action', (req, res) => {
    console.log('[API] Received /select-folder request');
    // Flatten script to single line to avoid spawn argument parsing issues
    // Optimized: Uses TransparencyKey to create an invisible but active TopMost owner window
    const psScript = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $d = New-Object System.Windows.Forms.Form; $d.TopMost = $true; $d.TopLevel = $true; $d.ShowInTaskbar = $false; $d.FormBorderStyle = "None"; $d.BackColor = "Black"; $d.TransparencyKey = "Black"; $d.Size = New-Object System.Drawing.Size(1, 1); $d.StartPosition = "CenterScreen"; $d.Show(); $d.Activate(); $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = "请选择云崽实例文件夹"; $r = $f.ShowDialog($d); $d.Close(); $d.Dispose(); if ($r -eq "OK") { Write-Output $f.SelectedPath }';

    const child = spawn('powershell', ['-sta', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript]);
    let result = '';
    let error = '';

    child.stdout.on('data', (data) => {
        const str = data.toString();
        // console.log('[PS stdout]', str);
        result += str;
    });

    child.stderr.on('data', (data) => {
        const str = data.toString();
        console.error('[PS stderr]', str);
        error += str;
    });

    child.on('close', (code) => {
        console.log('[PS close] code:', code);
        if (code !== 0 && error) {
            console.error('Folder picker failed with code', code, error);
        }
        const selectedPath = result.trim();
        console.log('[API] Selected Path:', selectedPath);
        res.json({ path: selectedPath });
    });

    child.on('error', (err) => {
        console.error('[PS spawn error]', err);
        res.status(500).json({ error: 'Failed to spawn PowerShell' });
    });
});

// Import Instance
router.post('/import', async (req, res) => {
    const { path: importPath, name, port } = req.body;
    const data = loadData();

    if (!fs.existsSync(importPath)) {
        return res.status(400).json({ error: '路径不存在' });
    }
    if (!fs.statSync(importPath).isDirectory()) {
        return res.status(400).json({ error: '路径不是文件夹' });
    }
    const hasPackageJson = fs.existsSync(path.join(importPath, 'package.json'));

    // NoneBot recognition - check bot.py, .env, or pyproject.toml with [tool.nonebot]
    let hasNoneBot = fs.existsSync(path.join(importPath, 'bot.py')) || fs.existsSync(path.join(importPath, '.env'));

    // Also check if pyproject.toml contains NoneBot config
    const pyprojectPath = path.join(importPath, 'pyproject.toml');
    if (!hasNoneBot && fs.existsSync(pyprojectPath)) {
        try {
            const content = fs.readFileSync(pyprojectPath, 'utf8');
            if (content.includes('[tool.nonebot]') || content.includes('nonebot')) {
                hasNoneBot = true;
            }
        } catch (e) {
            // Ignore read errors
        }
    }

    // GSUID has gsuid_core folder (NOT just pyproject.toml, since NoneBot also has it)
    const hasGsuidCore = fs.existsSync(path.join(importPath, 'gsuid_core'));

    if (!hasPackageJson && !hasGsuidCore && !hasNoneBot) {
        return res.status(400).json({ error: '无效实例: 缺少 package.json (Yunzai), gsuid_core (GSUID) 或 bot.py/.env/pyproject.toml (NoneBot)' });
    }

    // Check for duplicate name
    if (data.instances.some(i => i.name === name)) {
        return res.status(400).json({ error: '实例名称已存在' });
    }

    // Check for duplicate path
    // Normalize paths for comparison
    const normImportPath = path.resolve(importPath).toLowerCase();
    if (data.instances.some(i => path.resolve(i.path).toLowerCase() === normImportPath)) {
        return res.status(400).json({ error: '该路径已导入过实例' });
    }

    // Determine instance type - prioritize NoneBot check first since it's more specific
    let instanceType = 'yunzai';
    if (hasNoneBot) instanceType = 'nonebot';
    else if (hasGsuidCore) instanceType = 'gsuid';


    let instancePort = port;

    // Try to read port from GSUID config if importing
    if (instanceType === 'gsuid' && !instancePort) {
        try {
            const configPath = path.join(importPath, 'gsuid_core', 'data', 'config.json');
            // Try different paths structure might vary
            const configPath2 = path.join(importPath, 'data', 'config.json');

            let gsuidConfigPath = null;
            if (fs.existsSync(configPath)) gsuidConfigPath = configPath;
            else if (fs.existsSync(configPath2)) gsuidConfigPath = configPath2;

            if (gsuidConfigPath) {
                const configContent = JSON.parse(fs.readFileSync(gsuidConfigPath, 'utf8'));
                if (configContent.PORT) {
                    instancePort = configContent.PORT.toString();
                }
            }
        } catch (e) {
            console.error('Failed to read GSUID config port:', e);
        }
    } else if (instanceType === 'nonebot' && !instancePort) {
        try {
            const envFiles = ['.env.prod', '.env.dev', '.env'];
            let envContent = '';
            for (const file of envFiles) {
                const envPath = path.join(importPath, file);
                if (fs.existsSync(envPath)) {
                    envContent = fs.readFileSync(envPath, 'utf8');
                    break;
                }
            }
            if (envContent) {
                const portMatch = envContent.match(/^PORT\s*=\s*(\d+)/m);
                if (portMatch) instancePort = portMatch[1];
            }
        } catch (e) {
            console.error('Failed to read NoneBot config port during import:', e);
        }
    }

    const newId = Date.now().toString();
    const newInstance = {
        id: newId,
        name: name,
        path: importPath,
        port: instancePort || (instanceType === 'gsuid' ? '8080' : instanceType === 'nonebot' ? '8080' : '2536'),
        created: Date.now(),
        type: instanceType,
        isImported: true, // Mark as imported
        redis: {
            mode: 'shared', // Default to shared for imported? or independent? Safe to assume shared or let user config.
            port: 6379
        },
        config: {
            masterQQ: ''
        }
    };

    data.instances.push(newInstance);
    saveData(data);

    broadcastStatus(newId, 'stopped');

    // Auto-run pnpm install ONLY for Yunzai
    if (instanceType === 'yunzai') {
        broadcastLog(newId, `[SYSTEM] 正在安装依赖...`);
        try {
            const isWin = process.platform === 'win32';
            const pnpmCmd = isWin ? 'pnpm.cmd' : 'pnpm';

            // Prepare environment with bundled tools
            const binDir = path.resolve(__dirname, '../../bin');
            const env = { ...process.env, CI: 'true' };
            const nodeBin = getNodeBinDir() || 'node';

            if (isWin) {
                let pathKey = 'PATH';
                for (const key in env) {
                    if (key.toUpperCase() === 'PATH') {
                        pathKey = key;
                        break;
                    }
                }
                // Prepend Node.js to PATH
                env[pathKey] = `${nodeBin};${env[pathKey]}`;
            }

            const child = spawn(pnpmCmd, ['install'], {
                cwd: importPath,
                env: env,
                shell: true
            });

            child.stdout.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) broadcastLog(newId, `[PNPM] ${line.trim()}`);
                });
            });

            child.stderr.on('data', (data) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) broadcastLog(newId, `[PNPM] ${line.trim()}`);
                });
            });

            child.on('close', (code) => {
                if (code === 0) {
                    broadcastLog(newId, `[SYSTEM] 依赖安装完成`);
                } else {
                    broadcastLog(newId, `[SYSTEM] 依赖安装失败 (Exit code: ${code})`);
                }
            });
        } catch (err) {
            broadcastLog(newId, `[ERR] 启动安装过程失败: ${err.message}`);
        }
    } else if (instanceType === 'gsuid') {
        broadcastLog(newId, `[SYSTEM] 正在安装 GSUID 依赖... (uv sync)`);

        const isWin = process.platform === 'win32';
        const binDir = path.resolve(__dirname, '../../bin');
        const env = { ...process.env, CI: 'true' };
        // Try to find bundled UV
        const uvBinDir = path.join(binDir, 'uv-x86_64-pc-windows-msvc');

        if (isWin) {
            let pathKey = 'PATH';
            for (const key in env) {
                if (key.toUpperCase() === 'PATH') {
                    pathKey = key;
                    break;
                }
            }
            if (fs.existsSync(uvBinDir)) {
                env[pathKey] = `${uvBinDir};${env[pathKey]}`;
            }
        }

        const child = spawn('uv', ['sync'], {
            cwd: importPath,
            env: env,
            shell: true
        });

        child.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) broadcastLog(newId, `[UV] ${line.trim()}`);
            });
        });

        child.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) broadcastLog(newId, `[UV] ${line.trim()}`);
            });
        });

        child.on('close', (code) => {
            if (code === 0) {
                broadcastLog(newId, `[SYSTEM] uv sync 完成，正在检查 pip...`);

                const child2 = spawn('uv', ['run', 'python', '-m', 'ensurepip'], {
                    cwd: importPath,
                    env: env,
                    shell: true
                });

                child2.stdout.on('data', (data) => {
                    const lines = data.toString().split('\n');
                    lines.forEach(line => { if (line.trim()) broadcastLog(newId, `[PIP] ${line.trim()}`); });
                });
                child2.stderr.on('data', (data) => {
                    const lines = data.toString().split('\n');
                    lines.forEach(line => { if (line.trim()) broadcastLog(newId, `[PIP] ${line.trim()}`); });
                });

                child2.on('close', (c2) => {
                    broadcastLog(newId, `[SYSTEM] GSUID 依赖安装流程结束 (Code: ${c2})`);
                });

            } else {
                broadcastLog(newId, `[SYSTEM] uv sync 失败 (Exit code: ${code})`);
            }
        });
    } else if (instanceType === 'nonebot') {
        const venvPython = path.join(importPath, '.venv', 'Scripts', 'python.exe');
        const reqPath = path.join(importPath, 'requirements.txt');

        if (!fs.existsSync(venvPython)) {
            broadcastLog(newId, `[SYSTEM] 警告：未检测到虚拟环境 (.venv)。`);
            broadcastLog(newId, `[SYSTEM] 请确保已在实例目录下创建虚拟环境，或使用“新建实例”重新配置。`);
        } else {
            broadcastLog(newId, `[SYSTEM] 检测到虚拟环境。`);
            if (fs.existsSync(reqPath)) {
                broadcastLog(newId, `[SYSTEM] 检测到 requirements.txt，正在通过虚拟环境安装/更新依赖...`);

                const child = spawn(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
                    cwd: importPath,
                    shell: true
                });

                child.stdout.on('data', (data) => {
                    const lines = data.toString().split('\n');
                    lines.forEach(line => {
                        if (line.trim()) broadcastLog(newId, `[PIP] ${line.trim()}`);
                    });
                });

                child.stderr.on('data', (data) => {
                    const lines = data.toString().split('\n');
                    lines.forEach(line => {
                        if (line.trim()) broadcastLog(newId, `[PIP] ${line.trim()}`);
                    });
                });

                child.on('close', (code) => {
                    if (code === 0) {
                        broadcastLog(newId, `[SYSTEM] NoneBot 依赖检查完成。`);
                    } else {
                        broadcastLog(newId, `[SYSTEM] NoneBot 依赖安装/更新失败 (Exit code: ${code})。`);
                    }
                });
            } else {
                broadcastLog(newId, `[SYSTEM] NoneBot 实例已导入，环境检查通过。`);
            }
        }
    }

    res.json({ success: true, instance: newInstance });
});

// Rename Instance
router.post('/rename', async (req, res) => {
    const { id, newName } = req.body;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    // Check if running
    if (runningProcesses[id]) return res.status(400).json({ error: 'Cannot rename running instance. Please stop it first.' });

    // Rename directory
    const oldPath = instance.path;
    const parentDir = path.dirname(oldPath);
    const newPath = path.join(parentDir, newName);

    if (fs.existsSync(newPath)) {
        return res.status(400).json({ error: 'Directory already exists' });
    }

    // Retry logic for Windows file handle release
    const maxRetries = 3;
    let lastErr = null;

    for (let i = 0; i < maxRetries; i++) {
        try {
            fs.renameSync(oldPath, newPath);

            // Update DB
            instance.name = newName;
            instance.path = newPath;
            saveData(data);

            broadcastGlobalLog(`[SYSTEM] Instance renamed to ${newName}`);
            return res.json({ success: true, newPath });
        } catch (err) {
            lastErr = err;
            console.log(`Rename attempt ${i + 1} failed:`, err.message);
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // If all retries failed, just update the name in data without renaming directory
    // This allows user to have a display name different from folder name
    instance.name = newName;
    saveData(data);
    res.status(200).json({
        success: true,
        warning: 'Directory rename failed (files may be locked), but display name was updated.',
        error: lastErr?.message
    });
});

// Config Management (Port & MasterQQ)
// Correct paths: config/config/server.yaml for port, config/config/other.yaml for masterQQ
router.get('/config/:id', (req, res) => {
    const { id } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const serverConfigPath = path.join(instance.path, 'config', 'config', 'server.yaml');
    const serverDefaultPath = path.join(instance.path, 'config', 'default_config', 'server.yaml');
    const otherConfigPath = path.join(instance.path, 'config', 'config', 'other.yaml');
    const otherDefaultPath = path.join(instance.path, 'config', 'default_config', 'other.yaml');

    let port = '2536';
    let masterQQ = '';

    try {
        if (instance.type === 'nonebot') {
            // Priority: .env.prod > .env.dev > .env
            const envFiles = ['.env.prod', '.env.dev', '.env'];
            let envContent = '';
            for (const file of envFiles) {
                const envPath = path.join(instance.path, file);
                if (fs.existsSync(envPath)) {
                    envContent = fs.readFileSync(envPath, 'utf8');
                    break;
                }
            }

            if (envContent) {
                // Parse PORT
                const portMatch = envContent.match(/^PORT\s*=\s*(\d+)/m);
                if (portMatch) port = portMatch[1];

                // Parse SUPERUSERS (format: ["123", "456"] or similar)
                const superMatch = envContent.match(/^SUPERUSERS\s*=\s*\[(.*?)\]/m);
                if (superMatch) {
                    const content = superMatch[1];
                    // Extract digits from between quotes
                    const users = content.match(/\d+/g);
                    if (users) masterQQ = users.join(', ');
                }
            }
        } else {
            // Read port from server.yaml (Yunzai)
            const serverPath = fs.existsSync(serverConfigPath) ? serverConfigPath : serverDefaultPath;
            if (fs.existsSync(serverPath)) {
                const serverContent = fs.readFileSync(serverPath, 'utf8');
                const portMatch = serverContent.match(/^port:\s*(\d+)/m);
                if (portMatch) port = portMatch[1];
            }

            // Read masterQQ from other.yaml (Yunzai)
            const otherPath = fs.existsSync(otherConfigPath) ? otherConfigPath : otherDefaultPath;
            if (fs.existsSync(otherPath)) {
                const otherContent = fs.readFileSync(otherPath, 'utf8');
                // masterQQ is a list, find first numeric entry
                const masterMatch = otherContent.match(/masterQQ:\s*\n\s*-\s*"?(\d+)"?/);
                if (masterMatch) masterQQ = masterMatch[1];
            }
        }

        res.json({ port, masterQQ });
    } catch (err) {
        console.error('Failed to read config:', err);
        res.status(500).json({ error: 'Failed to read config' });
    }
});

router.post('/config/:id', async (req, res) => {
    const { id } = req.params;
    const { port, masterQQ } = req.body;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const configDir = path.join(instance.path, 'config', 'config');
    const serverConfigPath = path.join(configDir, 'server.yaml');
    const serverDefaultPath = path.join(instance.path, 'config', 'default_config', 'server.yaml');
    const otherConfigPath = path.join(configDir, 'other.yaml');
    const otherDefaultPath = path.join(instance.path, 'config', 'default_config', 'other.yaml');

    // Handle NoneBot Config
    if (instance.type === 'nonebot') {
        try {
            const envFiles = ['.env.prod', '.env.dev', '.env'];
            let targetEnv = '.env';
            let envContent = '';
            for (const file of envFiles) {
                const envPath = path.join(instance.path, file);
                if (fs.existsSync(envPath)) {
                    targetEnv = file;
                    envContent = fs.readFileSync(envPath, 'utf8');
                    break;
                }
            }

            if (!envContent && fs.existsSync(path.join(instance.path, '.env'))) {
                envContent = fs.readFileSync(path.join(instance.path, '.env'), 'utf8');
            }

            let newContent = envContent || '';

            if (port) {
                if (newContent.match(/^PORT\s*=/m)) {
                    newContent = newContent.replace(/^PORT\s*=\s*\d+/m, `PORT=${port}`);
                } else {
                    newContent += `\nPORT=${port}`;
                }
                instance.port = port;
            }

            if (masterQQ) {
                // Convert "123, 456" to ["123", "456"]
                const users = masterQQ.split(/[,，\s]+/).filter(u => u.trim()).map(u => `"${u.trim()}"`);
                const superLine = `SUPERUSERS=[${users.join(', ')}]`;
                if (newContent.match(/^SUPERUSERS\s*=/m)) {
                    newContent = newContent.replace(/^SUPERUSERS\s*=.*$/m, superLine);
                } else {
                    newContent += `\n${superLine}`;
                }
            }

            fs.writeFileSync(path.join(instance.path, targetEnv), newContent, 'utf8');
            saveData(data);
            return res.json({ success: true, message: 'NoneBot config updated' });
        } catch (err) {
            console.error('Failed to update NoneBot config:', err);
            return res.status(500).json({ error: `Failed to update NoneBot config: ${err.message}` });
        }
    }

    // Handle GSUID Config
    if (instance.type === 'gsuid') {
        if (port) {
            const newPort = String(port);
            // Check conflicts
            const conflictInst = data.instances.find(i => i.id !== id && String(getInstancePort(i)) === newPort);
            if (conflictInst) {
                return res.status(400).json({ error: `Port ${newPort} is used by instance "${conflictInst.name}"` });
            }
            if (!runningProcesses[id]) {
                const isAvailable = await checkPortAvailable(parseInt(newPort));
                if (!isAvailable) {
                    return res.status(400).json({ error: `Port ${newPort} is already in use by the system` });
                }
            }

            try {
                // Try GSUID config paths
                const gsuidConfigPath1 = path.join(instance.path, 'gsuid_core', 'data', 'config.json');
                const gsuidConfigPath2 = path.join(instance.path, 'data', 'config.json');
                let targetConfigPath = null;

                if (fs.existsSync(gsuidConfigPath1)) targetConfigPath = gsuidConfigPath1;
                else targetConfigPath = gsuidConfigPath2; // defaulting to this if neither exists, effectively creating it here

                // Ensure dir exists
                const targetDir = path.dirname(targetConfigPath);
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                let configContent = {};
                if (fs.existsSync(targetConfigPath)) {
                    configContent = JSON.parse(fs.readFileSync(targetConfigPath, 'utf8'));
                }

                configContent.PORT = parseInt(port);
                // Also ensure HOST is set if missing
                if (!configContent.HOST) configContent.HOST = "0.0.0.0";

                fs.writeFileSync(targetConfigPath, JSON.stringify(configContent, null, 4), 'utf8');

                // Update data.json
                instance.port = port;
                saveData(data);

                return res.json({ success: true, message: 'GSUID port updated' });
            } catch (err) {
                console.error('Failed to update GSUID config:', err);
                return res.status(500).json({ error: `Failed to update GSUID config: ${err.message}` });
            }
        }
        return res.json({ success: true }); // Nothing to update
    }

    try {
        // Ensure config/config directory exists
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

        // Update port in server.yaml
        if (port) {
            // Check for conflicts
            const newPort = String(port);
            // Check other instances
            const conflictInst = data.instances.find(i => i.id !== id && String(getInstancePort(i)) === newPort);
            if (conflictInst) {
                return res.status(400).json({ error: `Port ${newPort} is used by instance "${conflictInst.name}"` });
            }

            // Check system port usage (optional: strictly prevent or just warn? User asked to prevent)
            // Note: checking system port might block if the instance ITSELF is running and occupying the port.
            // So we only check system port usage if the instance is STOPPED.
            if (!runningProcesses[id]) {
                const isAvailable = await checkPortAvailable(parseInt(newPort));
                if (!isAvailable) {
                    return res.status(400).json({ error: `Port ${newPort} is already in use by the system` });
                }
            }

            let serverContent = '';
            if (fs.existsSync(serverConfigPath)) {
                serverContent = fs.readFileSync(serverConfigPath, 'utf8');
            } else if (fs.existsSync(serverDefaultPath)) {
                serverContent = fs.readFileSync(serverDefaultPath, 'utf8');
            } else {
                serverContent = `url: http://localhost:${port}\nport: ${port}\n`;
            }

            // Update port and url
            if (serverContent.match(/^\s*port:\s*\d+/m)) {
                serverContent = serverContent.replace(/^\s*port:\s*\d+/m, `port: ${port}`);
            } else {
                serverContent += `\nport: ${port}`;
            }
            if (serverContent.match(/^\s*url:\s*http:\/\/localhost:\d+/m)) {
                serverContent = serverContent.replace(/^\s*url:\s*http:\/\/localhost:\d+/m, `url: http://localhost:${port}`);
            }

            fs.writeFileSync(serverConfigPath, serverContent, 'utf8');
            console.log(`[DEBUG] Wrote port ${port} to ${serverConfigPath}`);
            console.log(`[DEBUG] Content:\n${serverContent}`);

            // Sync port to data.json for Launcher reference
            instance.port = port;
            saveData(data);
        }

        // Update masterQQ in other.yaml
        if (masterQQ) {
            let otherContent = '';
            if (fs.existsSync(otherConfigPath)) {
                otherContent = fs.readFileSync(otherConfigPath, 'utf8');
            } else if (fs.existsSync(otherDefaultPath)) {
                otherContent = fs.readFileSync(otherDefaultPath, 'utf8');
            } else {
                otherContent = `masterQQ:\n  - "${masterQQ}"\n`;
            }

            // Replace first masterQQ entry
            const listRegex = /(masterQQ:\s*\n\s*-\s*)"?(\d+|stdin)"?/;
            if (listRegex.test(otherContent)) {
                otherContent = otherContent.replace(listRegex, `$1"${masterQQ}"`);
            } else if (otherContent.includes('masterQQ:')) {
                // masterQQ exists but empty, add entry
                otherContent = otherContent.replace(/masterQQ:\s*\n/, `masterQQ:\n  - "${masterQQ}"\n`);
            } else {
                otherContent += `\nmasterQQ:\n  - "${masterQQ}"`;
            }

            fs.writeFileSync(otherConfigPath, otherContent, 'utf8');
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Failed to save config:', err);
        res.status(500).json({ error: err.message });
    }
});

// Instance Proxy Management
router.get('/proxy/:id', (req, res) => {
    const { id } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    res.json(instance.proxy || {});
});

router.post('/proxy/:id', (req, res) => {
    const { id } = req.params;
    const proxyConfig = req.body;
    const data = loadData();
    const instance = data.instances.find(i => i.id === id);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    instance.proxy = proxyConfig;
    saveData(data);

    broadcastGlobalLog(`[SYSTEM] Proxy settings updated for instance: ${instance.name}`);
    res.json({ success: true });
});

module.exports = router;
