const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { broadcastGlobalLog } = require('../utils/wsHelper');

// Constants
const DATA_FILE = path.resolve(__dirname, '../../server/data.json');
const PUBLIC_DIR = path.resolve(__dirname, '../../server/public');

// Ensure public directory exists
if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// Helper: Load/save data
function loadData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Get Settings
router.get('/', (req, res) => {
    const data = loadData();
    res.json(data.settings || {});
});

// Upload Background Image
// Expects: { image: "base64 string..." }
router.post('/background', (req, res) => {
    try {
        const { image, originalName } = req.body;
        if (!image) return res.status(400).json({ error: 'No image provided' });

        // Remove header if present (e.g., "data:image/png;base64,")
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        const fileName = 'background.png';
        const filePath = path.join(PUBLIC_DIR, fileName);

        fs.writeFileSync(filePath, buffer);

        // Update settings in data.json
        const data = loadData();
        if (!data.settings) data.settings = {};

        // Add timestamp to prevent caching
        // Add timestamp to prevent caching
        const publicUrl = `/${fileName}?t=${Date.now()}`;
        data.settings.backgroundImage = publicUrl;

        // If originalName contains a path (Electron/local), use it. 
        // Otherwise, use the server's local path where it was saved.
        let displayPath = originalName || '';
        if (!displayPath || (!displayPath.includes('\\') && !displayPath.includes('/'))) {
            displayPath = path.resolve(filePath);
        }

        data.settings.backgroundImagePath = displayPath;

        saveData(data);
        broadcastGlobalLog('[SYSTEM] Background image updated');

        res.json({ success: true, url: publicUrl, path: data.settings.backgroundImagePath });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save image' });
    }
});

// Update Opacity
router.post('/opacity', (req, res) => {
    const { opacity } = req.body;
    const data = loadData();
    if (!data.settings) data.settings = {};

    data.settings.backgroundOpacity = opacity;
    saveData(data);
    res.json({ success: true });
});

module.exports = router;
