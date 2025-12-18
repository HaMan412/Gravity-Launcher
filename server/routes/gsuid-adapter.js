/**
 * GSUID-Yunzai Link Adapter
 * 轻量级适配器：接收 OneBot HTTP 消息，转发到 GSUID WebSocket
 * 使用项目已有的 ws 库，无额外依赖
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { broadcastLog } = require('../utils/wsHelper');
const router = express.Router();

// ========== VERSION CHECK ==========
console.log('');
console.log('╔═════════════════════════════════╗');
console.log('║  [GSUID-Adapter] - 已加载       ║');
console.log('╚═════════════════════════════════╝');
console.log('');

// 持久化存储路径
const LINKS_FILE = path.join(__dirname, '../links.json');

// 存储每个链接的运行时状态
const linkStates = new Map(); // linkId -> { ws, config, status, autoReconnect }

/**
 * 从文件加载链接配置
 */
function loadLinks() {
    try {
        if (fs.existsSync(LINKS_FILE)) {
            const data = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf-8'));
            return data.links || [];
        }
    } catch (e) {
        console.error('[GSUID-Adapter] Failed to load links:', e);
    }
    return [];
}

/**
 * 保存链接配置到文件
 */
function saveLinks() {
    try {
        const links = [];
        linkStates.forEach((state, id) => {
            links.push({
                id,
                config: state.config
            });
        });
        fs.writeFileSync(LINKS_FILE, JSON.stringify({ links }, null, 2));
    } catch (e) {
        console.error('[GSUID-Adapter] Failed to save links:', e);
    }
}

/**
 * 初始化：从文件加载链接并恢复状态（但不自动连接）
 */
function initLinks() {
    const savedLinks = loadLinks();
    for (const link of savedLinks) {
        linkStates.set(link.id, {
            ws: null,
            config: { ...link.config, enabled: false }, // 启动时默认禁用
            status: 'disabled',
            autoReconnect: false
        });
        console.log(`[GSUID-Adapter] Loaded link: ${link.id}`);
    }
}

// 初始化加载
initLinks();

/**
 * 统一日志输出: 同时打印到控制台和广播到前端 GSUID 实例日志
 */
function log(linkId, message, level = 'info') {
    const state = linkStates.get(linkId);
    const prefix = `[Link][${linkId.split('-')[1]?.slice(0, 8) || linkId}]`;
    const fullMsg = `${prefix} ${message}`;

    // Console log
    if (level === 'error') console.error(fullMsg);
    else console.log(fullMsg);

    // Broadcast to frontend if we know the instance ID
    if (state && state.config && state.config.gsuidInstanceId) {
        broadcastLog(state.config.gsuidInstanceId, fullMsg);
    }
}

/**
 * OneBot 消息格式转 GSUID MessageReceive 格式
 */
function onebotToGsuid(obMsg, config) {
    const isGroup = obMsg.message_type === 'group';

    const content = [];
    const msgArray = Array.isArray(obMsg.message) ? obMsg.message : [{ type: 'text', data: { text: obMsg.raw_message || '' } }];

    for (const seg of msgArray) {
        if (seg.type === 'text') {
            content.push({ type: 'text', data: seg.data?.text || '' });
        } else if (seg.type === 'image') {
            content.push({ type: 'image', data: seg.data?.url || seg.data?.file || '' });
        } else if (seg.type === 'at') {
            content.push({ type: 'at', data: seg.data?.qq || '' });
        }
    }

    return {
        bot_id: config.botId || 'YunzaiBot',
        bot_self_id: String(obMsg.self_id || ''),
        msg_id: String(obMsg.message_id || ''),
        user_type: isGroup ? 'group' : 'direct',
        group_id: isGroup ? String(obMsg.group_id || '') : null,
        user_id: String(obMsg.user_id || ''),
        sender: {
            nickname: obMsg.sender?.nickname || '',
            card: obMsg.sender?.card || ''
        },
        user_pm: 3,
        content
    };
}

/**
 * GSUID MessageSend 格式转 OneBot 发送格式
 */
