const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits,
    SlashCommandBuilder,
    REST,
    Routes,
    AttachmentBuilder
} = require('discord.js');

const http = require('http');

// --- CONFIGURATION ---
const NO_COOLDOWN_ROLE_ID = "1527587043813625976";
const ALLOWED_GUILD_ID = "1448381577489813607";

// --- DNS FIX FOR RENDER ---
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
console.log('[TMC] DNS set');

// --- CREATE CLIENT ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    rest: { timeout: 60000 },
    failIfNotExists: false
});

// --- API CONFIG ---
const NAKAMA_SERVER = 'https://animalcompany.us-east1.nakamacloud.io';
const NAKAMA_SERVER_KEY = '6URuTSlDKKfYbuDW';
const API_URLS = [ NAKAMA_SERVER ];

let ACTIVE_API_URL = API_URLS[0];
let apiWorking = false;
let isRefreshing = false;
let failedQueue = [];
let tokenStock = [];
const cooldowns = new Map();
const activeGenerations = new Map();
let refreshInterval = null;

// --- DEFAULT TOKEN ---
let DEFAULT_TOKEN = {
  "bearer": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiJiY2Q3OTcwZi0yOGVlLTQ0MGItOGZmMi04NzFkZDY0MDYzNGQiLCJ1aWQiOiJhMzQ5MTgxOS1lZGNkLTRiZDEtOTJkNS1hODJjZjk5NzBhNjYiLCJ1c24iOiIwelVHYjBrTVhyRGl0b1FYIiwidnJzIjp7ImF1dGhJRCI6ImRlZjkzN2JlMDM2ZjQzMTRhMDc5MTcyNTc2MWIxMWExIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiA5Ljk5LjkuOTk5OV9mZmZmZmZmZiIsImRldmljZUlEIjoiMTgzNTc2MWMyYThiNmM2MjliOTlmZmY5ZWRmZjI4OWQ3ZjNlYTEyOCJ9LCJleHAiOjE3ODg1ODQ1MjIsImlhdCI6MTc4ODU4MDkyMn0.he0WkQLOIYiskSiTlPQ5rqXXcENff4wU__WTyQoWULY",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiJiY2Q3OTcwZi0yOGVlLTQ0MGItOGZmMi04NzFkZDY0MDYzNGQiLCJ1aWQiOiJhMzQ5MTgxOS1lZGNkLTRiZDEtOTJkNS1hODJjZjk5NzBhNjYiLCJ1c24iOiIwelVHYjBrTVhyRGl0b1FYIiwidnJzIjp7ImF1dGhJRCI6ImRlZjkzN2JlMDM2ZjQzMTRhMDc5MTcyNTc2MWIxMWExIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiA5Ljk5LjkuOTk5OV9mZmZmZmZmZiIsImRldmljZUlEIjoiMTgzNTc2MWMyYThiNmM2MjliOTlmZmY5ZWRmZjI4OWQ3ZjNlYTEyOCJ9LCJleHAiOjE3ODg2MDI1MjIsImlhdCI6MTc4ODU4MDkyMn0.rEZgUvaBE6usKd5W34iknA-FxGv79L1c6pGl0lO3usQ"
};

// --- JWT HELPERS ---
function decodeJwt(token) {
    try {
        const part = (token || '').split('.')[1];
        if (!part) return null;
        const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
        const json = Buffer.from(normalized + '===', 'base64').toString('utf-8');
        return JSON.parse(json);
    } catch (e) { return null; }
}

// --- INPUT VALIDATION ---
function isValidJwt(token) {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    // each part must be non-empty base64url
    for (const part of parts) {
        if (!part || part.length < 10) return false;
        if (!/^[A-Za-z0-9_-]+$/.test(part)) return false;
    }
    // must decode to valid JSON with at least some structure
    const payload = decodeJwt(token);
    if (!payload || typeof payload !== 'object') return false;
    return true;
}

