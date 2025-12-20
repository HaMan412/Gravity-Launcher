const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { downloadFile, extractZip, cancelDownload } = require('../utils/downloader');
const { broadcastGlobalLog } = require('../utils/wsHelper');
const { exec } = require('child_process');

// Constants
const BIN_DIR = path.resolve(__dirname, '../../bin');
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

// Data file for user preferences
const DATA_FILE = path.resolve(__dirname, '../../server/data.json');

// Configuration
const DEPENDENCIES = {
    nodejs: {
        filename: 'node.zip',
        extractDir: 'node-v24.12.0-win-x64',
        binPath: 'node.exe',
        version: '24.12.0',
        globalCmd: 'node --version',
        displayName: 'Node.js'
    },
    git: {
        filename: 'PortableGit.7z.exe',
        extractDir: 'PortableGit',
        binPath: 'cmd/git.exe',
        version: '2.52.0',
        globalCmd: 'git --version',
        displayName: 'Git',
        selfExtract: true
    },
    python: {
        filename: 'python.zip',
        extractDir: 'python-3.12.8-embed-amd64',
        binPath: 'python.exe',
        version: '3.12.8',
        globalCmd: 'python --version',
        displayName: 'Python 3.12'
    },
    uv: {
        filename: 'uv.zip',
        extractDir: 'uv-x86_64-pc-windows-msvc',
        binPath: 'uv.exe',
        version: '0.9.18',
        globalCmd: 'uv --version',
        displayName: 'uv (Package Manager)'
    }
};

const MIRROR_LINES = {
    official: {
        name: '官方源 (Official)',
        urls: {
            nodejs: 'https://nodejs.org/dist/v24.12.0/node-v24.12.0-win-x64.zip',
            git: 'https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/PortableGit-2.52.0-64-bit.7z.exe',
            python: 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip',
            pypi: 'https://pypi.org/simple',
            uv: 'https://gitee.com/hamann/uv-gitee/releases/download/0.9.18/uv-x86_64-pc-windows-msvc.zip'
        }
    },
    china: {
        name: '国内镜像源 (NPMMIRROR)',
        urls: {
            nodejs: 'https://npmmirror.com/mirrors/node/v24.12.0/node-v24.12.0-win-x64.zip',
            git: 'https://npmmirror.com/mirrors/git-for-windows/v2.52.0.windows.1/PortableGit-2.52.0-64-bit.7z.exe',
            python: 'https://npmmirror.com/mirrors/python/3.12.8/python-3.12.8-embed-amd64.zip',
            pypi: 'https://pypi.tuna.tsinghua.edu.cn/simple',
            uv: 'https://gitee.com/hamann/uv-gitee/releases/download/0.9.18/uv-x86_64-pc-windows-msvc.zip'
        }
    },
    ghproxy: {
        name: '镜像加速 (GHPROXY)',
        urls: {
            nodejs: 'https://mirror.ghproxy.com/https://nodejs.org/dist/v24.12.0/node-v24.12.0-win-x64.zip',
            git: 'https://mirror.ghproxy.com/https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/PortableGit-2.52.0-64-bit.7z.exe',
            python: 'https://mirror.ghproxy.com/https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip',
            pypi: 'https://pypi.tuna.tsinghua.edu.cn/simple',
            uv: 'https://gitee.com/hamann/uv-gitee/releases/download/0.9.18/uv-x86_64-pc-windows-msvc.zip'
        }
    },
    fastgit: {
        name: '极速镜像 (FASTGIT)',
        urls: {
            nodejs: 'https://download.fastgit.org/nodejs/node/releases/download/v24.12.0/node-v24.12.0-win-x64.zip',
            git: 'https://download.fastgit.org/git-for-windows/git/releases/download/v2.52.0.windows.1/PortableGit-2.52.0-64-bit.7z.exe',
            python: 'https://npmmirror.com/mirrors/python/3.12.8/python-3.12.8-embed-amd64.zip',
            pypi: 'https://pypi.tuna.tsinghua.edu.cn/simple',
            uv: 'https://gitee.com/hamann/uv-gitee/releases/download/0.9.18/uv-x86_64-pc-windows-msvc.zip'
        }
    }
};