function gsuidToOnebot(gsMsg) {
    const segments = [];

    if (gsMsg.content) {
        for (const item of gsMsg.content) {
            if (item.type === 'text') {
                segments.push({ type: 'text', data: { text: item.data } });
            } else if (item.type === 'image') {
                segments.push({ type: 'image', data: { file: item.data } });
            } else if (item.type === 'at') {
                segments.push({ type: 'at', data: { qq: item.data } });
            }
        }
    }

    return {
        action: gsMsg.target_type === 'group' ? 'send_group_msg' : 'send_private_msg',
        params: {
            [gsMsg.target_type === 'group' ? 'group_id' : 'user_id']: gsMsg.target_id,
            message: segments
        }
    };
}

/**
 * 发送消息到 Yunzai (通过 LLOneBot HTTP API)
 */
function sendToYunzai(linkId, gsMsg) {
    const state = linkStates.get(linkId);
    if (!state || !state.config) return;

    const config = state.config;
    const yunzaiApiUrl = config.yunzaiApiUrl || `http://localhost:3000`;

    // 转换消息格式
    const obMsg = gsuidToOnebot(gsMsg);
    if (!obMsg.params.message || obMsg.params.message.length === 0) {
        return;
    }

    const endpoint = `${yunzaiApiUrl}/${obMsg.action}`;
    log(linkId, `转发回复到 Yunzai: ${obMsg.action}`);

    try {
        const url = new URL(endpoint);
        const postData = JSON.stringify(obMsg.params);

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    log(linkId, `✓ 回复已发送`);
                } else {
                    log(linkId, `发送失败: ${res.statusCode}`, 'error');
                }
            });
        });

        req.on('error', (e) => {
            log(linkId, `发送失败: ${e.message}`, 'error');
        });

        req.write(postData);
        req.end();
    } catch (e) {
        log(linkId, `发送失败: ${e.message}`, 'error');
    }
}

/**
 * 创建到 GSUID 的 WebSocket 连接
 */