function isAllowedStringInput(text, maxLen) {
    if (!text || typeof text !== 'string') return false;
    text = text.trim();
    if (text.length < 5 || text.length > maxLen) return false;
    // reject anything with excessive repeated chars (spam/bomb protection)
    if (/(.)\1{10,}/.test(text)) return false;
    // reject if it contains obviously malicious / non-token content
    if (/[<>"{}]/.test(text)) return false;
    return true;
}

function getTokenExpiryMs(token) {
    const p = decodeJwt(token);
    if (p && typeof p.exp === 'number') return p.exp * 1000;
    return Date.now() + (60 * 60 * 1000);
}

function formatRemainingTime(expiresAt) {
    const diff = expiresAt - Date.now();
    if (diff <= 0) return 'Expired';
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function humanExpiry(expiresAt) {
    const diff = expiresAt - Date.now();
    if (diff <= 0) return 'Expired';
    return `${formatRemainingTime(expiresAt)}`;
}

function processQueue(error, token = null) {
    failedQueue.forEach(prom => {
        if (error) prom.reject(error);
        else prom.resolve(token);
    });
    failedQueue = [];
}

// --- CLEANUP STUCK GENERATIONS ---
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [userId, startTime] of activeGenerations) {
        if (now - startTime > 60000) {
            activeGenerations.delete(userId);
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[TMC] Cleaned ${cleaned} stuck generations`);
}, 30000);

// --- FIND WORKING API URL ---
async function findWorkingApiUrl() {
    for (const url of API_URLS) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'SteamVR 1.88.1.3421_a3df6ce5' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                ACTIVE_API_URL = url;
                apiWorking = true;
                return url;
            }
        } catch (err) {}
    }
    apiWorking = false;
    return API_URLS[0];
}

// --- VALIDATE TOKEN ---
async function validateSteamToken(bearerToken) {
    const expiresAt = getTokenExpiryMs(bearerToken);
    const expired = Date.now() >= expiresAt;
    return {
        valid: !expired,
        status: expired ? 401 : 200,
        data: { valid: !expired },
        expiresAt: expiresAt,
        message: expired ? 'Expired' : `${formatRemainingTime(expiresAt)}`
    };
}

// --- REFRESH TOKEN ---
async function refreshToken(refreshTk) {
    try {
        console.log('[TMC] Attempting to refresh token...');
        
        if (isRefreshing) {
            console.log('[TMC] Refresh in progress, queuing...');
            return new Promise((resolve, reject) => {
                failedQueue.push({ resolve, reject });
            });
        }

        isRefreshing = true;
        console.log('[TMC] Refresh lock acquired');

        const urlsToTry = [...API_URLS];
        if (ACTIVE_API_URL && urlsToTry.includes(ACTIVE_API_URL)) {
            urlsToTry.splice(urlsToTry.indexOf(ACTIVE_API_URL), 1);
            urlsToTry.unshift(ACTIVE_API_URL);
        }

        for (const url of urlsToTry) {
            try {
                const refreshUrl = `${url}/v2/account/session/refresh`;
                console.log(`[TMC] Trying refresh at: ${refreshUrl}`);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');

                const response = await fetch(refreshUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'SteamVR 1.88.1.3421_a3df6ce5',
                        'Authorization': serverKeyAuth
                    },
                    body: JSON.stringify({ token: refreshTk }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.includes('application/json')) {
                    console.log(`[TMC] ${url} - Not JSON response`);
                    continue;
                }

                const data = await response.json();
                console.log(`[TMC] Response:`, JSON.stringify(data).substring(0, 300));

                let newBearer = null;
                let newRefresh = null;

                if (data.token) {
                    newBearer = data.token;
                    newRefresh = data.refresh_token || refreshTk;
                } else if (data.access_token) {
                    newBearer = data.access_token;
                    newRefresh = data.refresh_token || refreshTk;
                } else if (data.bearer) {
                    newBearer = data.bearer;
                    newRefresh = data.refresh_token || refreshTk;
                }

                if (response.status === 200 && newBearer) {
                    const newExpiry = getTokenExpiryMs(newBearer);
                    
                    if (newBearer === refreshTk) {
                        console.log(`[TMC] ${url} - Refresh returned SAME token, skipping`);
                        continue;
                    }

                    if (newExpiry <= Date.now()) {
                        console.log(`[TMC] ${url} - Refreshed token already expired`);
                        continue;
                    }

                    console.log(`[TMC] Successfully refreshed token via ${url}!`);
                    console.log(`[TMC] New Bearer: ${newBearer.substring(0, 50)}...`);
                    console.log(`[TMC] New Refresh: ${newRefresh.substring(0, 50)}...`);
                    console.log(`[TMC] ${humanExpiry(newExpiry)}`);

                    DEFAULT_TOKEN.bearer = newBearer;
                    DEFAULT_TOKEN.refresh_token = newRefresh;
                    ACTIVE_API_URL = url;
                    apiWorking = true;

                    if (tokenStock.length > 0) {
                        const oldToken = tokenStock[0];
                        tokenStock[0] = {
                            bearer: newBearer,
                            refresh: newRefresh,
                            addedAt: Date.now(),
                            expiresAt: newExpiry,
                            id: oldToken.id,
                            userId: oldToken.userId,
                            username: oldToken.username
                        };
                    } else {
                        tokenStock.push({
                            bearer: newBearer,
                            refresh: newRefresh,
                            addedAt: Date.now(),
                            expiresAt: newExpiry,
                            id: '',
                            userId: 'system',
                            username: 'System'
                        });
                    }

                    const result = { 
                        success: true, 
                        bearer: newBearer, 
                        refresh: newRefresh, 
                        expiresAt: newExpiry,
                        newToken: true
                    };
                    processQueue(null, result);
                    isRefreshing = false;
                    console.log('[TMC] Refresh lock released');
                    return result;
                } else {
                    console.log(`[TMC] ${url} - Status: ${response.status}`, data);
                }
            } catch (err) {
                console.log(`[TMC] ${url} - ${err.message}`);
            }
        }

        console.log('[TMC] All refresh URLs failed');
        if (tokenStock.length > 0) {
            tokenStock[0].expiresAt = getTokenExpiryMs(tokenStock[0].bearer);
        }

        processQueue(new Error('All refresh URLs failed'), null);
        isRefreshing = false;
        return { success: false, error: 'All refresh URLs failed' };
    } catch (err) {
        console.error('[TMC] Refresh error:', err.message);
        processQueue(err, null);
        isRefreshing = false;
        return { success: false, error: err.message };
    }
}

// --- REFRESH SPECIFIC TOKEN (by bearer + refresh input) ---
async function refreshSpecificToken(bearerInput, refreshInput) {
    // Validate inputs are real JWTs before hitting the API
    if (!isValidJwt(refreshInput)) {
        return { success: false, error: 'Invalid refresh token format.' };
    }
    try {
        console.log('[TMC] Refreshing specific token...');

        const refreshUrl = `${ACTIVE_API_URL}/v2/account/session/refresh`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');

        const response = await fetch(refreshUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'SteamVR 1.88.1.3421_a3df6ce5',
                'Authorization': serverKeyAuth
            },
            body: JSON.stringify({ token: refreshInput }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            return { success: false, error: 'Server returned non-JSON response' };
        }

        const data = await response.json();

        let newBearer = null;
        let newRefresh = null;

        if (data.token) {
            newBearer = data.token;
            newRefresh = data.refresh_token || refreshInput;
        } else if (data.access_token) {
            newBearer = data.access_token;
            newRefresh = data.refresh_token || refreshInput;
        } else if (data.bearer) {
            newBearer = data.bearer;
            newRefresh = data.refresh_token || refreshInput;
        }

        if (response.status === 200 && newBearer) {
            const newExpiry = getTokenExpiryMs(newBearer);

            if (newBearer === refreshInput) {
                return { success: false, error: 'Server returned the same token. Token may not be refreshable yet.' };
            }

            if (newExpiry <= Date.now()) {
                return { success: false, error: 'Refreshed token is already expired.' };
            }

            // Update stock - replace or add
            if (tokenStock.length > 0) {
                tokenStock[0] = {
                    bearer: newBearer,
                    refresh: newRefresh,
                    addedAt: Date.now(),
                    expiresAt: newExpiry,
                    id: tokenStock[0].id,
                    userId: tokenStock[0].userId,
                    username: tokenStock[0].username
                };
            } else {
                tokenStock.push({
                    bearer: newBearer,
                    refresh: newRefresh,
                    addedAt: Date.now(),
                    expiresAt: newExpiry,
                    id: '',
                    userId: 'system',
                    username: 'System'
                });
            }

            DEFAULT_TOKEN.bearer = newBearer;
            DEFAULT_TOKEN.refresh_token = newRefresh;

            console.log(`[TMC] Specific token refreshed! ${humanExpiry(newExpiry)}`);
            return {
                success: true,
                bearer: newBearer,
                refresh: newRefresh,
                expiresAt: newExpiry
            };
        } else {
            const errMsg = data.message || data.error || JSON.stringify(data);
            return { success: false, error: `Status ${response.status}: ${errMsg}` };
        }
    } catch (err) {
        console.error('[TMC] Specific refresh error:', err.message);
        return { success: false, error: err.message };
    }
}

// --- GENERATE TOKEN FROM DEVICE AUTH ---
async function generateTokenFromDevice(deviceToken, deviceID) {
    // Validate inputs before hitting the API
    if (!isValidJwt(deviceToken)) {
        return { success: false, error: 'Invalid device token format.' };
    }
    if (!isAllowedStringInput(deviceID, 200)) {
        return { success: false, error: 'Invalid device ID format.' };
    }
    try {
        console.log('[TMC] Generating token from device auth...');

        const authUrl = `${ACTIVE_API_URL}/v2/account/authenticate/device`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');

        const body = {
            token: deviceToken,
            vars: {
                clientUserAgent: "SteamVR 1.88.1.3421_a3df6ce5",
                deviceID: deviceID
            }
        };

        const response = await fetch(`${authUrl}?create=true&sync=false`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
                'Connection': 'keep-alive',
                'Accept': '*/*',
                'Accept-Encoding': 'deflate, gzip',
                'Authorization': serverKeyAuth
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            return { success: false, error: 'Server returned non-JSON response' };
        }

        const data = await response.json();
        console.log(`[TMC] Device auth response:`, JSON.stringify(data).substring(0, 300));

        let newBearer = null;
        let newRefresh = null;

        if (data.token) {
            newBearer = data.token;
            newRefresh = data.refresh_token || null;
        } else if (data.access_token) {
            newBearer = data.access_token;
            newRefresh = data.refresh_token || null;
        } else if (data.bearer) {
            newBearer = data.bearer;
            newRefresh = data.refresh_token || null;
        }

        if (response.status === 200 && newBearer) {
            const newExpiry = getTokenExpiryMs(newBearer);

            // Add to stock
            tokenStock.push({
                bearer: newBearer,
                refresh: newRefresh,
                addedAt: Date.now(),
                expiresAt: newExpiry,
                id: '',
                userId: 'device_auth',
                username: 'DeviceAuth'
            });

            // Update default
            DEFAULT_TOKEN.bearer = newBearer;
            if (newRefresh) DEFAULT_TOKEN.refresh_token = newRefresh;

            console.log(`[TMC] Device auth token generated! ${humanExpiry(newExpiry)}`);
            return {
                success: true,
                bearer: newBearer,
                refresh: newRefresh,
                expiresAt: newExpiry
            };
        } else {
            const errMsg = data.message || data.error || JSON.stringify(data);
            return { success: false, error: `Status ${response.status}: ${errMsg}` };
        }
    } catch (err) {
        console.error('[TMC] Device auth error:', err.message);
        return { success: false, error: err.message };
    }
}

// --- REFRESH TOKEN IN STOCK ---
async function refreshTokenInStock() {
    if (tokenStock.length === 0) {
        tokenStock.push({
            bearer: DEFAULT_TOKEN.bearer,
            refresh: DEFAULT_TOKEN.refresh_token,
            addedAt: Date.now(),
            expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
        });
        return;
    }
    const tokenObj = tokenStock[0];
    if (!tokenObj.refresh) return;
    try {
        const refreshResult = await refreshToken(tokenObj.refresh);
        if (refreshResult.success) {
            console.log('[TMC] Token refreshed');
        }
    } catch (err) {}
}

// --- AUTO-REFRESH (1-MINUTE INTERVAL) ---
function scheduleNextRefresh() {
    if (refreshInterval) clearTimeout(refreshInterval);
    const delay = 1 * 60 * 1000;
    refreshInterval = setTimeout(async () => {
        refreshInterval = null;
        if (isRefreshing) { scheduleNextRefresh(); return; }
        if (!apiWorking) await findWorkingApiUrl();
        await refreshTokenInStock();
        scheduleNextRefresh();
    }, delay);
}

function startAutoRefresh() {
    console.log('[TMC] Auto-refresh every 1 minute');
    isRefreshing = false;
    failedQueue = [];
    setTimeout(async () => {
        await findWorkingApiUrl();
        await refreshTokenInStock();
        scheduleNextRefresh();
    }, 5000);
}

// --- REFRESH ALL TOKENS HELPER ---
async function refreshAllTokens() {
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < tokenStock.length; i++) {
        const item = tokenStock[i];
        if (!item.refresh) {
            failCount++;
            continue;
        }
        try {
            const res = await refreshToken(item.refresh);
            if (res && res.success) {
                tokenStock[i].bearer = res.bearer;
                tokenStock[i].refresh = res.refresh;
                tokenStock[i].expiresAt = res.expiresAt;
                successCount++;
            } else {
                failCount++;
            }
        } catch (e) {
            failCount++;
        }
    }
    return { successCount, failCount };
}

// --- GENERATE TOKEN (give to user) ---
async function processTokenGeneration(interaction) {
    const userId = interaction.user.id;
    const member = interaction.member;
    
    await interaction.deferReply({ flags: 64 });
    
    const hasNoCooldown = member && member.roles && member.roles.cache.has(NO_COOLDOWN_ROLE_ID);
    
    if (!hasNoCooldown) {
        const cooldownKey = `public_${userId}`;
        if (cooldowns.has(cooldownKey)) {
            const cooldownEnd = cooldowns.get(cooldownKey);
            if (Date.now() < cooldownEnd) {
                const remaining = cooldownEnd - Date.now();
                const minutes = Math.floor(remaining / 60000);
                const seconds = Math.floor((remaining % 60000) / 1000);
                return interaction.editReply({
                    content: `Please wait ${minutes}m ${seconds}s`
                });
            }
        }
    }
    
    if (activeGenerations.has(userId)) {
        const startTime = activeGenerations.get(userId);
        if (Date.now() - startTime < 60000) {
            return interaction.editReply({ content: 'Please wait...' });
        } else {
            activeGenerations.delete(userId);
        }
    }
    
    activeGenerations.set(userId, Date.now());
    
    try {
        await interaction.editReply({ content: 'Generating...' });
        
        if (tokenStock.length === 0) {
            tokenStock.push({
                bearer: DEFAULT_TOKEN.bearer,
                refresh: DEFAULT_TOKEN.refresh_token,
                addedAt: Date.now(),
                expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
            });
        }
        
        let tokenObj = tokenStock[0];
        const refreshResult = await refreshToken(tokenObj.refresh);
        if (refreshResult.success && refreshResult.newToken) {
            tokenObj = tokenStock[0];
        }
        
        const validationResult = await validateSteamToken(tokenObj.bearer);
        if (validationResult.expiresAt) tokenObj.expiresAt = validationResult.expiresAt;
        
        tokenObj.userId = interaction.user.id;
        tokenObj.username = interaction.user.tag;
        
        tokenStock.shift();
        tokenStock.push(tokenObj);
        
        if (!hasNoCooldown) {
            cooldowns.set(`public_${userId}`, Date.now() + 5 * 60 * 1000);
        }
        
        const expiryText = humanExpiry(tokenObj.expiresAt);
        const tokenExpired = Date.now() >= tokenObj.expiresAt;

        const tokenData = {
            token: {
                bearer: tokenObj.bearer,
                refresh_token: tokenObj.refresh
            }
        };
        
        const jsonString = JSON.stringify(tokenData, null, 2);
        const jsonBuffer = Buffer.from(jsonString, 'utf-8');
        const attachment = new AttachmentBuilder(jsonBuffer, { name: 'token.json' });
        
        const embed = new EmbedBuilder()
            .setDescription(
                `Token generated!\n\n` +
                `token.json attached\n\n` +
                `Status: **${expiryText}**`
            )
            .setColor(tokenExpired ? 0xED4245 : 0x2ECC71)
            .setFooter({ text: `TMC Gen` });
        
        try {
            await interaction.user.send({ embeds: [embed], files: [attachment] });
            activeGenerations.delete(userId);
            return interaction.editReply({ content: `Token sent!\n${expiryText}` });
        } catch (err) {
            activeGenerations.delete(userId);
            const fallbackEmbed = new EmbedBuilder()
                .setDescription(
                    `Could not send DM!\n\n` +
                    `token.json attached\n\n` +
                    `Status: **${expiryText}**`
                )
                .setColor(0xFEE75C)
                .setFooter({ text: `TMC Gen` });
            
            return interaction.editReply({
                embeds: [fallbackEmbed],
                files: [attachment],
                content: 'Token sent here (DMs closed)'
            });
        }
    } catch (err) {
        console.error('[TMC] Error:', err);
        activeGenerations.delete(userId);
        return interaction.editReply({ content: 'Error. Try again.' });
    }
}

// --- REFRESH BUTTON HANDLER (opens modal) ---
async function handleRefreshButton(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('refresh_modal')
        .setTitle('Refresh Token');

    const bearerInput = new TextInputBuilder()
        .setCustomId('refresh_bearer_input')
        .setLabel("PASTE YOUR BEARER TOKEN")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(2000);

    const refreshInput = new TextInputBuilder()
        .setCustomId('refresh_refresh_input')
        .setLabel("PASTE YOUR REFRESH TOKEN")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(2000);

    modal.addComponents(
        new ActionRowBuilder().addComponents(bearerInput),
        new ActionRowBuilder().addComponents(refreshInput)
    );
    return await interaction.showModal(modal);
}

// --- REFRESH MODAL SUBMIT HANDLER ---
async function processRefreshModal(interaction) {
    await interaction.deferReply({ flags: 64 });

    try {
        const bearerInput = interaction.fields.getTextInputValue('refresh_bearer_input').trim();
        const refreshInput = interaction.fields.getTextInputValue('refresh_refresh_input').trim();

        if (!bearerInput || !refreshInput) {
            return interaction.editReply({ content: 'Both bearer and refresh token are required.' });
        }

        // Validate JWT format
        if (!isValidJwt(bearerInput)) {
            return interaction.editReply({ content: 'Invalid bearer token format. Must be a valid JWT.' });
        }
        if (!isValidJwt(refreshInput)) {
            return interaction.editReply({ content: 'Invalid refresh token format. Must be a valid JWT.' });
        }

        await interaction.editReply({ content: 'Refreshing with provided tokens...' });

        const result = await refreshSpecificToken(bearerInput, refreshInput);

        if (result.success) {
            const expiryText = humanExpiry(result.expiresAt);

            const embed = new EmbedBuilder()
                .setDescription(
                    `Token refreshed successfully!\n\n` +
                    `**New Bearer:** \`${result.bearer.substring(0, 60)}...\`\n` +
                    `**New Refresh:** \`${result.refresh.substring(0, 60)}...\`\n\n` +
                    `Status: **${expiryText}**\n` +
                    `Stock: **${tokenStock.length}** token(s)`
                )
                .setColor(0x2ECC71)
                .setFooter({ text: `TMC Gen` });

            // Also send new tokens as JSON file
            const tokenData = {
                token: {
                    bearer: result.bearer,
                    refresh_token: result.refresh
                }
            };
            const jsonBuffer = Buffer.from(JSON.stringify(tokenData, null, 2), 'utf-8');
            const attachment = new AttachmentBuilder(jsonBuffer, { name: 'refreshed_token.json' });

            return interaction.editReply({ embeds: [embed], files: [attachment] });
        } else {
            return interaction.editReply({
                content: `Failed to refresh token.\n\nError: ${result.error}\n\nMake sure your bearer and refresh tokens are valid and from the same session.`
            });
        }
    } catch (err) {
        console.error('[TMC] Refresh modal error:', err);
        return interaction.editReply({ content: 'Error refreshing token. Try again.' });
    }
}