// State to track download progress
let downloadState = {
    nodejs: { status: 'idle', progress: 0 },
    git: { status: 'idle', progress: 0 },
    python: { status: 'idle', progress: 0 },
    uv: { status: 'idle', progress: 0 }
};

// Helper: Check global installation
function checkGlobalInstall(name) {
    return new Promise((resolve) => {
        const config = DEPENDENCIES[name];
        if (!config || !config.globalCmd) {
            return resolve({ installed: false, version: null });
        }

        exec(config.globalCmd, { timeout: 5000 }, (err, stdout) => {
            if (err) {
                return resolve({ installed: false, version: null });
            }
            // Parse version from output
            const versionMatch = stdout.match(/v?(\d+\.\d+\.\d+)/);
            resolve({
                installed: true,
                version: versionMatch ? versionMatch[1] : 'unknown'
            });
        });
    });
}

// Helper: Get best available Python path
function getPythonPath() {
    // 1. Check local portable python (embed version)
    const localPythonEmbed = path.join(BIN_DIR, DEPENDENCIES.python.extractDir, DEPENDENCIES.python.binPath);
    if (fs.existsSync(localPythonEmbed)) return localPythonEmbed;

    // 2. Check NuGet full version (legacy support)
    const nugetPython = path.join(BIN_DIR, 'python-3.12.8', 'tools', 'python.exe');
    if (fs.existsSync(nugetPython)) return nugetPython;

    // 3. Fallback to global python
    return 'python';
}

// Helper: Get best available UV path
function getUvPath() {
    // 1. Check local portable uv
    const localUv = path.join(BIN_DIR, DEPENDENCIES.uv.extractDir, DEPENDENCIES.uv.binPath);
    if (fs.existsSync(localUv)) return localUv;

    // 2. Check global uv
    return 'uv';
}

// Helper: Check if command is available
function isCommandAvailable(cmd) {
    return new Promise((resolve) => {
        // If it's an absolute path, check directly with fs.existsSync
        if (path.isAbsolute(cmd)) {
            resolve(fs.existsSync(cmd));
            return;
        }
        // Otherwise use 'where' to check system PATH
        exec(`where ${cmd}`, (err) => {
            resolve(!err);
        });
    });
}

// Helper: Load/save preferences
function loadData() {
    if (!fs.existsSync(DATA_FILE)) return { dependencies: { useGlobal: {} } };
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.dependencies) data.dependencies = { useGlobal: {} };
    if (!data.dependencies.useGlobal) data.dependencies.useGlobal = {};
    return data;
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Check Status
router.get('/status', async (req, res) => {
    const status = {};
    const data = loadData();
    const useGlobal = data.dependencies?.useGlobal || {};

    // Check downloadable dependencies
    for (const [key, config] of Object.entries(DEPENDENCIES)) {
        const fullExtractDir = path.join(BIN_DIR, config.extractDir);
        // Check exact binary if configured, otherwise check dir
        let checkPath = fullExtractDir;
        if (config.binPath) {
            checkPath = path.join(fullExtractDir, config.binPath);
        }
        const localInstalled = fs.existsSync(checkPath);
        const globalInfo = await checkGlobalInstall(key);

        status[key] = {
            displayName: config.displayName,
            localInstalled,
            localVersion: config.version,
            globalInstalled: globalInfo.installed,
            globalVersion: globalInfo.version,
            useGlobal: useGlobal[key] || false,
            ...downloadState[key]
        };
    }

    // Check Bundled Redis
    const redisPath = path.join(BIN_DIR, 'redis/redis-server.exe');
    status['redis'] = {
        displayName: 'Redis',
        localInstalled: fs.existsSync(redisPath),
        localVersion: 'Bundled',
        globalInstalled: false, // We don't check global for bundled
        useGlobal: false,
        status: 'installed', // Always report installed if file exists
        progress: 100
    };

    res.json({ status });
});

// Get available mirrors
router.get('/mirrors', (req, res) => {
    res.json(MIRROR_LINES);
});

// Set preferred mirror
router.post('/mirror', (req, res) => {
    const { mirror } = req.body;
    if (!MIRROR_LINES[mirror]) return res.status(400).json({ error: 'Invalid mirror' });

    const data = loadData();
    data.dependencies.selectedMirror = mirror;
    saveData(data);

    broadcastGlobalLog(`[SYSTEM] Switched download mirror to: ${MIRROR_LINES[mirror].name}`);
    res.json({ success: true, current: mirror });
});