function createGsuidConnection(linkId, config) {
    const state = linkStates.get(linkId);
    if (!state || !state.config.enabled) {
        return null;
    }

    const wsUrl = `ws://${config.gsuidHost || 'localhost'}:${config.gsuidPort || 8765}/ws/${config.botId || 'YunzaiBot'}`;

    log(linkId, `正在连接: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        log(linkId, '✓ 已连接到 GSUID Core');
        if (state) state.status = 'connected';
    });

    ws.on('message', (data) => {
        try {
            const gsMsg = JSON.parse(data.toString());
            if (gsMsg.content && gsMsg.target_id) {
                log(linkId, `收到 GSUID 回复 → ${gsMsg.target_type}:${gsMsg.target_id}`);
                // 转发到 Yunzai
                sendToYunzai(linkId, gsMsg);
            }
        } catch (e) {
            log(linkId, `解析消息失败: ${e.message}`, 'error');
        }
    });

    ws.on('close', () => {
        log(linkId, '连接断开');
        const currentState = linkStates.get(linkId);
        if (currentState && currentState.config.enabled) {
            currentState.status = 'connecting';
            if (currentState.autoReconnect) {
                log(linkId, '5秒后重连...');
                setTimeout(() => {
                    const s = linkStates.get(linkId);
                    if (s && s.config.enabled && s.autoReconnect) {
                        s.ws = createGsuidConnection(linkId, s.config);
                    }
                }, 5000);
            }
        }
    });

    ws.on('error', (err) => {
        log(linkId, `连接错误: ${err.message}`, 'error');
    });

    return ws;
}

/**
 * 发送消息到 GSUID
 */
function sendToGsuid(linkId, message) {
    const state = linkStates.get(linkId);
    if (!state || !state.config.enabled) {
        return false;
    }
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {
        // GSUID Core expects binary WebSocket frame (receive_bytes)
        const data = Buffer.from(JSON.stringify(message), 'utf-8');
        state.ws.send(data, { binary: true });
        return true;
    } catch (e) {
        log(linkId, `发送失败: ${e.message}`, 'error');
        return false;
    }
}

// ================== API Routes ==================

// 获取所有链接状态
router.get('/links', (req, res) => {
    const links = [];
    linkStates.forEach((state, id) => {
        links.push({
            id,
            config: state.config,
            status: state.status
        });
    });
    res.json(links);
});

// 创建/更新链接
router.post('/link', (req, res) => {
    const { linkId, gsuidInstanceId, yunzaiInstanceId, gsuidHost, gsuidPort, yunzaiApiUrl, botId } = req.body;

    if (!linkId || !gsuidInstanceId || !yunzaiInstanceId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const config = {
        gsuidInstanceId,
        yunzaiInstanceId,
        gsuidHost: gsuidHost || 'localhost',
        gsuidPort: gsuidPort || 8765,
        yunzaiApiUrl: yunzaiApiUrl || 'http://localhost:3000',
        botId: botId || 'YunzaiBot',
        enabled: false // 新建链接默认禁用
    };

    // 关闭旧连接
    if (linkStates.has(linkId)) {
        const oldState = linkStates.get(linkId);
        oldState.autoReconnect = false;
        if (oldState.ws) oldState.ws.close();
    }

    // 初始化状态
    const state = {
        ws: null,
        config,
        status: 'disabled',
        autoReconnect: false
    };
    linkStates.set(linkId, state);
    saveLinks();

    log(linkId, '链接已创建 (未启用)');

    res.json({ success: true, linkId });
});

// 切换链接开关
router.post('/link/:linkId/toggle', (req, res) => {
    const { linkId } = req.params;
    const { enabled } = req.body;

    const state = linkStates.get(linkId);
    if (!state) {
        return res.status(404).json({ error: 'Link not found' });
    }

    state.config.enabled = !!enabled;

    if (enabled) {
        log(linkId, '启用链接');
        state.status = 'connecting';
        state.autoReconnect = true;
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            state.ws = createGsuidConnection(linkId, state.config);
        }
    } else {
        log(linkId, '禁用链接');
        state.status = 'disabled';
        state.autoReconnect = false;
        if (state.ws) {
            state.ws.close();
            state.ws = null;
        }
    }

    saveLinks();
    res.json({ success: true, status: state.status });
});

// 更新链接配置
router.put('/link/:linkId', (req, res) => {
    const { linkId } = req.params;
    const { gsuidHost, gsuidPort, yunzaiApiUrl, botId } = req.body;

    const state = linkStates.get(linkId);
    if (!state) {
        return res.status(404).json({ error: 'Link not found' });
    }

    // 更新配置
    if (gsuidHost !== undefined) state.config.gsuidHost = gsuidHost;
    if (gsuidPort !== undefined) state.config.gsuidPort = gsuidPort;
    if (yunzaiApiUrl !== undefined) state.config.yunzaiApiUrl = yunzaiApiUrl;
    if (botId !== undefined) state.config.botId = botId;

    saveLinks();
    log(linkId, '配置已更新');

    res.json({ success: true, config: state.config });
});

// 删除链接
router.delete('/link/:linkId', (req, res) => {
    const { linkId } = req.params;

    if (linkStates.has(linkId)) {
        log(linkId, '链接已删除');
        const state = linkStates.get(linkId);
        state.autoReconnect = false;
        if (state.ws) state.ws.close();
        linkStates.delete(linkId);
        saveLinks();
    }

    res.json({ success: true });
});

// 获取链接状态
router.get('/link/:linkId/status', (req, res) => {
    const { linkId } = req.params;
    const state = linkStates.get(linkId);

    if (!state) {
        return res.json({ status: 'not_found' });
    }

    res.json({ status: state.status });
});

// OneBot HTTP 上报端点 (Yunzai 发消息到这里)
router.post('/onebot/:linkId', (req, res) => {
    const { linkId } = req.params;
    const obMsg = req.body;

    if (obMsg.post_type !== 'message') {
        return res.json({ status: 'ok' });
    }

    const state = linkStates.get(linkId);
    if (!state) {
        return res.status(404).json({ error: 'Link not found' });
    }

    const gsuidMsg = onebotToGsuid(obMsg, state.config);
    const success = sendToGsuid(linkId, gsuidMsg);

    res.json({ status: success ? 'ok' : 'error' });
});

module.exports = router;