// --- DEVICE AUTH GENERATOR (opens modal) ---
async function handleDeviceGenButton(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('device_gen_modal')
        .setTitle('Generate Token (Device Auth)');

    const deviceTokenInput = new TextInputBuilder()
        .setCustomId('device_token_input')
        .setLabel("DEVICE TOKEN")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Paste the full device authentication token...")
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(2000);

    const deviceIDInput = new TextInputBuilder()
        .setCustomId('device_id_input')
        .setLabel("DEVICE ID")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 1835761c2a8b6c629b9ff9edff289d7f3ea128")
        .setRequired(true)
        .setMinLength(5)
        .setMaxLength(200);

    modal.addComponents(
        new ActionRowBuilder().addComponents(deviceTokenInput),
        new ActionRowBuilder().addComponents(deviceIDInput)
    );
    return await interaction.showModal(modal);
}

// --- DEVICE AUTH MODAL SUBMIT ---
async function processDeviceGenModal(interaction) {
    await interaction.deferReply({ flags: 64 });

    try {
        const deviceToken = interaction.fields.getTextInputValue('device_token_input').trim();
        const deviceID = interaction.fields.getTextInputValue('device_id_input').trim();

        if (!deviceToken || !deviceID) {
            return interaction.editReply({ content: 'Both device token and device ID are required.' });
        }

        // Validate device token is a proper JWT
        if (!isValidJwt(deviceToken)) {
            return interaction.editReply({ content: 'Invalid device token. Must be a valid JWT.' });
        }

        // Validate device ID is a reasonable hex-like string (not garbage)
        if (!isAllowedStringInput(deviceID, 200)) {
            return interaction.editReply({ content: 'Invalid device ID format.' });
        }

        await interaction.editReply({ content: 'Generating token via device auth...' });

        const result = await generateTokenFromDevice(deviceToken, deviceID);

        if (result.success) {
            const expiryText = humanExpiry(result.expiresAt);

            const embed = new EmbedBuilder()
                .setDescription(
                    `Token generated via device auth!\n\n` +
                    `**Bearer:** \`${result.bearer.substring(0, 60)}...\`\n` +
                    (result.refresh ? `**Refresh:** \`${result.refresh.substring(0, 60)}...\`\n\n` : '\n') +
                    `Status: **${expiryText}**\n` +
                    `Stock: **${tokenStock.length}** token(s)`
                )
                .setColor(0x2ECC71)
                .setFooter({ text: `TMC Gen` });

            const tokenData = {
                token: {
                    bearer: result.bearer,
                    refresh_token: result.refresh
                }
            };
            const jsonBuffer = Buffer.from(JSON.stringify(tokenData, null, 2), 'utf-8');
            const attachment = new AttachmentBuilder(jsonBuffer, { name: 'generated_token.json' });

            try {
                await interaction.user.send({ embeds: [embed], files: [attachment] });
                return interaction.editReply({ content: `Token generated and sent via DM!\n${expiryText}` });
            } catch (dmErr) {
                return interaction.editReply({ embeds: [embed], files: [attachment], content: 'Token generated (DMs closed, sent here)' });
            }
        } else {
            return interaction.editReply({ content: `Failed to generate token.\n\nError: ${result.error}` });
        }
    } catch (err) {
        console.error('[TMC] Device gen error:', err);
        return interaction.editReply({ content: 'Error generating token. Try again.' });
    }
}

