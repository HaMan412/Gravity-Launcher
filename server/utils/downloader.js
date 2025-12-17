const axios = require('axios');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Data file for proxy settings
const DATA_FILE = path.resolve(__dirname, '../../server/data.json');

function loadProxySettings() {
    try {
        if (!fs.existsSync(DATA_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return data.settings?.proxy || null;
    } catch {
        return null;
    }
}

function createProxyAgent(proxy) {
    if (!proxy || !proxy.protocol || !proxy.host || !proxy.port) return null;

    const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
    const proxyUrl = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;

    if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
        return new SocksProxyAgent(proxyUrl);
    } else {
        return new HttpsProxyAgent(proxyUrl);
    }
}

// Track active downloads for cancel support
const activeDownloads = {};

async function downloadFile(url, destPath, onProgress, downloadId) {
    const writer = fs.createWriteStream(destPath);
    const controller = new AbortController();

    // Load proxy settings
    const proxy = loadProxySettings();
    const agent = createProxyAgent(proxy);

    // Store controller for cancel capability
    if (downloadId) {
        activeDownloads[downloadId] = {
            controller,
            destPath,
            cancel: () => controller.abort()
        };
    }

    try {
        const axiosConfig = {
            url,
            method: 'GET',
            responseType: 'stream',
            signal: controller.signal
        };

        // Add proxy agent if configured
        if (agent) {
            axiosConfig.httpsAgent = agent;
            axiosConfig.httpAgent = agent;
        }

        const response = await axios(axiosConfig);

        const totalLength = response.headers['content-length'];

        return new Promise((resolve, reject) => {
            let downloadedLength = 0;

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                if (onProgress && totalLength) {
                    const percent = (downloadedLength / totalLength) * 100;
                    onProgress(percent);
                }
            });

            response.data.pipe(writer);

            writer.on('finish', () => {
                if (downloadId) delete activeDownloads[downloadId];
                resolve();
            });

            writer.on('error', (err) => {
                if (downloadId) delete activeDownloads[downloadId];
                reject(err);
            });

            // Handle abort
            controller.signal.addEventListener('abort', () => {
                writer.close();
                // Clean up partial file
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                }
                reject(new Error('Download cancelled'));
            });
        });
    } catch (err) {
        if (downloadId) delete activeDownloads[downloadId];
        // Clean up partial file on error
        if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
        }
        throw err;
    }
}

function cancelDownload(downloadId) {
    if (activeDownloads[downloadId]) {
        activeDownloads[downloadId].cancel();
        delete activeDownloads[downloadId];
        return true;
    }
    return false;
}

async function extractZip(zipPath, destDir) {
    // Try PowerShell on Windows first (better encoding support)
    if (process.platform === 'win32') {
        const { spawn } = require('child_process');
        try {
            await new Promise((resolve, reject) => {
                const ps = spawn('powershell', [
                    '-NoProfile',
                    '-Command',
                    `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`
                ]);
                ps.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`PowerShell exited with code ${code}`));
                });
                ps.on('error', (err) => reject(err));
            });
            return true;
        } catch (e) {
            console.error('PowerShell extraction failed, falling back to AdmZip:', e);
            // Fallback continues below
        }
    }

    try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(destDir, true);
        return true;
    } catch (err) {
        console.error(' extraction error:', err);
        return false;
    }
}

module.exports = { downloadFile, extractZip, cancelDownload, activeDownloads };
