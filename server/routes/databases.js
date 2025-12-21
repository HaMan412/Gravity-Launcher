const express = require('express');
const router = express.Router();
const Redis = require('ioredis');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Global connections (Simple single-user mode)
let redisClient = null;
let sqliteDb = null;
let currentSqlitePath = null;

// ==========================================
// Redis Routes
// ==========================================

// Get Redis Status
router.get('/redis/status', async (req, res) => {
    try {
        if (!redisClient) {
            // Try explicit connection or default
            redisClient = new Redis({
                host: '127.0.0.1',
                port: 6379,
                lazyConnect: true,
                retryStrategy: (times) => {
                    // Don't retry too aggressively for status checks
                    if (times > 3) return null;
                    return Math.min(times * 50, 2000);
                }
            });
            // Prevent unhandled error events
            redisClient.on('error', (err) => {
                // Silently handle error, client will check status
            });
        }

        await redisClient.connect().catch(() => { }); // Ensure connected

        if (redisClient.status === 'ready') {
            const info = await redisClient.info();
            res.json({ status: 'connected', info });
        } else {
            res.json({ status: 'disconnected', error: 'Redis not ready' });
        }
    } catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});

// Scan Keys
router.get('/redis/keys', async (req, res) => {
    if (!redisClient || redisClient.status !== 'ready') {
        return res.status(400).json({ error: 'Redis not connected' });
    }
    const { pattern = '*', cursor = '0', count = 100 } = req.query;
    try {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', count);
        res.json({ cursor: nextCursor, keys });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Key Value
router.get('/redis/value', async (req, res) => {
    if (!redisClient || redisClient.status !== 'ready') {
        return res.status(400).json({ error: 'Redis not connected' });
    }
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'Key required' });

    try {
        const type = await redisClient.type(key);
        let value = null;
        let ttl = await redisClient.ttl(key);

        switch (type) {
            case 'string':
                value = await redisClient.get(key);
                break;
            case 'hash':
                value = await redisClient.hgetall(key);
                break;
            case 'list':
                value = await redisClient.lrange(key, 0, -1);
                break;
            case 'set':
                value = await redisClient.smembers(key);
                break;
            case 'zset':
                value = await redisClient.zrange(key, 0, -1, 'WITHSCORES');
                break;
            default:
                value = 'Unsupported type or key does not exist';
        }
        res.json({ key, type, ttl, value });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Execute Command (CLI)
router.post('/redis/command', async (req, res) => {
    if (!redisClient || redisClient.status !== 'ready') {
        return res.status(400).json({ error: 'Redis not connected' });
    }
    const { command } = req.body; // Expect array e.g. ['get', 'foo'] or string

    if (!command) return res.status(400).json({ error: 'Command required' });

    try {
        let args = command;
        if (typeof command === 'string') {
            // Naive split, better to use frontend parsing
            args = command.trim().split(/\s+/);
        }

        const cmd = args[0];
        const cmdArgs = args.slice(1);

        const result = await redisClient.call(cmd, ...cmdArgs);
        res.json({ result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// SQLite Routes
// ==========================================

// Connect/Open DB
router.post('/sqlite/connect', (req, res) => {
    const { path: dbPath } = req.body;
    if (!dbPath) return res.status(400).json({ error: 'Path required' });

    try {
        if (sqliteDb) {
            sqliteDb.close();
        }

        if (!fs.existsSync(dbPath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        sqliteDb = new Database(dbPath, { readonly: false }); // Or true if safety needed
        currentSqlitePath = dbPath;
        res.json({ success: true, path: dbPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Tables
router.get('/sqlite/tables', (req, res) => {
    if (!sqliteDb || !sqliteDb.open) {
        return res.status(400).json({ error: 'Database not connected' });
    }
    try {
        const stmt = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        const tables = stmt.all();
        res.json({ tables: tables.map(t => t.name) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Execute Query
router.post('/sqlite/query', (req, res) => {
    if (!sqliteDb || !sqliteDb.open) {
        return res.status(400).json({ error: 'Database not connected' });
    }
    const { sql, params = [] } = req.body;
    if (!sql) return res.status(400).json({ error: 'SQL required' });

    try {
        const isSelect = /^\s*SELECT/i.test(sql) || /^\s*PRAGMA/i.test(sql);

        if (isSelect) {
            const stmt = sqliteDb.prepare(sql);
            const rows = stmt.all(...params);
            res.json({ type: 'query', rows });
        } else {
            const stmt = sqliteDb.prepare(sql);
            const info = stmt.run(...params);
            res.json({ type: 'run', info });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Close DB
router.post('/sqlite/close', (req, res) => {
    if (sqliteDb) {
        try {
            sqliteDb.close();
        } catch (e) { }
        sqliteDb = null;
        currentSqlitePath = null;
    }
    res.json({ success: true });
});

// Helpers for scanning
const DATA_FILE = path.resolve(__dirname, '../../server/data.json');

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return { instances: [] };
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return { instances: [] };
    }
}

function scanDbFiles(dir, fileList = [], depth = 0) {
    if (depth > 5) return fileList; // Limit depth
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filePath = path.join(dir, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    if (['node_modules', '.git', '.venv', '__pycache__'].includes(file)) return;
                    scanDbFiles(filePath, fileList, depth + 1);
                } else {
                    if (/\.(db|sqlite|sqlite3)$/i.test(file)) {
                        fileList.push(filePath);
                    }
                }
            } catch (e) { }
        });
    } catch (e) { }
    return fileList;
}

// Scan Instance for DBs
router.post('/sqlite/scan', (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Instance ID required' });

    const data = loadData();
    const instance = data.instances?.find(i => i.id === instanceId);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });
    if (!instance.path || !fs.existsSync(instance.path)) {
        return res.status(404).json({ error: 'Instance path not found' });
    }

    const dbFiles = scanDbFiles(instance.path);
    // map to relative path for cleaner display if needed, but absolute is fine for connection
    res.json({ success: true, files: dbFiles, filesRelative: dbFiles.map(f => path.relative(instance.path, f)) });
});

module.exports = router;