// --- SLASH COMMANDS ---
const commandsData = [
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Add token stock (bearer + refresh)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('Token Generator panel'),
    new SlashCommandBuilder()
        .setName('refreshall')
        .setDescription('Refresh all tokens in stock pool')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('stockcheck')
        .setDescription('Check current token stock status'),
].map(cmd => cmd.toJSON());

// --- READY ---
client.once('ready', async () => {
    console.log(`[TMC] ONLINE: ${client.user.tag}`);
    console.log(`[TMC] Connected to ${client.guilds.cache.size} server(s)`);

    tokenStock = [{
        bearer: DEFAULT_TOKEN.bearer,
        refresh: DEFAULT_TOKEN.refresh_token,
        addedAt: Date.now(),
        expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
    }];

    await findWorkingApiUrl();
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commandsData });
        console.log('[TMC] Commands registered');
    } catch (error) {
        console.error('[TMC] Failed to register commands:', error);
    }
    startAutoRefresh();

    // Guild lock sweep - leave any unauthorized servers on startup
    client.guilds.cache.forEach(async (guild) => {
        if (guild.id !== ALLOWED_GUILD_ID) {
            console.log(`[TMC] Leaving unauthorized server on startup: ${guild.name} (${guild.id})`);
            try {
                await guild.leave();
            } catch (err) {
                console.error(`[TMC] Failed to leave ${guild.id}:`, err);
            }
        }
    });

    console.log('[TMC] Bot ready!');
});