// Toggle use global
router.post('/useGlobal/:name', (req, res) => {
    const { name } = req.params;
    const { useGlobal } = req.body;

    if (!DEPENDENCIES[name]) return res.status(404).json({ error: 'Unknown dependency' });

    const data = loadData();
    if (!data.dependencies) data.dependencies = {};
    if (!data.dependencies.useGlobal) data.dependencies.useGlobal = {};
    data.dependencies.useGlobal[name] = useGlobal;
    saveData(data);

    broadcastGlobalLog(`[SYSTEM] ${DEPENDENCIES[name].displayName}: ${useGlobal ? 'Using global' : 'Using local'}`);
    res.json({ success: true });
});

// Cancel Download
router.post('/cancel/:name', (req, res) => {
    const { name } = req.params;

    // Try to cancel active download
    cancelDownload(name);

    // Always reset state (even if no active download tracked)
    if (downloadState[name]?.status === 'downloading' || downloadState[name]?.status === 'extracting') {
        downloadState[name] = { status: 'idle', progress: 0 };
        broadcastGlobalLog(`[SYSTEM] Download cancelled: ${name}`);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'No active download to cancel' });
    }
});

// Get/Set Custom URLs
router.get('/customUrls', (req, res) => {
    const data = loadData();
    res.json(data.dependencies?.customUrls || {});
});

router.post('/customUrls', (req, res) => {
    const { urls } = req.body;
    const data = loadData();
    if (!data.dependencies) data.dependencies = {};
    data.dependencies.customUrls = urls;
    saveData(data);
    broadcastGlobalLog('[SYSTEM] Custom download URLs updated');
    res.json({ success: true });
});

// Proxy Settings API
router.get('/proxy', (req, res) => {
    const data = loadData();
    res.json({ proxy: data.settings?.proxy || null });
});

router.post('/proxy', (req, res) => {
    const { proxy } = req.body;
    const data = loadData();
    if (!data.settings) data.settings = {};
    data.settings.proxy = proxy;
    saveData(data);
    broadcastGlobalLog(`[SYSTEM] Proxy settings ${proxy ? 'saved: ' + proxy.protocol + '://' + proxy.host + ':' + proxy.port : 'cleared'}`);
    res.json({ success: true });
});

// Redis running state
let redisProcess = null;
const { spawn } = require('child_process');
const net = require('net');

// Unused isPortInUse removed

