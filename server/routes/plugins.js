const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const { broadcastLog } = require('../utils/wsHelper');

const DATA_FILE = path.resolve(__dirname, '../../server/data.json');

// Memory Cache for Plugin Store
let storeCache = {
    data: [],
    timestamp: 0
};
const CACHE_TTL = 3600 * 1000; // 1 Hour

// Helper to load data
function loadData() {
    if (!fs.existsSync(DATA_FILE)) return { instances: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Helper: Strip ANSI (for logs)
const stripAnsi = (str) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

// Helper: Parse Markdown Table
function parseMarkdownTable(markdown) {
    const plugins = [];
    const lines = markdown.split('\n');

    for (const line of lines) {
        if (!line.trim() || line.includes('---')) continue;

        // Remove leading/trailing pipes and split by pipe
        const columns = line.trim().replace(/^\||\|$/g, '').split('|');

        if (columns.length >= 3) {
            try {
                const nameCol = columns[0].trim();
                const authorCol = columns[1].trim();
                const descCol = columns[2].trim();

                // Skip Header
                if (nameCol.includes('名称') || nameCol.includes('---')) continue;

                // Extract Name and Link
                const linkMatch = nameCol.match(/\[(.*?)\]\((.*?)\)/);
                const authorMatch = authorCol.match(/\[(.*?)\]\((.*?)\)/);

                if (linkMatch) {
                    plugins.push({
                        name: linkMatch[1],
                        link: linkMatch[2],
                        author: authorMatch ? authorMatch[1] : authorCol,
                        authorLink: authorMatch ? authorMatch[2] : '',
                        description: descCol.replace(/<br>/g, ' ')
                    });
                }
            } catch (e) {
                // Ignore parsing errors for single lines
            }
        }
    }
    return plugins;
}

// 1. Get Store Plugins (Fetch from GitHub)
// Mirrors for stability in CN
const MIRRORS = [
    'https://cdn.jsdelivr.net/gh/yhArcadia/Yunzai-Bot-plugins-index@main',
    'https://fastly.jsdelivr.net/gh/yhArcadia/Yunzai-Bot-plugins-index@main',
    'https://gcore.jsdelivr.net/gh/yhArcadia/Yunzai-Bot-plugins-index@main',
    'https://mirror.ghproxy.com/https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main'
];

// Git Clone Proxies for Download
const GIT_PROXIES = [
    { name: '直连 (Direct)', url: '' },
    { name: 'Gh-Proxy (Com)', url: 'https://gh-proxy.com/' },
    { name: 'GhFast (Top)', url: 'https://ghfast.top/' },
    { name: 'Ghp.ci', url: 'https://ghp.ci/' },
    { name: 'Moeyy', url: 'https://github.moeyy.xyz/' },
    { name: 'GhProxy (Official)', url: 'https://mirror.ghproxy.com/' }
];

router.get('/store', async (req, res) => {
    // Force Refresh logic or specific mirror
    const { force, mirror } = req.query;

    // Check Cache (skip if force or mirror is specified)
    if (!force && !mirror && Date.now() - storeCache.timestamp < CACHE_TTL && storeCache.data.length > 0) {
        return res.json(storeCache.data);
    }

    try {
        // Use selected mirror if provided, otherwise try all
        const currentMirrors = mirror ? [mirror] : MIRRORS;

        const files = [
            'Function-Plugin.md',
            'JS-Plugin.md',
            'Game-Plugin.md',
            'WordGame-Plugin.md'
        ];

        let allPlugins = [];

        const categoryMap = {
            'Function-Plugin.md': '功能类插件',
            'JS-Plugin.md': '单JS类插件',
            'Game-Plugin.md': '游戏IP类插件',
            'WordGame-Plugin.md': '文游类插件'
        };

        for (const file of files) {
            let fileSuccess = false;
            for (const baseUrl of currentMirrors) {
                try {
                    const url = `${baseUrl}/${file}`;
                    // Set timeout to avoid hanging on bad mirrors
                    const response = await axios.get(url, { timeout: 5000 });
                    const plugins = parseMarkdownTable(response.data);

                    // Add category tag based on filename
                    const category = categoryMap[file] || '其他';
                    plugins.forEach(p => p.category = category);

                    allPlugins = [...allPlugins, ...plugins];
                    fileSuccess = true;
                    console.log(`Fetched ${file} from ${baseUrl}`);
                    break; // Success, move to next file
                } catch (err) {
                    console.warn(`Failed to fetch ${file} from ${baseUrl}: ${err.message}`);
                    continue; // Try next mirror
                }
            }
            if (!fileSuccess) {
                console.error(`All mirrors failed for ${file}`);
            }
        }

        // update cache only if using default mirrors
        if (!mirror) {
            storeCache.data = allPlugins;
            storeCache.timestamp = Date.now();
        }

        res.json(allPlugins);

    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch plugin store' });
    }
});

// Provide list of mirrors
router.get('/mirrors', (req, res) => {
    res.json(MIRRORS);
});

// Check Source Latency
router.post('/check-source', async (req, res) => {
    const { mirror } = req.body;
    if (!mirror) return res.status(400).json({ error: 'Mirror required' });

    const start = Date.now();
    try {
        // Fetch a small file to test
        const url = `${mirror}/Function-Plugin.md`;
        await axios.get(url, { timeout: 5000 });
        const latency = Date.now() - start;
        res.json({ success: true, latency });
    } catch (e) {
        res.json({ success: false, error: e.message, latency: -1 });
    }
});

// Check Git Source Latency
router.post('/check-git-source', async (req, res) => {
    const { mirror } = req.body;
    // mirror is '' for direct
    // mirror is 'https://...' for proxy

    const start = Date.now();
    try {
        const target = 'https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main/README.md';
        const url = mirror ? `${mirror}${target}` : target;

        await axios.get(url, { timeout: 8000 });
        const latency = Date.now() - start;
        res.json({ success: true, latency });
    } catch (e) {
        res.json({ success: false, error: e.message, latency: -1 });
    }
});

// Get Git Proxies
router.get('/git-mirrors', (req, res) => {
    res.json(GIT_PROXIES);
});

// Set Download Mirror
router.post('/download-mirror', (req, res) => {
    const { mirror } = req.body;
    const data = loadData();
    if (!data.settings) data.settings = {};
    data.settings.pluginDownloadMirror = mirror;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

// Get Download Mirror
router.get('/download-mirror', (req, res) => {
    const data = loadData();
    res.json({ mirror: data.settings?.pluginDownloadMirror || '' });
});

// --- Startup Cleanup ---
const cleanupTempDirs = () => {
    try {
        const instancesDir = path.join(__dirname, '../instances');
        if (fs.existsSync(instancesDir)) {
            const instances = fs.readdirSync(instancesDir);
            instances.forEach(instance => {
                const instancePath = path.join(instancesDir, instance);
                if (fs.statSync(instancePath).isDirectory()) {
                    const files = fs.readdirSync(instancePath);
                    files.forEach(file => {
                        if (file.startsWith('temp_install_')) {
                            const tempPath = path.join(instancePath, file);
                            try {
                                console.log(`[PluginManager] Cleaning up old temp dir: ${tempPath}`);
                                fs.rmSync(tempPath, { recursive: true, force: true });
                            } catch (e) {
                                console.error(`[PluginManager] Failed to cleanup ${tempPath}:`, e.message);
                            }
                        }
                    });
                }
            });
        }
    } catch (e) {
        console.error('[PluginManager] Cleanup failed:', e);
    }
};
cleanupTempDirs();

// 2. Get Installed Plugins
router.get('/installed/:instanceId', (req, res) => {
    const { instanceId } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === instanceId);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    const pluginsDir = path.join(instance.path, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
        return res.json([]);
    }

    const plugins = [];

    try {
        const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                // Logic:
                // 1. 'example': Recursively show valid JS files.
                // 2. 'system', 'adapter', 'other': HIDE completely.
                // 3. All other folders: Show as normal plugins.

                if (entry.name === 'example') {
                    // Dive into example
                    const subDirPath = path.join(pluginsDir, entry.name);
                    try {
                        const subEntries = fs.readdirSync(subDirPath, { withFileTypes: true });
                        for (const sub of subEntries) {
                            if (sub.isFile() && sub.name.endsWith('.js')) {
                                plugins.push({
                                    name: sub.name,
                                    description: `Example Script`,
                                    category: 'example',
                                    isSingleFile: true,
                                    parentDir: 'example',
                                    protect: false
                                });
                            }
                        }
                    } catch (e) { }
                } else if (['system', 'adapter', 'other'].includes(entry.name)) {
                    // Skip system directories
                    continue;
                } else {
                    // Regular Plugin Folder
                    const pluginPath = path.join(pluginsDir, entry.name);
                    let info = { name: entry.name, description: 'No description' };

                    // Try to read package.json
                    const pkgPath = path.join(pluginPath, 'package.json');
                    if (fs.existsSync(pkgPath)) {
                        try {
                            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                            info.description = pkg.description || info.description;
                            info.version = pkg.version;

                            // Author
                            if (typeof pkg.author === 'string') info.author = pkg.author;
                            else if (pkg.author && pkg.author.name) info.author = pkg.author.name;

                            // Valid Link Detection
                            if (pkg.repository) {
                                const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url;
                                if (repoUrl) {
                                    info.link = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
                                }
                            } else if (pkg.homepage) {
                                info.link = pkg.homepage;
                            }

                            // CHECK INSTALLATION STATUS
                            // If package.json has dependencies but node_modules is missing, it's likely still installing or failed.
                            const hasDeps = pkg.dependencies && Object.keys(pkg.dependencies).length > 0;
                            if (hasDeps) {
                                const nodeModulesPath = path.join(pluginPath, 'node_modules');
                                if (!fs.existsSync(nodeModulesPath)) {
                                    info.isInstalling = true;
                                    info.description = '[Installing Dependencies...] ' + info.description;
                                }
                            }
                        } catch (e) { }
                    }



                    // Fallback: Try to read git config if no link found
                    if (!info.link) {
                        const gitConfigPath = path.join(pluginPath, '.git', 'config');
                        if (fs.existsSync(gitConfigPath)) {
                            try {
                                const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
                                const urlMatch = gitConfig.match(/url\s*=\s*(.+)/);
                                if (urlMatch) {
                                    let repoUrl = urlMatch[1].trim();
                                    repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
                                    info.link = repoUrl;
                                }
                            } catch (e) { }
                        }
                    }

                    // SYNC WITH STORE DESCRIPTION
                    // If we have store data cached, try to find a match to provide a better description (e.g. Chinese)
                    if (storeCache.data.length > 0 && info.link) {
                        const normalizedLink = info.link.replace(/\/+$/, '').toLowerCase();
                        const storeMatch = storeCache.data.find(sp => {
                            return sp.link && sp.link.replace(/\/+$/, '').toLowerCase() === normalizedLink;
                        });
                        if (storeMatch && storeMatch.description) {
                            info.description = storeMatch.description;
                        }
                    }

                    plugins.push(info);
                }
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                // Root Level JS Plugin
                plugins.push({
                    name: entry.name,
                    description: 'Single JS Plugin',
                    isSingleFile: true
                });
            }
        }
    } catch (e) {
        console.error('Error reading plugins:', e);
    }

    res.json(plugins);
});

// 3. Install Plugin
// Helper: Async Plugin Installation to prevent timeout
async function installPlugin(instanceId, name, repoUrl, data) {
    const instance = data.instances.find(i => i.id === instanceId);
    if (!instance) return;

    const pluginsDir = path.join(instance.path, 'plugins');
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

    // Track created directories for cleanup on failure
    let createdDir = null;

    try {
        broadcastLog(instanceId, `--- Starting Installation: ${name} ---`);

        // Check for hash to identify single file install (e.g. #ScriptName)
        const hashIndex = repoUrl.indexOf('#');
        if (hashIndex !== -1) {
            // Single File Mode
            const targetName = decodeURIComponent(repoUrl.substring(hashIndex + 1));
            let cleanUrl = repoUrl.substring(0, hashIndex);

            // APPLY GIT PROXY
            const downloadMirror = data.settings?.pluginDownloadMirror;
            if (downloadMirror && cleanUrl.includes('github.com')) {
                // Ensure mirror URL ends with /
                const mirrorBase = downloadMirror.endsWith('/') ? downloadMirror : downloadMirror + '/';
                // Ensure repo URL starts with https://
                if (!cleanUrl.startsWith('https://') && !cleanUrl.startsWith('http://')) {
                    cleanUrl = 'https://' + cleanUrl;
                }
                cleanUrl = mirrorBase + cleanUrl;
                broadcastLog(instanceId, `Using Proxy: ${mirrorBase}`);
            }

            const tempDir = path.join(instance.path, `temp_install_${Date.now()}`);

            broadcastLog(instanceId, `Detected Single JS Install: ${targetName}`);

            // 1. Clone to temp
            await runCommand('git', ['clone', '--depth', '1', cleanUrl, tempDir], instance.path, instanceId);

            // 2. Find target file (Try Exact, then .js)
            const exampleDir = path.join(pluginsDir, 'example');
            if (!fs.existsSync(exampleDir)) fs.mkdirSync(exampleDir, { recursive: true });

            const possibleFiles = [
                targetName,
                `${targetName}.js`,
                path.join(targetName, `${targetName}.js`)
            ];

            let found = false;
            for (const f of possibleFiles) {
                const srcPath = path.join(tempDir, f);
                if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
                    const destPath = path.join(exampleDir, path.basename(srcPath));
                    fs.copyFileSync(srcPath, destPath);
                    broadcastLog(instanceId, `Installed ${path.basename(srcPath)} to plugins/example/`);
                    found = true;
                    break;
                }
            }

            // 3. Cleanup
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) { console.error('Temp cleanup failed', e); }

            if (!found) {
                throw new Error(`Target file "${targetName}" not found in repository.`);
            }

        } else {
            // Full Repo Mode
            let cleanRepoUrl = repoUrl;

            // APPLY GIT PROXY
            const downloadMirror = data.settings?.pluginDownloadMirror;
            if (downloadMirror && cleanRepoUrl.includes('github.com')) {
                // Ensure mirror URL ends with /
                const mirrorBase = downloadMirror.endsWith('/') ? downloadMirror : downloadMirror + '/';
                // Ensure repo URL starts with https://
                if (!cleanRepoUrl.startsWith('https://') && !cleanRepoUrl.startsWith('http://')) {
                    cleanRepoUrl = 'https://' + cleanRepoUrl;
                }
                cleanRepoUrl = mirrorBase + cleanRepoUrl;
                broadcastLog(instanceId, `Using Proxy: ${mirrorBase}`);
                broadcastLog(instanceId, `Clone URL: ${cleanRepoUrl}`);
            }

            // Determine folder name - ALWAYS use repo name from URL, NOT display name
            // Extract repo name from original URL (before proxy was applied)
            const originalUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
            const urlParts = originalUrl.split('/');
            let folderName = urlParts[urlParts.length - 1];
            // Sanitize folder name (remove invalid characters)
            folderName = folderName.replace(/[\\/:*?"<>|]/g, '');
            const targetDir = path.join(pluginsDir, folderName);

            if (fs.existsSync(targetDir)) {
                throw new Error(`Plugin folder "${folderName}" already exists.`);
            }

            // Track for cleanup on failure
            createdDir = targetDir;

            await runCommand('git', ['clone', '--depth', '1', cleanRepoUrl, folderName], pluginsDir, instanceId);

            // Step 2: Check for package.json and install dependencies
            if (fs.existsSync(path.join(targetDir, 'package.json'))) {
                broadcastLog(instanceId, 'Found package.json, installing dependencies...');

                // Smart Package Manager Detection
                let npmCmd = 'pnpm'; // Default for Yunzai ecosystem
                if (fs.existsSync(path.join(targetDir, 'package-lock.json'))) npmCmd = 'npm';
                else if (fs.existsSync(path.join(targetDir, 'yarn.lock'))) npmCmd = 'yarn';

                // Fallback to npm if pnpm fails? No, usually pnpm availability is binary-based.
                // Assuming pnpm is installed in environment since this is a Yunzai launcher.

                broadcastLog(instanceId, `Using ${npmCmd} to install dependencies...`);
                // Standard install command
                const installArgs = ['install'];
                if (npmCmd === 'npm') installArgs.push('--production', '--no-audit', '--no-fund');
                if (npmCmd === 'pnpm') installArgs.push('--prod', '--no-frozen-lockfile'); // Relaxed pnpm install

                try {
                    await runCommand(npmCmd, installArgs, targetDir, instanceId, { env: { CI: 'true' } });
                } catch (e) {
                    broadcastLog(instanceId, `[WARN] Dependency install failed: ${e.message}. You may need to install manually.`);
                }
            } else {
                broadcastLog(instanceId, 'No package.json found, skipping dependency installation.');
            }
        }

        broadcastLog(instanceId, `--- Plugin Installed Successfully ---`);

        // Run pnpm install in instance root to ensure all dependencies are installed
        broadcastLog(instanceId, `[SYSTEM] Updating instance dependencies...`);
        try {
            // CI=true prevents interactive prompts in non-TTY environment
            await runCommand('pnpm', ['install', '--no-frozen-lockfile'], instance.path, instanceId, { env: { CI: 'true' } });
            broadcastLog(instanceId, `[SYSTEM] Dependencies updated successfully.`);
        } catch (e) {
            broadcastLog(instanceId, `[WARN] Failed to update dependencies: ${e.message}`);
            broadcastLog(instanceId, `[WARN] 请手动在实例目录运行 pnpm i 安装依赖`);
        }

    } catch (err) {
        broadcastLog(instanceId, `--- Installation Failed: ${err.message} ---`);

        // Cleanup: Remove partially created directory
        if (createdDir && fs.existsSync(createdDir)) {
            try {
                broadcastLog(instanceId, `[SYSTEM] Cleaning up incomplete installation...`);
                fs.rmSync(createdDir, { recursive: true, force: true });
                broadcastLog(instanceId, `[SYSTEM] Cleanup complete.`);
            } catch (cleanupErr) {
                broadcastLog(instanceId, `[WARN] Failed to cleanup: ${cleanupErr.message}`);
            }
        }
    }
}

// 3. Install Plugin (Async)
router.post('/install/:instanceId', (req, res) => {
    const { instanceId } = req.params;
    const { name, repoUrl } = req.body;

    const data = loadData();
    const instance = data.instances.find(i => i.id === instanceId);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    // Validate
    if (!repoUrl) return res.status(400).json({ error: 'Repo URL required' });

    // Start background process
    installPlugin(instanceId, name, repoUrl, data);

    // Return immediately
    res.json({ status: 'processing', message: 'Installation task submitted' });
});

// 4. Uninstall Plugin
router.delete('/uninstall/:instanceId', (req, res) => {
    try {
        const { instanceId } = req.params;
        const { pluginName } = req.body; // or query

        console.log(`[DEBUG] Uninstall request: instanceId=${instanceId}, pluginName=${pluginName}`);

        const data = loadData();
        const instance = data.instances.find(i => i.id === instanceId);
        if (!instance) return res.status(404).json({ error: 'Instance not found' });

        if (!pluginName) return res.status(400).json({ error: 'Plugin name required' });
        // Security check to prevent traversing up
        if (pluginName.includes('..') || pluginName.includes('/') || pluginName.includes('\\')) {
            return res.status(400).json({ error: 'Invalid plugin name' });
        }

        let targetPath = path.join(instance.path, 'plugins', pluginName);
        console.log(`[DEBUG] Initial target path: ${targetPath}`);

        // Smart lookup: If not found, try appending .js or checking in example/
        if (!fs.existsSync(targetPath)) {
            console.log(`[DEBUG] Not found at initial path, trying alternatives...`);

            // 1. Try adding .js in root plugins/
            if (fs.existsSync(targetPath + '.js')) {
                targetPath += '.js';
                console.log(`[DEBUG] Found at: ${targetPath}`);
            }
            // 2. Try plugins/example/NAME
            else if (fs.existsSync(path.join(instance.path, 'plugins', 'example', pluginName))) {
                targetPath = path.join(instance.path, 'plugins', 'example', pluginName);
                console.log(`[DEBUG] Found in example (exact): ${targetPath}`);
            }
            // 3. Try plugins/example/NAME.js
            else {
                const nameWithJs = pluginName.endsWith('.js') ? pluginName : pluginName + '.js';
                const examplePath = path.join(instance.path, 'plugins', 'example', nameWithJs);
                if (fs.existsSync(examplePath)) {
                    targetPath = examplePath;
                    console.log(`[DEBUG] Found in example (.js): ${targetPath}`);
                }
            }
        }

        console.log(`[DEBUG] Final target path: ${targetPath}, exists: ${fs.existsSync(targetPath)}`);

        if (fs.existsSync(targetPath)) {
            console.log(`[DEBUG] About to delete...`);
            try {
                // Use synchronous delete with explicit error handling
                const stat = fs.statSync(targetPath);
                console.log(`[DEBUG] Target is ${stat.isDirectory() ? 'directory' : 'file'}`);

                if (stat.isDirectory()) {
                    fs.rmSync(targetPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(targetPath);
                }

                console.log(`[DEBUG] Delete completed`);
                broadcastLog(instanceId, `--- Uninstalled Plugin: ${pluginName} ---`);
                console.log(`[DEBUG] Uninstall successful: ${pluginName}`);
                res.json({ success: true });
            } catch (e) {
                console.error(`[DEBUG] Failed to delete: ${e.message}`);
                console.error(e.stack);
                res.status(500).json({ error: e.message });
            }
        } else {
            console.log(`[DEBUG] Plugin not found at any location`);
            res.status(404).json({ error: 'Plugin not found' });
        }
    } catch (err) {
        console.error('[FATAL] Uninstall error:', err);
        res.status(500).json({ error: 'Internal server error: ' + err.message });
    }
});


// Helper to run command and stream logs
// Use process.cwd() to get the bin directory relative to where the server is started
const BIN_DIR = path.join(process.cwd(), 'bin');

function runCommand(command, args, cwd, instanceId, options = {}) {
    return new Promise((resolve, reject) => {
        const isWin = process.platform === 'win32';
        // Handle npm/pnpm on windows
        let cmd = isWin && (command === 'npm' || command === 'pnpm' || command === 'yarn') ? `${command}.cmd` : command;

        // Quote command path if it contains spaces (Windows shell issue)
        if (isWin && cmd.includes(' ') && !cmd.startsWith('"')) {
            cmd = `"${cmd}"`;
        }

        // Quote arguments with spaces for Windows shell
        const safeArgs = isWin ? args.map(arg => {
            if (arg.includes(' ') && !arg.startsWith('"') && !arg.endsWith('"')) {
                return `"${arg}"`;
            }
            return arg;
        }) : args;

        // Prepare Environment with bundled tool paths
        const env = { ...process.env, ...(options.env || {}) };
        const gitBin = path.join(BIN_DIR, 'PortableGit', 'cmd');
        const nodeBin = path.join(BIN_DIR, 'node-v24.12.0-win-x64', 'node-v24.12.0-win-x64');
        const pythonBin = path.join(BIN_DIR, 'python-3.12.8-embed-amd64');

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
            env[pathKey] = `${gitBin};${nodeBin};${pythonBin};${currentPath}`;
        } else {
            env.PATH = `${gitBin}:${nodeBin}:${pythonBin}:${env.PATH}`;
        }

        const child = spawn(cmd, safeArgs, { cwd, shell: isWin, env });

        child.stdout.on('data', (data) => {
            const line = stripAnsi(data.toString().trim());
            if (line) broadcastLog(instanceId, line);
        });

        child.stderr.on('data', (data) => {
            const line = stripAnsi(data.toString().trim());
            if (line) {
                // Git and uv send progress to stderr, don't mark as ERR
                // uv patterns: Resolved, Downloading, Downloaded, Building, Built, Prepared, Installed, Uninstalled, warning:
                // Also match package version patterns like: package==1.0.0, +package, -package
                const isProgressOutput =
                    line.startsWith('Cloning into') ||
                    line.includes('Note: checking out') ||
                    line.startsWith('Resolved') ||
                    line.startsWith('Downloading') ||
                    line.startsWith('Downloaded') ||
                    line.startsWith('Building') ||
                    line.startsWith('Built') ||
                    line.startsWith('Prepared') ||
                    line.startsWith('Installed') ||
                    line.startsWith('Uninstalled') ||
                    line.startsWith('Audited') ||
                    line.startsWith('Using Python') ||
                    line.startsWith('warning:') ||
                    line.startsWith('-') ||
                    line.startsWith('+') ||
                    line.includes('packages in') ||
                    // Match package version patterns (e.g., anyio==4.0.0, certifi==2023.7.22)
                    /^[a-zA-Z0-9_-]+==[0-9]/.test(line) ||
                    // Match partial version lines (e.g., 1.4.0, ==4.0.0)
                    /^[0-9]+\.[0-9]/.test(line) ||
                    /^==[0-9]/.test(line);

                if (isProgressOutput) {
                    broadcastLog(instanceId, line);
                } else {
                    broadcastLog(instanceId, `[ERR] ${line}`);
                }
            }
        });

        child.on('error', (err) => {
            reject(err);
        });

        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Process exited with code ${code}`));
        });
    });
}
// =============================================
// GSUID Plugin Management
// =============================================

// GSUID Plugin Index (Hardcoded)
const GSUID_PLUGINS = [
    { name: 'StarRailUID', link: 'https://github.com/baiqwerdvd/StarRailUID', author: 'baiqwerdvd', description: '全功能星穹铁道插件' },
    { name: 'GenshinUID', link: 'https://github.com/KimigaiiWuyi/GenshinUID', author: 'KimigaiiWuyi', description: '全功能原神插件' },
    { name: 'mys_qrlogin', link: 'https://github.com/RBAmeto/gsuidcore_mys_qrlogin', author: 'RBAmeto', description: '扫码登陆游戏插件' },
    { name: 'honkai_sign', link: 'https://github.com/RBAmeto/gsuidcore_honkai_sign', author: 'RBAmeto', description: '崩坏三签到插件' },
    { name: 'maimai_plugin', link: 'https://github.com/Agnes4m/maimai_plugin', author: 'Agnes4m', description: 'maimai插件' },
    { name: 'WzryUID', link: 'https://github.com/KimigaiiWuyi/WzryUID', author: 'KimigaiiWuyi', description: '全功能王者荣耀插件' },
    { name: 'ArknightsUID', link: 'https://github.com/baiqwerdvd/ArknightsUID', author: 'baiqwerdvd', description: '全功能明日方舟插件' },
    { name: 'BlueArchiveUID', link: 'https://github.com/KimigaiiWuyi/BlueArchiveUID', author: 'KimigaiiWuyi', description: '蔚蓝档案插件' },
    { name: 'PsyTest', link: 'https://github.com/KimigaiiWuyi/gsuidcore_psytest', author: 'KimigaiiWuyi', description: '心理测试集合插件' },
    { name: 'Pokemon', link: 'https://github.com/jiluoQAQ/Pokemon', author: 'jiluoQAQ', description: '宝可梦小游戏插件' },
    { name: 'MajsoulUID', link: 'https://github.com/KimigaiiWuyi/MajsoulUID', author: 'KimigaiiWuyi', description: '全功能雀魂查询插件' },
    { name: 'LOLegendsUID', link: 'https://github.com/KimigaiiWuyi/LOLegendsUID', author: 'KimigaiiWuyi', description: '全功能LOL查询插件' },
    { name: 'CS2UID', link: 'https://github.com/Agnes4m/CS2UID', author: 'Agnes4m', description: '全功能CS2查询插件' },
    { name: 'ZZZeroUID', link: 'https://github.com/ZZZure/ZZZeroUID', author: 'ZZZure', description: '全功能绝区零查询插件' },
    { name: 'XutheringWavesUID', link: 'https://github.com/Loping151/XutheringWavesUID', author: 'Loping151', description: '全功能鸣潮查询插件' },
    { name: 'VAUID', link: 'https://github.com/Agnes4m/VAUID', author: 'Agnes4m', description: '全功能无畏契约查询插件' },
    { name: 'SayuStock', link: 'https://github.com/KimigaiiWuyi/SayuStock', author: 'KimigaiiWuyi', description: '股票插件, 查询云图概览等' },
    { name: 'DeltaUID', link: 'https://github.com/Agnes4m/DeltaUID', author: 'Agnes4m', description: '三角洲查询插件' },
    { name: 'DNAUID', link: 'https://github.com/tyql688/DNAUID', author: 'tyql688', description: '二重螺旋查询插件' }
];

// Get GSUID Plugin Store
router.get('/gsuid-store', (req, res) => {
    res.json(GSUID_PLUGINS);
});

// Get Installed GSUID Plugins
router.get('/gsuid-installed/:instanceId', (req, res) => {
    const { instanceId } = req.params;
    const data = loadData();
    const instance = data.instances.find(i => i.id === instanceId);

    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    // GSUID plugins are in gsuid_core/plugins or just plugins
    let pluginsDir = path.join(instance.path, 'gsuid_core', 'plugins');
    if (!fs.existsSync(pluginsDir)) {
        pluginsDir = path.join(instance.path, 'plugins');
    }
    if (!fs.existsSync(pluginsDir)) {
        return res.json([]);
    }

    const plugins = [];

    try {
        const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                // Skip system directories
                if (['__pycache__', '.git', 'GsCore'].includes(entry.name)) continue;

                const pluginPath = path.join(pluginsDir, entry.name);
                let info = { name: entry.name, description: 'No description' };

                // Try to match with store for description
                const storeMatch = GSUID_PLUGINS.find(p =>
                    p.name.toLowerCase() === entry.name.toLowerCase() ||
                    p.link.toLowerCase().includes(entry.name.toLowerCase())
                );
                if (storeMatch) {
                    info.description = storeMatch.description;
                    info.link = storeMatch.link;
                }

                // Try to read git config for link
                if (!info.link) {
                    const gitConfigPath = path.join(pluginPath, '.git', 'config');
                    if (fs.existsSync(gitConfigPath)) {
                        try {
                            const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
                            const urlMatch = gitConfig.match(/url\s*=\s*(.+)/);
                            if (urlMatch) {
                                let repoUrl = urlMatch[1].trim();
                                repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
                                info.link = repoUrl;
                            }
                        } catch (e) { }
                    }
                }

                // Check for requirements.txt (Python dependency indicator)
                const reqPath = path.join(pluginPath, 'requirements.txt');
                info.hasRequirements = fs.existsSync(reqPath);

                plugins.push(info);
            }
        }
    } catch (e) {
        console.error('Error reading GSUID plugins:', e);
    }

    res.json(plugins);
});

// Install GSUID Plugin (Async)
async function installGsuidPlugin(instanceId, name, repoUrl, data) {
    const instance = data.instances.find(i => i.id === instanceId);
    if (!instance) return;

    // Determine plugins directory
    let pluginsDir = path.join(instance.path, 'gsuid_core', 'plugins');
    if (!fs.existsSync(path.join(instance.path, 'gsuid_core'))) {
        pluginsDir = path.join(instance.path, 'plugins');
    }
    if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

    let createdDir = null;

    try {
        broadcastLog(instanceId, `--- [GSUID] 开始安装插件: ${name} ---`);

        let cleanRepoUrl = repoUrl;

        // APPLY GIT PROXY
        const downloadMirror = data.settings?.pluginDownloadMirror;
        if (downloadMirror && cleanRepoUrl.includes('github.com')) {
            const mirrorBase = downloadMirror.endsWith('/') ? downloadMirror : downloadMirror + '/';
            if (!cleanRepoUrl.startsWith('https://') && !cleanRepoUrl.startsWith('http://')) {
                cleanRepoUrl = 'https://' + cleanRepoUrl;
            }
            cleanRepoUrl = mirrorBase + cleanRepoUrl;
            broadcastLog(instanceId, `使用代理: ${mirrorBase}`);
        }

        // Determine folder name from URL
        const originalUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
        const urlParts = originalUrl.split('/');
        let folderName = urlParts[urlParts.length - 1];
        folderName = folderName.replace(/[\\/:*?"<>|]/g, '');
        const targetDir = path.join(pluginsDir, folderName);

        if (fs.existsSync(targetDir)) {
            throw new Error(`插件目录 "${folderName}" 已存在。`);
        }

        createdDir = targetDir;

        // Clone repository
        broadcastLog(instanceId, `正在克隆仓库: ${cleanRepoUrl}`);
        await runCommand('git', ['clone', '--depth', '1', cleanRepoUrl, folderName], pluginsDir, instanceId);

        // Check for requirements.txt and install Python dependencies
        const reqPath = path.join(targetDir, 'requirements.txt');
        if (fs.existsSync(reqPath)) {
            broadcastLog(instanceId, '发现 requirements.txt, 正在安装 Python 依赖...');

            // Use bundled uv or global uv
            // Try multiple possible uv locations
            const uvPaths = [
                path.join(BIN_DIR, 'uv-x86_64-pc-windows-msvc', 'uv.exe'),
                path.join(BIN_DIR, 'uv', 'uv.exe')
            ];
            let uvCommand = null;

            for (const uvPath of uvPaths) {
                if (fs.existsSync(uvPath)) {
                    uvCommand = uvPath;
                    broadcastLog(instanceId, '使用内置 uv 安装依赖...');
                    break;
                }
            }

            // If bundled uv not found, try global uv
            if (!uvCommand) {
                try {
                    const { execSync } = require('child_process');
                    execSync('uv --version', { stdio: 'ignore' });
                    uvCommand = 'uv';
                    broadcastLog(instanceId, '使用全局 uv 安装依赖...');
                } catch (e) {
                    // Global uv not found either
                }
            }

            if (uvCommand) {
                try {
                    // Run from targetDir with just 'requirements.txt' since it's the cwd
                    await runCommand(uvCommand, ['pip', 'install', '-r', 'requirements.txt'], targetDir, instanceId);
                    broadcastLog(instanceId, 'Python 依赖安装完成。');
                } catch (e) {
                    broadcastLog(instanceId, `[WARN] 依赖安装失败: ${e.message}`);
                    broadcastLog(instanceId, `[WARN] 请手动运行: uv pip install -r requirements.txt`);
                }
            } else {
                broadcastLog(instanceId, '[WARN] 未找到 uv，跳过依赖安装。请手动安装依赖。');
            }
        } else {
            broadcastLog(instanceId, '未发现 requirements.txt，跳过依赖安装。');
        }

        broadcastLog(instanceId, `--- [GSUID] 插件 ${name} 安装成功 ---`);

    } catch (err) {
        broadcastLog(instanceId, `--- [GSUID] 安装失败: ${err.message} ---`);

        // Cleanup
        if (createdDir && fs.existsSync(createdDir)) {
            try {
                broadcastLog(instanceId, `[SYSTEM] 清理未完成的安装...`);
                fs.rmSync(createdDir, { recursive: true, force: true });
                broadcastLog(instanceId, `[SYSTEM] 清理完成。`);
            } catch (cleanupErr) {
                broadcastLog(instanceId, `[WARN] 清理失败: ${cleanupErr.message}`);
            }
        }
    }
}

router.post('/gsuid-install/:instanceId', (req, res) => {
    const { instanceId } = req.params;
    const { name, repoUrl } = req.body;

    const data = loadData();
    const instance = data.instances.find(i => i.id === instanceId);
    if (!instance) return res.status(404).json({ error: 'Instance not found' });

    if (!repoUrl) return res.status(400).json({ error: 'Repo URL required' });

    // Start background process
    installGsuidPlugin(instanceId, name, repoUrl, data);

    res.json({ status: 'processing', message: 'Installation task submitted' });
});

// Uninstall GSUID Plugin
router.delete('/gsuid-uninstall/:instanceId', (req, res) => {
    try {
        const { instanceId } = req.params;
        const { pluginName } = req.body;

        console.log(`[DEBUG] GSUID Uninstall: instanceId=${instanceId}, pluginName=${pluginName}`);

        const data = loadData();
        const instance = data.instances.find(i => i.id === instanceId);
        if (!instance) return res.status(404).json({ error: 'Instance not found' });

        if (!pluginName) return res.status(400).json({ error: 'Plugin name required' });
        if (pluginName.includes('..') || pluginName.includes('/') || pluginName.includes('\\')) {
            return res.status(400).json({ error: 'Invalid plugin name' });
        }

        // Try gsuid_core/plugins first, then plugins
        let targetPath = path.join(instance.path, 'gsuid_core', 'plugins', pluginName);
        if (!fs.existsSync(targetPath)) {
            targetPath = path.join(instance.path, 'plugins', pluginName);
        }

        console.log(`[DEBUG] Target path: ${targetPath}, exists: ${fs.existsSync(targetPath)}`);

        if (fs.existsSync(targetPath)) {
            try {
                const stat = fs.statSync(targetPath);
                if (stat.isDirectory()) {
                    fs.rmSync(targetPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(targetPath);
                }

                broadcastLog(instanceId, `--- [GSUID] 已卸载插件: ${pluginName} ---`);
                res.json({ success: true });
            } catch (e) {
                console.error(`[DEBUG] Delete failed: ${e.message}`);
                res.status(500).json({ error: e.message });
            }
        } else {
            res.status(404).json({ error: 'Plugin not found' });
        }
    } catch (err) {
        console.error('[FATAL] GSUID Uninstall error:', err);
        res.status(500).json({ error: 'Internal server error: ' + err.message });
    }
});

module.exports = router;