// --- GUILD LOCK (only allow YOUR server) ---
client.on('guildCreate', async guild => {
    if (guild.id !== ALLOWED_GUILD_ID) {
        console.log(`[TMC] Unauthorized server detected: ${guild.name} (${guild.id}) — leaving.`);
        try {
            await guild.leave();
        } catch (err) {
            console.error('[TMC] Failed to leave unauthorized server:', err);
        }
    }
});

// --- ERROR HANDLING ---
client.on('error', err => console.error('[TMC] Client error:', err));
client.on('disconnect', () => console.log('[TMC] Disconnected, reconnecting...'));

// --- INTERACTIONS ---
client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            if (commandName === 'dashboard') {
                const embed = new EmbedBuilder()
                    .setDescription(`**TMC Gen**\n\nGenerate, refresh, and manage your tokens.`)
                    .setColor(0x5865F2)
                    .setFooter({ text: `TMC Gen` });

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('gen_public')
                        .setLabel('Gen Token')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🔑')
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('refresh_token_btn')
                        .setLabel('Refresh Token')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🔄')
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('device_gen_btn')
                        .setLabel('Device Auth Gen')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('⚙️')
                );

                return interaction.reply({ embeds: [embed], components: [row1, row2, row3] });
            }

            if (commandName === 'stock') {
                const modal = new ModalBuilder()
                    .setCustomId('stock_modal')
                    .setTitle('Add Token Stock');

                const bearerInput = new TextInputBuilder()
                    .setCustomId('stock_bearer_input')
                    .setLabel("ENTER BEARER TOKEN")
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(2000);

                const refreshInput = new TextInputBuilder()
                    .setCustomId('stock_refresh_input')
                    .setLabel("ENTER REFRESH TOKEN")
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(2000);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(bearerInput),
                    new ActionRowBuilder().addComponents(refreshInput)
                );
                return await interaction.showModal(modal);
            }

            if (commandName === 'refreshall') {
                await interaction.deferReply({ flags: 64 });
                if (tokenStock.length === 0) {
                    return interaction.editReply({ content: 'No tokens in stock to refresh.' });
                }
                
                await interaction.editReply({ content: `Refreshing all ${tokenStock.length} tokens...` });
                const { successCount, failCount } = await refreshAllTokens();
                
                return interaction.editReply({ 
                    content: `Refresh complete!\n- Successful: **${successCount}**\n- Failed: **${failCount}**\n- Total Stock: **${tokenStock.length}**` 
                });
            }

            if (commandName === 'stockcheck') {
                await interaction.deferReply({ flags: 64 });
                
                if (tokenStock.length === 0) {
                    return interaction.editReply({ content: 'Stock is empty.' });
                }

                let description = '';
                for (let i = 0; i < Math.min(tokenStock.length, 10); i++) {
                    const t = tokenStock[i];
                    const expiry = humanExpiry(t.expiresAt);
                    const isExpired = Date.now() >= t.expiresAt;
                    description += `**#${i + 1}** ${isExpired ? 'EXPIRED' : expiry}`;
                    if (t.username) description += ` | ${t.username}`;
                    description += '\n';
                }

                if (tokenStock.length > 10) {
                    description += `\n...and ${tokenStock.length - 10} more`;
                }

                const embed = new EmbedBuilder()
                    .setTitle('Token Stock')
                    .setDescription(description)
                    .setColor(0x5865F2)
                    .setFooter({ text: `Total: ${tokenStock.length} | Auto-refresh: ON` });

                return interaction.editReply({ embeds: [embed] });
            }
        }

        // --- BUTTON HANDLERS ---
        if (interaction.isButton()) {
            if (interaction.customId === 'gen_public') {
                return await processTokenGeneration(interaction);
            }
            
            if (interaction.customId === 'refresh_token_btn') {
                return await handleRefreshButton(interaction);
            }

            if (interaction.customId === 'device_gen_btn') {
                return await handleDeviceGenButton(interaction);
            }
        }

        // --- MODAL SUBMISSIONS ---
        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'stock_modal') {
                await interaction.deferReply({ flags: 64 });
                const bearer = interaction.fields.getTextInputValue('stock_bearer_input').trim();
                const refresh = interaction.fields.getTextInputValue('stock_refresh_input').trim();
                
                if (!bearer || !refresh) {
                    return interaction.editReply({ content: 'Both tokens required.' });
                }

                // Validate JWT format
                if (!isValidJwt(bearer)) {
                    return interaction.editReply({ content: 'Invalid bearer token. Must be a valid JWT.' });
                }
                if (!isValidJwt(refresh)) {
                    return interaction.editReply({ content: 'Invalid refresh token. Must be a valid JWT.' });
                }
                
                tokenStock.push({
                    bearer, refresh,
                    addedAt: Date.now(),
                    expiresAt: getTokenExpiryMs(bearer)
                });

                return interaction.editReply({ content: `Token added! Total: \`${tokenStock.length}\`` });
            }

            if (interaction.customId === 'refresh_modal') {
                return await processRefreshModal(interaction);
            }

            if (interaction.customId === 'device_gen_modal') {
                return await processDeviceGenModal(interaction);
            }
        }
    } catch (err) {
        console.error(`[TMC] Error:`, err);
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: "Error. Try again.", flags: 64 }).catch(() => {});
        }
    }
});