// Redis Start
router.post('/redis/start', async (req, res) => {
    // Ensure redis data directory exists
    const redisDataDir = path.resolve(__dirname, '../../data/redis');
    if (!fs.existsSync(redisDataDir)) {
        fs.mkdirSync(redisDataDir, { recursive: true });
    }

    if (redisProcess) {
        return res.json({ success: false, error: 'Redis is already running' });
    }

    // Force kill any existing redis-server processes
    try {
        await new Promise((resolve) => {
            exec('taskkill /F /IM redis-server.exe', () => resolve());
        });
    } catch (e) {
        // Ignore
    }

    const data = loadData();
    const deps = data.dependencies || {};

    // Find Redis path
    let redisPath = null;
    if (deps.redisPath && fs.existsSync(deps.redisPath)) {
        redisPath = deps.redisPath;
    } else {
        // Check local bin
        const localRedis = path.join(BIN_DIR, 'redis', 'redis-server.exe');
        if (fs.existsSync(localRedis)) {
            redisPath = localRedis;
        }
    }

    if (!redisPath) {
        return res.json({ success: false, error: 'Redis not found. Please install Redis first.' });
    }

    try {
        // Start redis with --dir pointing to data/redis
        redisProcess = spawn(redisPath, ['--dir', redisDataDir], {
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        // Use GBK decoder for Windows command output
        const decoder = new TextDecoder('gbk');
        let startFailed = false;

        redisProcess.stdout.on('data', (chunk) => {
            const text = decoder.decode(chunk).trim();
            if (text) broadcastGlobalLog(`[REDIS] ${text}`);
        });

        redisProcess.stderr.on('data', (chunk) => {
            const text = decoder.decode(chunk).trim();
            if (text) broadcastGlobalLog(`[REDIS ERR] ${text}`);
        });

        redisProcess.on('close', (code) => {
            if (code !== 0) {
                startFailed = true;
            }
            redisProcess = null;
            broadcastGlobalLog(`[REDIS] Process exited with code ${code}`);
        });

        // Wait briefly to verify startup
        await new Promise(r => setTimeout(r, 500));

        if (startFailed || !redisProcess) {
            return res.json({ success: false, error: 'Redis 启动失败，请检查日志' });
        }

        broadcastGlobalLog('[SYSTEM] Redis started');
        res.json({ success: true });
    } catch (err) {
        redisProcess = null;
        res.json({ success: false, error: err.message });
    }
});

// Redis Stop
router.post('/redis/stop', (req, res) => {
    if (!redisProcess) {
        return res.json({ success: false, error: 'Redis is not running' });
    }

    try {
        redisProcess.kill();
        redisProcess = null;
        broadcastGlobalLog('[SYSTEM] Redis stopped');
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Redis Status
function checkPort(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(200);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            resolve(false);
        });
        socket.connect(port, '127.0.0.1');
    });
}

router.get('/redis/status', async (req, res) => {
    // Check if process we started is running OR if port is occupied (external start)
    const portActive = await checkPort(6379);
    res.json({ running: (redisProcess !== null) || portActive });
});

// Redis Keep-alive setting
router.post('/redis/keepalive', (req, res) => {
    const { enabled } = req.body;
    const data = loadData();
    if (!data.settings) data.settings = {};
    data.settings.redisKeepAlive = enabled;
    saveData(data);
    broadcastGlobalLog(`[SYSTEM] Redis keep-alive ${enabled ? 'enabled' : 'disabled'}`);
    res.json({ success: true });
});

router.get('/redis/keepalive', (req, res) => {
    const data = loadData();
    res.json({ enabled: data.settings?.redisKeepAlive || false });
});

// Install Dependency
router.post('/install/:name', async (req, res) => {
    const { name } = req.params;
    if (!DEPENDENCIES[name]) return res.status(404).json({ error: 'Unknown dependency' });

    if (downloadState[name].status === 'downloading') {
        return res.status(400).json({ error: 'Already downloading' });
    }

    const config = DEPENDENCIES[name];
    const zipPath = path.join(BIN_DIR, config.filename);

    const data = loadData();

    const customUrl = data.dependencies?.customUrls?.[name];
    const selectedMirror = data.dependencies?.selectedMirror || 'official';

    const mirrorUrl = MIRROR_LINES[selectedMirror]?.urls?.[name];
    const defaultUrl = MIRROR_LINES['official'].urls[name];

    const downloadUrl = customUrl || mirrorUrl || defaultUrl;

    if (!downloadUrl) return res.status(500).json({ error: 'No URL found for dependency' });

    downloadState[name] = { status: 'downloading', progress: 0 };
    res.json({ message: 'Download started' }); // Respond immediately

    broadcastGlobalLog(`Downloading ${name}...`);
    broadcastGlobalLog(`Source: ${customUrl ? 'Custom' : MIRROR_LINES[selectedMirror]?.name || selectedMirror}`);
    broadcastGlobalLog(`URL: ${downloadUrl}`);

    try {
        // Pass name as downloadId for cancel support
        await downloadFile(downloadUrl, zipPath, (progress) => {
            downloadState[name].progress = progress;
            if (Math.floor(progress) % 20 === 0 && Math.floor(progress) > 0 && Math.floor(progress) < 100) {
                broadcastGlobalLog(`> Downloading ${name}: ${Math.floor(progress)}%`);
            }
        }, name);  // <-- name as downloadId for cancel

        broadcastGlobalLog(`Download complete (100%).`);
        broadcastGlobalLog(`Extracting ${name}...`);

        downloadState[name].status = 'extracting';

        let targetExtractDir = BIN_DIR;
        if (name === 'redis') {
            targetExtractDir = path.join(BIN_DIR, 'redis');
        } else if (config.extractDir) {
            targetExtractDir = path.join(BIN_DIR, config.extractDir);
        }

        // Handle self-extracting exe (like PortableGit)
        if (config.selfExtract) {
            const { exec } = require('child_process');
            broadcastGlobalLog(`Running self-extractor...`);

            await new Promise((resolve, reject) => {
                // PortableGit uses -y for silent, -gm2 for minimal UI, -o for output dir
                const cmd = `"${zipPath}" -y -gm2 -o"${targetExtractDir}"`;
                exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('Self-extract error:', err);
                        reject(err);
                    } else {
                        resolve(stdout);
                    }
                });
            });
        } else {
            // Regular zip extraction
            const extracted = await extractZip(zipPath, targetExtractDir);
            if (!extracted) {
                throw new Error('Extraction failed. Check server console.');
            }

            // Post-extract: check if we have a double-nested directory (e.g., node-vXX/node-vXX/node.exe)
            // This happens when the zip contains a root folder and we also extract to a subfolder
            const nestedDir = path.join(targetExtractDir, config.extractDir);
            if (fs.existsSync(nestedDir) && fs.lstatSync(nestedDir).isDirectory()) {
                console.log(`[SYSTEM] Flattening nested directory for ${name}...`);
                const items = fs.readdirSync(nestedDir);
                for (const item of items) {
                    const oldPath = path.join(nestedDir, item);
                    const newPath = path.join(targetExtractDir, item);
                    // Move if not already exists (though readdirSync items shouldn't exist in parent normally)
                    if (!fs.existsSync(newPath)) {
                        fs.renameSync(oldPath, newPath);
                    }
                }
                // Cleanup the now-empty nested dir
                try {
                    fs.rmdirSync(nestedDir);
                } catch (e) {
                    console.error('[SYSTEM] Failed to remove empty nested dir:', e);
                }
            }
        }

        fs.unlinkSync(zipPath); // Cleanup

        downloadState[name] = { status: 'installed', progress: 100 };

        console.log(`${name} installed successfully.`);
        broadcastGlobalLog(`${name} Installed Successfully!`);
        broadcastGlobalLog(`Path: ${targetExtractDir}`);

        // Special handling for Python: install pip if not present
        if (name === 'python') {
            const pythonExe = path.join(targetExtractDir, config.binPath);
            const pipExe = path.join(targetExtractDir, 'Scripts', 'pip.exe');

            if (!fs.existsSync(pipExe)) {
                broadcastGlobalLog('[SYSTEM] Setting up pip for Python...');

                try {
                    // Step 1: Modify the ._pth file to enable site-packages
                    const pthFiles = fs.readdirSync(targetExtractDir).filter(f => f.endsWith('._pth'));
                    for (const pthFile of pthFiles) {
                        const pthPath = path.join(targetExtractDir, pthFile);
                        let content = fs.readFileSync(pthPath, 'utf8');
                        // Uncomment 'import site' line
                        if (content.includes('#import site')) {
                            content = content.replace('#import site', 'import site');
                            fs.writeFileSync(pthPath, content);
                            broadcastGlobalLog('[SYSTEM] Enabled site-packages in Python.');
                        }
                    }

                    // Step 2: Download and run get-pip.py
                    // Try multiple sources for better availability
                    const getPipSources = [
                        'https://gitee.com/hamann/get-pip.py/raw/master/get-pip.py',
                        'https://bootstrap.pypa.io/get-pip.py'
                    ];
                    const getPipPath = path.join(targetExtractDir, 'get-pip.py');

                    broadcastGlobalLog('[SYSTEM] Downloading get-pip.py...');
                    let downloaded = false;
                    for (const getPipUrl of getPipSources) {
                        try {
                            broadcastGlobalLog(`[SYSTEM] Trying: ${getPipUrl}`);
                            await downloadFile(getPipUrl, getPipPath, () => { });
                            downloaded = true;
                            break;
                        } catch (e) {
                            broadcastGlobalLog(`[WARN] Failed from ${getPipUrl}, trying next...`);
                        }
                    }
                    if (!downloaded) {
                        throw new Error('Failed to download get-pip.py from all sources');
                    }

                    broadcastGlobalLog('[SYSTEM] Installing pip (using China mirror)...');
                    await new Promise((resolve, reject) => {
                        const { spawn } = require('child_process');
                        // Use China mirror for faster download
                        const child = spawn(`"${pythonExe}"`, [getPipPath, '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], {
                            shell: true,
                            cwd: targetExtractDir,
                            env: { ...process.env, PYTHONUTF8: '1' }
                        });

                        child.stdout.on('data', (data) => {
                            const text = data.toString().trim();
                            if (text) broadcastGlobalLog(`[PIP] ${text}`);
                        });

                        child.stderr.on('data', (data) => {
                            const text = data.toString().trim();
                            if (text) broadcastGlobalLog(`[PIP] ${text}`);
                        });

                        child.on('close', (code) => {
                            if (code === 0) {
                                resolve();
                            } else {
                                reject(new Error(`get-pip.py exited with code ${code}`));
                            }
                        });

                        child.on('error', reject);
                    });

                    // Cleanup
                    if (fs.existsSync(getPipPath)) {
                        fs.unlinkSync(getPipPath);
                    }

                    broadcastGlobalLog('[SYSTEM] pip installed successfully!');
                } catch (pipErr) {
                    console.error('Failed to install pip:', pipErr);
                    broadcastGlobalLog(`[WARN] Failed to install pip: ${pipErr.message}`);
                    broadcastGlobalLog('[WARN] You may need to install pip manually.');
                }
            }
        }

    } catch (err) {
        console.error(`Error installing ${name}:`, err);
        downloadState[name] = { status: 'error', progress: 0, error: err.message };
        broadcastGlobalLog(`Error installing ${name}: ${err.message}`);
    }
});

