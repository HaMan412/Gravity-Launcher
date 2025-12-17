const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const { init: initWs } = require('./utils/wsHelper');

// Initialize WebSocket
initWs(server);

const PORT = 3575;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for image uploads
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files (background images)

const dependencyRoutes = require('./routes/dependencies');
const instanceRoutes = require('./routes/instances');

app.use('/api/dependencies', dependencyRoutes);
app.use('/api/instances', instanceRoutes);
app.use('/api/settings', require('./routes/settings'));
app.use('/api/plugins', require('./routes/plugins'));

// Serve React Frontend
const clientBuildPath = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));
    app.get(/.*/, (req, res) => {
        res.sendFile(path.join(clientBuildPath, 'index.html'));
    });
} else {
    app.get('/', (req, res) => {
        res.send('Yunzai Launcher API is Running. (Frontend build not found)');
    });
}

// Database / Configuration File
const DATA_FILE = path.join(__dirname, 'data.json');
if (!fs.existsSync(DATA_FILE)) {
    const initialData = {
        dependencies: {
            nodePath: null,
            redisPath: null,
            nodeVersion: null,
            redisVersion: null
        },
        instances: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
}

// Start Server
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// Global Error Handlers - Prevent server crashes
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message);
    console.error(err.stack);
    // Don't exit - keep server alive
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Promise Rejection:', reason);
    // Don't exit - keep server alive
});