// --- HTTP SERVER ---
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            bot: client.user ? 'online' : 'offline', 
            stock: tokenStock.length,
            timestamp: Date.now() 
        }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`[TMC] HTTP server on port ${PORT}`));
server.on('error', err => console.error('[TMC] Server error:', err));

// --- LOGIN ---
console.log('[TMC] Logging in...');

if (!process.env.DISCORD_TOKEN) {
    console.error('[TMC] DISCORD_TOKEN not set!');
} else {
    console.log(`[TMC] Token set (length: ${process.env.DISCORD_TOKEN.length})`);
    client.login(process.env.DISCORD_TOKEN).catch(err => {
        console.error('[TMC] Login failed:', err.message);
        setTimeout(() => {
            console.log('[TMC] Retrying login...');
            client.login(process.env.DISCORD_TOKEN).catch(() => {});
        }, 5000);
    });
}

// --- KEEP BOT ALIVE & ERROR HANDLING ---
process.stdin.resume();

process.on('unhandledRejection', (reason) => {
    console.error('[TMC] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[TMC] Uncaught Exception:', err);
});

setInterval(() => {
    console.log('[TMC] Bot is alive...');
}, 45000);

client.on('disconnect', () => {
    console.log('[TMC] Disconnected! Reconnecting in 3 seconds...');
    setTimeout(() => {
        client.login(process.env.DISCORD_TOKEN).catch(() => {});
    }, 3000);
});

client.on('resume', () => console.log('[TMC] Connection resumed'));
client.on('reconnecting', () => console.log('[TMC] Reconnecting...'));
client.on('rateLimit', (info) => console.log(`[TMC] Rate limit hit: ${info.timeout}ms`));

// External URL self-ping loop
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
        fetch(`${RENDER_EXTERNAL_URL}/health`).catch(() => {});
    }, 14 * 60 * 1000);
    console.log(`[TMC] Keep-alive active targeting: ${RENDER_EXTERNAL_URL}`);
}