// Uninstall Dependency
router.post('/uninstall/:name', (req, res) => {
    const { name } = req.params;
    if (!DEPENDENCIES[name]) return res.status(404).json({ error: 'Unknown dependency' });

    const config = DEPENDENCIES[name];
    let targetDir = BIN_DIR;
    // Simple logic: if extracting to a subfolder, delete that. 
    // If we just dropped exe in BIN_DIR (like potentially others), we delete the specific file.

    // Based on install logic:
    // Redis -> BIN_DIR/redis
    // Node -> BIN_DIR/node-v...

    // We can use the 'extractDir' from config to know what to delete
    if (config.extractDir) {
        const dirToDelete = path.join(BIN_DIR, config.extractDir);
        if (fs.existsSync(dirToDelete)) {
            try {
                fs.rmSync(dirToDelete, { recursive: true, force: true });
                // Also reset state
                downloadState[name] = { status: 'idle', progress: 0 };
                res.json({ message: 'Uninstalled' });
            } catch (err) {
                res.status(500).json({ error: `Failed to remove: ${err.message}` });
            }
        } else {
            res.status(400).json({ error: 'Not installed or path not found' });
        }
    } else {
        res.status(500).json({ error: 'Cannot determine uninstall path' });
    }
});

// ============ nb-cli (NoneBot CLI) APIs ============

// Check nb-cli status
router.get('/nbcli/status', async (req, res) => {
    try {
        const uvPath = getUvPath();
        const hasUv = await isCommandAvailable(uvPath);

        // 1. Try global nb command first
        let result = await new Promise((resolve) => {
            exec('nb --version', { timeout: 5000 }, (err, stdout) => {
                if (err) {
                    return resolve({ installed: false, version: null });
                }
                const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
                resolve({
                    installed: true,
                    version: versionMatch ? versionMatch[1] : 'unknown'
                });
            });
        });

        // 2. If global failed but uv exists, check uv tools
        if (!result.installed && hasUv) {
            result = await new Promise((resolve) => {
                exec(`"${uvPath}" tool list`, { timeout: 5000 }, (err, stdout) => {
                    if (!err && stdout.includes('nb-cli')) {
                        // Extract version if possible, e.g. "nb-cli v1.5.0"
                        const versionMatch = stdout.match(/nb-cli\s+v?(\d+\.\d+\.\d+)/);
                        resolve({
                            installed: true,
                            version: versionMatch ? versionMatch[1] : 'unknown (uv)'
                        });
                    } else {
                        resolve({ installed: false, version: null });
                    }
                });
            });
        }

        res.json(result);
    } catch (err) {
        res.json({ installed: false, version: null, error: err.message });
    }
});

// Install nb-cli via UV or pipx
router.post('/nbcli/install', async (req, res) => {
    res.json({ message: 'nb-cli installation started' });

    const pythonPath = getPythonPath();
    const uvPath = getUvPath();
    const hasUv = await isCommandAvailable(uvPath);

    try {
        if (hasUv) {
            broadcastGlobalLog('[SYSTEM] Detected UV, installing nb-cli via uv tool...');
            await new Promise((resolve, reject) => {
                const child = spawn(`"${uvPath}"`, ['tool', 'install', 'nb-cli'], {
                    shell: true,
                    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
                });

                child.stdout.on('data', (data) => {
                    const text = data.toString().trim();
                    if (text) broadcastGlobalLog(`[UV] ${text}`);
                });

                child.stderr.on('data', (data) => {
                    const text = data.toString().trim();
                    if (text) broadcastGlobalLog(`[UV] ${text}`);
                });

                child.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`uv tool install exited with code ${code}`));
                    }
                });

                child.on('error', reject);
            });
        } else {
            broadcastGlobalLog('[SYSTEM] UV not found. Using pipx installation...');
            broadcastGlobalLog(`[SYSTEM] Using Python: ${pythonPath}`);

            // Step 1: Ensure pipx is installed
            broadcastGlobalLog('[SYSTEM] Step 1: Ensuring pipx is installed...');
            await new Promise((resolve, reject) => {
                exec(`"${pythonPath}" -m pip install pipx`, { timeout: 120000 }, (err, stdout, stderr) => {
                    if (err) {
                        broadcastGlobalLog(`[WARN] pipx install warning: ${stderr || err.message}`);
                    }
                    resolve();
                });
            });

            broadcastGlobalLog('[SYSTEM] Step 2: Installing nb-cli via pipx...');

            // Step 2: Install nb-cli
            await new Promise((resolve, reject) => {
                const child = spawn(`"${pythonPath}"`, ['-m', 'pipx', 'install', 'nb-cli'], {
                    shell: true,
                    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
                });

                child.stdout.on('data', (data) => {
                    const text = data.toString().trim();
                    if (text) broadcastGlobalLog(`[NB-CLI] ${text}`);
                });

                child.stderr.on('data', (data) => {
                    const text = data.toString().trim();
                    if (text) broadcastGlobalLog(`[NB-CLI] ${text}`);
                });

                child.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`pipx install nb-cli exited with code ${code}`));
                    }
                });

                child.on('error', reject);
            });
        }

        broadcastGlobalLog('[SYSTEM] nb-cli installed successfully!');
        broadcastGlobalLog('[SYSTEM] You may need to restart your terminal/launcher for the "nb" command to be available.');

    } catch (err) {
        broadcastGlobalLog(`[ERR] nb-cli installation failed: ${err.message}`);
    }
});

// Uninstall nb-cli via UV or pipx
router.post('/nbcli/uninstall', async (req, res) => {
    res.json({ message: 'nb-cli uninstallation started' });

    const pythonPath = getPythonPath();
    const uvPath = getUvPath();
    const hasUv = await isCommandAvailable(uvPath);

    try {
        if (hasUv) {
            broadcastGlobalLog('[SYSTEM] Uninstalling nb-cli via uv tool...');
            await new Promise((resolve, reject) => {
                exec(`"${uvPath}" tool uninstall nb-cli`, { timeout: 60000 }, (err, stdout, stderr) => {
                    if (err) broadcastGlobalLog(`[WARN] uv uninstall warning: ${stderr || err.message}`);
                    resolve(stdout);
                });
            });
        } else {
            broadcastGlobalLog('[SYSTEM] Uninstalling nb-cli via pipx...');
            await new Promise((resolve, reject) => {
                // Try running pipx through the resolved python
                exec(`"${pythonPath}" -m pipx uninstall nb-cli`, { timeout: 60000 }, (err, stdout, stderr) => {
                    if (err) {
                        broadcastGlobalLog(`[WARN] pipx uninstall error: ${stderr || err.message}`);
                        // Try fallback to global pipx
                        exec('pipx uninstall nb-cli', (err2) => {
                            resolve();
                        });
                    } else {
                        resolve(stdout);
                    }
                });
            });
        }

        broadcastGlobalLog('[SYSTEM] nb-cli uninstalled successfully!');
        res.json({ success: true });

    } catch (err) {
        broadcastGlobalLog(`[ERR] nb-cli uninstallation failed: ${err.message}`);
    }
});

module.exports = router;
