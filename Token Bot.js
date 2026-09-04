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

// --- DNS FIX FOR RENDER ---
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
console.log('[TMC] ✅ DNS set to Google DNS (8.8.8.8, 1.1.1.1)');

// --- CREATE CLIENT WITH PROPER INTENTS ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    rest: {
        timeout: 60000
    },
    failIfNotExists: false
});

// --- API CONFIGURATION ---
const NAKAMA_SERVER = 'https://animalcompany.us-east1.nakamacloud.io';
const NAKAMA_SERVER_KEY = '6URuTSlDKKfYbuDW';
const API_URLS = [ NAKAMA_SERVER ];

let ACTIVE_API_URL = API_URLS[0];
let apiWorking = false;

// --- Token refresh queue system ---
let isRefreshing = false;
let failedQueue = [];
let refreshAttempts = 0;
const MAX_REFRESH_ATTEMPTS = 10;

function processQueue(error, token = null) {
    failedQueue.forEach(prom => {
        if (error) {
            prom.reject(error);
        } else {
            prom.resolve(token);
        }
    });
    failedQueue = [];
}

// --- DEFAULT TOKEN ---
let DEFAULT_TOKEN = {
  "bearer": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiIwMmVhYTg4OC1jNzcwLTQwMjQtODZiMy02NTU4Mzk3YmQwZjQiLCJ1aWQiOiJlNDY4MzE4Ny02ZTRlLTQzMmItOTQ2My0wNjNlYzI5NDZhMmMiLCJ1c24iOiJTMURFVnhpS0FkZzlVYW12IiwidnJzIjp7ImF1dGhJRCI6IjMxNzk1ZjE4NTViMTQ2NmZiODVkNzRmNDY0M2M5MTgzIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiAxLjg4LjEuMzQyMV9hM2RmNmNlNSIsImRldmljZUlEIjoiNmU5NjZhYzcwMTAxOGUxN2NkYzNmNjA4ODQ4ODA2MTgwNjYxMjhiZiJ9LCJleHAiOjE3ODgwNDY3MjMsImlhdCI6MTc4ODA0MzEyM30.yZCYRNpoQE4jNV3Hf4_RgKkArXy2yZva20nOCXnQ9tA",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiIwMmVhYTg4OC1jNzcwLTQwMjQtODZiMy02NTU4Mzk3YmQwZjQiLCJ1aWQiOiJlNDY4MzE4Ny02ZTRlLTQzMmItOTQ2My0wNjNlYzI5NDZhMmMiLCJ1c24iOiJTMURFVnhpS0FkZzlVYW12IiwidnJzIjp7ImF1dGhJRCI6IjMxNzk1ZjE4NTViMTQ2NmZiODVkNzRmNDY0M2M5MTgzIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiAxLjg4LjEuMzQyMV9hM2RmNmNlNSIsImRldmljZUlEIjoiNmU5NjZhYzcwMTAxOGUxN2NkYzNmNjA4ODQ4ODA2MTgwNjYxMjhiZiJ9LCJleHAiOjE3ODgwNjQ3MjMsImlhdCI6MTc4ODA0MzEyM30.H3Ygt1bcOBx4Vm_0y5bdpL6vRtxqVAl0QeXDjdqfzTs"
};

let tokenStock = [];
const activeGenerations = new Map();
let refreshInterval = null;

// --- JWT / EXPIRY HELPERS ---
function decodeJwt(token) {
    try {
        const part = (token || '').split('.')[1];
        if (!part) return null;
        const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
        const json = Buffer.from(normalized + '===', 'base64').toString('utf-8');
        return JSON.parse(json);
    } catch (e) {
        return null;
    }
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

function isTokenExpired(tokenObj) {
    if (!tokenObj || !tokenObj.bearer) return true;
    return Date.now() >= getTokenExpiryMs(tokenObj.bearer);
}

// --- EXTRACT DEVICE ID FROM JWT ---
function extractDeviceIdFromToken(bearerToken) {
    try {
        const payload = decodeJwt(bearerToken);
        if (!payload) return null;

        // device ID lives in vrs.deviceID
        if (payload.vrs && payload.vrs.deviceID) {
            return payload.vrs.deviceID;
        }

        // fallback: some tokens embed it differently
        if (payload.device_id) return payload.device_id;

        return null;
    } catch (e) {
        return null;
    }
}

// --- EXTRACT USERNAME FROM JWT ---
function extractUsernameFromToken(bearerToken) {
    try {
        const payload = decodeJwt(bearerToken);
        if (!payload) return 'Unknown';
        return payload.un || payload.username || payload.usn || 'Unknown';
    } catch (e) {
        return 'Unknown';
    }
}

// --- NAKAMA ACCOUNT FETCH (GET /v2/account with bearer) ---
async function fetchAccountFromNakama(bearerToken, apiUrl) {
    const url = apiUrl || ACTIVE_API_URL;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        console.log(`[TMC] 📡 AccountFetch GET ${url}/v2/account`);

        const response = await fetch(`${url}/v2/account`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${bearerToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'SteamVR 1.88.1.3421_a3df6ce5'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        console.log(`[TMC] 📡 AccountFetch response: HTTP ${response.status}`);

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.log(`[TMC] 📡 AccountFetch non-JSON: ${text.substring(0, 300)}`);
            return { valid: false, status: response.status, error: `HTTP ${response.status} - Non-JSON: ${text.substring(0, 150)}` };
        }

        const data = await response.json();

        if (response.status === 200 && data) {
            return {
                valid: true,
                status: 200,
                username: data.username || 'Unknown',
                userId: data.user_id || data.id || '',
                wallet: data.wallet || {},
                devices: data.devices || [],
                customId: data.custom_id || '',
                steamId: data.steam_id || '',
                createdAt: data.created_at || 0,
                updatedAt: data.updated_at || 0
            };
        } else {
            console.log(`[TMC] 📡 AccountFetch error body: ${JSON.stringify(data).substring(0, 300)}`);
            return { valid: false, status: response.status, error: `HTTP ${response.status}: ${JSON.stringify(data).substring(0, 150)}` };
        }
    } catch (err) {
        console.log(`[TMC] 📡 AccountFetch exception: ${err.message}`);
        return { valid: false, status: 0, error: err.message };
    }
}

// --- NAKAMA SESSION REFRESH (POST /v2/account/session/refresh) ---
async function nakamaRefreshSession(refreshTokenValue, apiUrl) {
    const url = apiUrl || ACTIVE_API_URL;
    try {
        const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        // Nakama ApiSessionRefreshRequest: { token, vars }
        const body = JSON.stringify({ token: refreshTokenValue });

        console.log(`[TMC] 🔄 Refresh POST ${url}/v2/account/session/refresh`);

        const response = await fetch(`${url}/v2/account/session/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': serverKeyAuth,
                'User-Agent': 'SteamVR 1.88.1.3421_a3df6ce5'
            },
            body: body,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        console.log(`[TMC] 🔄 Refresh response: HTTP ${response.status}`);

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.log(`[TMC] 🔄 Refresh non-JSON body: ${text.substring(0, 300)}`);
            return { success: false, error: `HTTP ${response.status} - Non-JSON: ${text.substring(0, 150)}` };
        }

        const data = await response.json();
        console.log(`[TMC] 🔄 Refresh data: ${JSON.stringify(data).substring(0, 300)}`);

        let newBearer = data.token || data.access_token || data.bearer || null;
        let newRefresh = data.refresh_token || refreshTokenValue;

        if ((response.status === 200 || response.status === 201) && newBearer) {
            const newExpiry = getTokenExpiryMs(newBearer);
            if (newExpiry <= Date.now()) {
                return { success: false, error: 'Refreshed token already expired' };
            }
            return { success: true, bearer: newBearer, refresh: newRefresh, expiresAt: newExpiry };
        } else {
            return { success: false, status: response.status, error: JSON.stringify(data).substring(0, 200) };
        }
    } catch (err) {
        console.log(`[TMC] 🔄 Refresh exception: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// --- NAKAMA DEVICE AUTH (POST /v2/account/session/authenticate/device) ---
// This creates a FRESH session using the device ID from the JWT.
// Works even when both bearer AND refresh tokens are fully expired.
async function nakamaDeviceAuth(deviceId, apiUrl) {
    const url = apiUrl || ACTIVE_API_URL;
    try {
        const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        // Nakama ApiAccountDevice: { id }
        const body = JSON.stringify({ id: deviceId });

        console.log(`[TMC] 🎮 DeviceAuth POST ${url}/v2/account/session/authenticate/device`);
        console.log(`[TMC] 🎮 Device ID: ${deviceId}`);

        const response = await fetch(`${url}/v2/account/session/authenticate/device`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': serverKeyAuth,
                'User-Agent': 'SteamVR 1.88.1.3421_a3df6ce5'
            },
            body: body,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        console.log(`[TMC] 🎮 DeviceAuth response: HTTP ${response.status}`);

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            console.log(`[TMC] 🎮 DeviceAuth non-JSON body: ${text.substring(0, 300)}`);
            return { success: false, error: `HTTP ${response.status} - Non-JSON: ${text.substring(0, 150)}` };
        }

        const data = await response.json();
        console.log(`[TMC] 🎮 DeviceAuth data: ${JSON.stringify(data).substring(0, 300)}`);

        if ((response.status === 200 || response.status === 201) && data) {
            const newBearer = data.token || data.access_token || null;
            const newRefresh = data.refresh_token || null;
            if (newBearer) {
                const newExpiry = getTokenExpiryMs(newBearer);
                console.log(`[TMC] ✅ Device auth successful! Session created`);
                return {
                    success: true,
                    bearer: newBearer,
                    refresh: newRefresh,
                    expiresAt: newExpiry,
                    created: data.created || false
                };
            }
            return { success: false, error: 'Response missing token', data: JSON.stringify(data).substring(0, 200) };
        } else {
            return { success: false, status: response.status, error: JSON.stringify(data).substring(0, 200) };
        }
    } catch (err) {
        console.log(`[TMC] 🎮 DeviceAuth exception: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// --- FULL 3-TIER LOGIN: bearer -> refresh -> device auth ---
async function fullLogin(tokenObj, label) {
    label = label || '[Login]';

    // === TIER 1: Try bearer token directly ===
    if (tokenObj.bearer) {
        const expired = Date.now() >= getTokenExpiryMs(tokenObj.bearer);
        if (!expired) {
            console.log(`${label} Tier 1: Bearer not expired, checking against Nakama...`);
            const accCheck = await fetchAccountFromNakama(tokenObj.bearer);
            if (accCheck.valid) {
                console.log(`${label} ✅ Tier 1 SUCCESS - Logged in as ${accCheck.username}`);
                tokenObj.accountInfo = accCheck;
                tokenObj.expiresAt = getTokenExpiryMs(tokenObj.bearer);
                return { success: true, method: 'bearer', account: accCheck };
            }
            console.log(`${label} ⚠️ Tier 1 Nakama rejected bearer: ${accCheck.error}`);
        } else {
            console.log(`${label} Tier 1: Bearer EXPIRED (${humanExpiry(getTokenExpiryMs(tokenObj.bearer))})`);
        }
    }

    // === TIER 2: Try refresh token ===
    if (tokenObj.refresh) {
        const refreshExpired = Date.now() >= getTokenExpiryMs(tokenObj.refresh);
        console.log(`${label} Tier 2: Attempting refresh... (refresh token ${refreshExpired ? 'EXPIRED' : 'valid'})`);
        const refreshResult = await nakamaRefreshSession(tokenObj.refresh);
        if (refreshResult.success) {
            tokenObj.bearer = refreshResult.bearer;
            tokenObj.refresh = refreshResult.refresh;
            tokenObj.expiresAt = refreshResult.expiresAt;
            console.log(`${label} ✅ Tier 2 SUCCESS - Refreshed, expires ${humanExpiry(refreshResult.expiresAt)}`);

            // Verify the new token works
            const accCheck = await fetchAccountFromNakama(refreshResult.bearer);
            if (accCheck.valid) {
                tokenObj.accountInfo = accCheck;
                console.log(`${label} 👤 ${accCheck.username} (${accCheck.userId})`);
                return { success: true, method: 'refresh', account: accCheck };
            }
            console.log(`${label} ⚠️ Refresh worked but account fetch failed: ${accCheck.error}`);
            return { success: true, method: 'refresh', account: null };
        } else {
            console.log(`${label} ❌ Tier 2 FAILED (HTTP ${refreshResult.status || 'N/A'}): ${refreshResult.error}`);
        }
    } else {
        console.log(`${label} ❌ No refresh token`);
    }

    // === TIER 3: Extract device ID and do fresh device auth ===
    // We can extract device ID from ANY old bearer (even expired ones)
    const deviceId = extractDeviceIdFromToken(tokenObj.bearer);
    if (deviceId) {
        console.log(`${label} Tier 3: Device auth with ID: ${deviceId}`);
        const deviceResult = await nakamaDeviceAuth(deviceId);
        if (deviceResult.success) {
            tokenObj.bearer = deviceResult.bearer;
            if (deviceResult.refresh) tokenObj.refresh = deviceResult.refresh;
            tokenObj.expiresAt = deviceResult.expiresAt;
            console.log(`${label} ✅ Tier 3 SUCCESS - Fresh session created!`);

            const accCheck = await fetchAccountFromNakama(deviceResult.bearer);
            if (accCheck.valid) {
                tokenObj.accountInfo = accCheck;
                console.log(`${label} 👤 ${accCheck.username} (${accCheck.userId})`);
                return { success: true, method: 'device_auth', account: accCheck };
            }
            return { success: true, method: 'device_auth', account: null };
        } else {
            console.log(`${label} ❌ Tier 3 FAILED (HTTP ${deviceResult.status || 'N/A'}): ${deviceResult.error}`);
        }
    } else {
        console.log(`${label} ❌ Could not extract device ID from token`);
    }

    console.log(`${label} 🔴 ALL 3 TIERS FAILED`);
    return { success: false, method: 'none', account: null };
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
    if (cleaned > 0) {
        console.log(`[TMC] Cleaned ${cleaned} stuck token generations`);
    }
}, 30000);

// --- FIND WORKING API URL ---
async function findWorkingApiUrl() {
    console.log('[TMC] Searching for working API URL...');
    
    for (const url of API_URLS) {
        try {
            console.log(`[TMC] Testing: ${url}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'SteamVR 1.88.1.3421_a3df6ce5'
                },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                console.log(`[TMC] ✅ Found working API: ${url}`);
                ACTIVE_API_URL = url;
                apiWorking = true;
                return url;
            } else {
                console.log(`[TMC] ❌ Not a JSON API: ${url}`);
            }
        } catch (err) {
            console.log(`[TMC] ❌ Failed: ${url} - ${err.message}`);
        }
    }
    
    console.log('[TMC] ⚠️ No working API URL found. Using fallback mode.');
    apiWorking = false;
    return API_URLS[0];
}

// --- TOKEN VALIDATION (local JWT check) ---
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

// --- LOGIN ALL TOKENS ON STARTUP ---
async function loginAllTokens() {
    console.log('[TMC] ================================');
    console.log('[TMC] 🔐 LOGGING IN ALL TOKENS...');
    console.log('[TMC] ================================');

    if (tokenStock.length === 0) {
        console.log('[TMC] No tokens in stock to login.');
        return;
    }

    let loggedIn = 0;
    let failed = 0;

    for (let i = 0; i < tokenStock.length; i++) {
        const tokenObj = tokenStock[i];
        const label = `[Token ${i + 1}/${tokenStock.length}]`;

        console.log(`[TMC] ${label} Processing...`);

        const result = await fullLogin(tokenObj, label);

        if (result.success) {
            loggedIn++;
        } else {
            failed++;
        }

        // Small delay between logins to not hammer the server
        if (i < tokenStock.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    console.log('[TMC] ================================');
    console.log(`[TMC] 🔐 Login complete! ${loggedIn} active / ${failed} failed / ${tokenStock.length} total`);
    console.log('[TMC] ================================');
}

// --- AUTO REFRESH / RE-AUTH TICK ---
async function autoRefreshTick() {
    console.log('[TMC] 🔄 Auto-refresh tick...');

    if (tokenStock.length === 0) {
        console.log('[TMC] Stock empty, adding default token...');
        tokenStock.push({
            bearer: DEFAULT_TOKEN.bearer,
            refresh: DEFAULT_TOKEN.refresh_token,
            addedAt: Date.now(),
            expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
        });
    }

    for (let i = 0; i < tokenStock.length; i++) {
        const tokenObj = tokenStock[i];
        const label = `[AutoRefresh ${i + 1}/${tokenStock.length}]`;
        const result = await fullLogin(tokenObj, label);

        if (result.success) {
            console.log(`${label} ✅ Refreshed/login OK via ${result.method}`);
        } else {
            console.log(`${label} ❌ Could not refresh/login`);
        }

        if (i < tokenStock.length - 1) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    console.log(`[TMC] Stock count: ${tokenStock.length}`);
}

// --- START AUTO-REFRESH ---
const REFRESH_BEFORE_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const MAX_REFRESH_MS = 30 * 60 * 1000;

function scheduleNextRefresh() {
    if (refreshInterval) {
        clearTimeout(refreshInterval);
        refreshInterval = null;
    }

    let delay = MAX_REFRESH_MS;

    if (tokenStock.length > 0) {
        const remaining = tokenStock[0].expiresAt - Date.now();
        const untilRefresh = remaining - REFRESH_BEFORE_MS;
        delay = Math.max(MIN_REFRESH_MS, Math.min(MAX_REFRESH_MS, untilRefresh));
        if (delay <= 0) delay = MIN_REFRESH_MS;
    }

    refreshInterval = setTimeout(async () => {
        refreshInterval = null;
        if (isRefreshing) {
            console.log('[TMC] Refresh already in progress, rescheduling...');
            scheduleNextRefresh();
            return;
        }
        isRefreshing = true;
        if (!apiWorking) {
            await findWorkingApiUrl();
        }
        await autoRefreshTick();
        isRefreshing = false;
        scheduleNextRefresh();
    }, delay);

    console.log(`[TMC] ⏱️ Next auto-refresh in ${Math.round(delay / 1000)}s`);
}

function startAutoRefresh() {
    console.log('[TMC] ================================');
    console.log('[TMC] 🔄 AUTO-REFRESH STARTED');
    console.log('[TMC] ⏳ Tokens refresh/re-auth BEFORE they expire!');
    console.log('[TMC] Tier 1: Bearer → Tier 2: Refresh → Tier 3: Device Auth');
    console.log('[TMC] ================================');

    isRefreshing = false;
    failedQueue = [];
    refreshAttempts = 0;

    setTimeout(async () => {
        await findWorkingApiUrl();
        await autoRefreshTick();
        scheduleNextRefresh();
    }, 5000);
}

// --- PROCESS TOKEN GENERATION - NO COOLDOWN ---
async function processTokenGeneration(interaction) {
    const userId = interaction.user.id;
    
    await interaction.deferReply({ flags: 64 });
    
    if (activeGenerations.has(userId)) {
        const startTime = activeGenerations.get(userId);
        if (Date.now() - startTime < 60000) {
            return interaction.editReply({ content: '⏳ Please wait...' });
        } else {
            activeGenerations.delete(userId);
        }
    }
    
    activeGenerations.set(userId, Date.now());
    
    await interaction.editReply({ content: '⏳ Generating...' });
    
    try {
        if (tokenStock.length === 0) {
            tokenStock.push({
                bearer: DEFAULT_TOKEN.bearer,
                refresh: DEFAULT_TOKEN.refresh_token,
                addedAt: Date.now(),
                expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
            });
        }
        
        let tokenObj = tokenStock[0];

        await interaction.editReply({ content: '⏳ Logging into Nakama...' });

        // Full 3-tier login on the token we're about to give out
        const loginResult = await fullLogin(tokenObj, '[Gen]');
        if (loginResult.success) {
            tokenObj = tokenStock[0];
        }

        await interaction.editReply({ content: '⏳ Finalizing...' });
        
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
        
        let accountLine = '';
        if (tokenObj.accountInfo) {
            accountLine = `\n👤 **${tokenObj.accountInfo.username}** (${tokenObj.accountInfo.userId})\n`;
        } else {
            accountLine = `\n🎮 Authenticated via ${loginResult.method || 'unknown'}\n`;
        }

        const embed = new EmbedBuilder()
            .setDescription(
                `✅ Token generated!${accountLine}\n` +
                `📁 token.json attached\n\n` +
                `⏳ Status: **${expiryText}**\n` +
                `🔑 Auth method: **${loginResult.method || 'N/A'}**`
            )
            .setColor(tokenExpired ? 0xED4245 : 0x2ECC71)
            .setFooter({ text: `TMC Gen` });
        
        try {
            await interaction.user.send({ embeds: [embed], files: [attachment] });
            activeGenerations.delete(userId);
            return interaction.editReply({
                content: `✅ Token sent! ${expiryText}${accountLine}`
            });
        } catch (err) {
            console.error('[TMC] DM Error:', err);
            activeGenerations.delete(userId);
            
            const fallbackEmbed = new EmbedBuilder()
                .setDescription(
                    `⚠️ Could not send DM!${accountLine}\n` +
                    `📁 token.json attached\n\n` +
                    `⏳ Status: **${expiryText}**`
                )
                .setColor(0xFEE75C)
                .setFooter({ text: `TMC Gen` });
            
            return interaction.editReply({
                embeds: [fallbackEmbed],
                files: [attachment],
                content: '📩 Token sent here (DMs closed)'
            });
        }
        
    } catch (err) {
        console.error('[TMC] Token Generation Error:', err);
        activeGenerations.delete(userId);
        return interaction.editReply({ content: '❌ Error. Please try again.' });
    }
}

// --- SLASH COMMANDS ---
const commandsData = [
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Add token stock')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('Token Generator panel'),

    new SlashCommandBuilder()
        .setName('accounts')
        .setDescription('Show all logged-in accounts'),

    new SlashCommandBuilder()
        .setName('refresh')
        .setDescription('Force refresh/re-login all tokens')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('addtoken')
        .setDescription('Add a token by pasting bearer + refresh')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(command => command.toJSON());

// --- READY EVENT ---
client.once('ready', async () => {
    try {
        console.log(`[TMC] 🚀 ONLINE: ${client.user.tag}`);
        console.log('[TMC] 🔑 Token Generator Active');
        console.log('[TMC] 🔄 Auto-Refresh Active (3-tier login)');
        console.log(`[TMC] 👑 Connected to ${client.guilds.cache.size} server(s)`);
        console.log('[TMC] ================================');

        isRefreshing = false;
        failedQueue = [];

        tokenStock = [{
            bearer: DEFAULT_TOKEN.bearer,
            refresh: DEFAULT_TOKEN.refresh_token,
            addedAt: Date.now(),
            expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
        }];
        console.log('[TMC] 📦 Default token added to stock');

        await findWorkingApiUrl();

        // Login all tokens against Nakama on startup (even expired ones)
        await loginAllTokens();

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        try {
            console.log('[TMC] 🔄 Registering slash commands...');
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commandsData },
            );
            console.log('[TMC] ✅ Slash commands registered successfully!');
        } catch (error) {
            console.error('[TMC] Failed to register slash commands:', error);
        }
        
        startAutoRefresh();
        console.log('[TMC] ✅ Bot is fully ready!');
    } catch (err) {
        console.error('[TMC] Ready event error:', err);
    }
});

// --- ERROR HANDLING ---
client.on('error', err => {
    console.error('[TMC] Client error:', err);
});

client.on('disconnect', () => {
    console.log('[TMC] Disconnected from Discord, attempting to reconnect...');
});

// --- INTERACTION CREATE ---
client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            // --- DASHBOARD COMMAND ---
            if (commandName === 'dashboard') {
                const embed = new EmbedBuilder()
                    .setDescription(
                        `**TMC Gen**\n\n` +
                        `Click below to generate your token.`
                    )
                    .setColor(0x5865F2)
                    .setFooter({ text: `TMC Gen` });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('gen_public')
                        .setLabel('Gen Token')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🔑')
                );

                return interaction.reply({ embeds: [embed], components: [row] });
            }

            // --- ACCOUNTS COMMAND ---
            if (commandName === 'accounts') {
                await interaction.deferReply({ flags: 64 });

                if (tokenStock.length === 0) {
                    return interaction.editReply({ content: '❌ No tokens in stock.' });
                }

                let desc = `**🔐 Logged In Accounts** (${tokenStock.length})\n\n`;

                for (let i = 0; i < tokenStock.length; i++) {
                    const t = tokenStock[i];
                    const expired = Date.now() >= (t.expiresAt || 0);
                    const status = expired ? '🔴 Expired' : '🟢 Active';
                    const remaining = expired ? 'Expired' : humanExpiry(t.expiresAt);
                    const acc = t.accountInfo;

                    if (acc) {
                        desc += `**${i + 1}.** ${acc.username} \`${acc.userId}\`\n`;
                        desc += `   ${status} | ⏳ ${remaining}\n\n`;
                    } else {
                        const jwtName = extractUsernameFromToken(t.bearer);
                        desc += `**${i + 1}.** ${jwtName} (not validated against server)\n`;
                        desc += `   ${status} | ⏳ ${remaining}\n\n`;
                    }
                }

                const embed = new EmbedBuilder()
                    .setDescription(desc)
                    .setColor(0x2ECC71)
                    .setFooter({ text: `TMC Gen | ${tokenStock.length} token(s)` });

                return interaction.editReply({ embeds: [embed] });
            }

            // --- REFRESH COMMAND (Admin) ---
            if (commandName === 'refresh') {
                await interaction.deferReply({ flags: 64 });

                await interaction.editReply({ content: '🔄 Force re-login all tokens (3-tier)...' });

                if (!apiWorking) await findWorkingApiUrl();

                let loggedIn = 0;
                let failedCount = 0;

                for (let i = 0; i < tokenStock.length; i++) {
                    const t = tokenStock[i];
                    const label = `[ForceRefresh ${i + 1}/${tokenStock.length}]`;

                    await interaction.editReply({
                        content: `🔄 Processing token ${i + 1}/${tokenStock.length}...`
                    });

                    const result = await fullLogin(t, label);
                    if (result.success) loggedIn++;
                    else failedCount++;

                    if (i < tokenStock.length - 1) {
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }

                return interaction.editReply({
                    content: `✅ Force refresh complete!\n🟢 Logged in: ${loggedIn}\n🔴 Failed: ${failedCount}`
                });
            }

            // --- ADDTOKEN COMMAND (Admin) ---
            if (commandName === 'addtoken') {
                const modal = new ModalBuilder()
                    .setCustomId('addtoken_modal')
                    .setTitle('Add Token to Stock');

                const bearerInput = new TextInputBuilder()
                    .setCustomId('bearer_input')
                    .setLabel("BEARER TOKEN")
                    .setStyle(TextInputStyle.Paragraph)
                    .placeholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(2000);

                const refreshInput = new TextInputBuilder()
                    .setCustomId('refresh_input')
                    .setLabel("REFRESH TOKEN")
                    .setStyle(TextInputStyle.Paragraph)
                    .placeholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(2000);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(bearerInput),
                    new ActionRowBuilder().addComponents(refreshInput)
                );

                await interaction.showModal(modal);
            }

            // --- STOCK COMMAND (Admin only) ---
            if (commandName === 'stock') {
                const modal = new ModalBuilder()
                    .setCustomId('stock_modal')
                    .setTitle('Add Token Stock');

                const bearerInput = new TextInputBuilder()
                    .setCustomId('stock_bearer_input')
                    .setLabel("ENTER BEARER TOKEN")
                    .setStyle(TextInputStyle.Paragraph)
                    .placeholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(2000);

                const refreshInput = new TextInputBuilder()
                    .setCustomId('stock_refresh_input')
                    .setLabel("ENTER REFRESH TOKEN")
                    .setStyle(TextInputStyle.Paragraph)
                    .placeholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(2000);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(bearerInput),
                    new ActionRowBuilder().addComponents(refreshInput)
                );

                await interaction.showModal(modal);
            }
        }

        // --- BUTTON HANDLERS ---
        if (interaction.isButton()) {
            if (interaction.customId === 'gen_public') {
                return await processTokenGeneration(interaction);
            }
        }

        // --- MODAL SUBMITS ---
        if (interaction.isModalSubmit()) {
            // --- ADDTOKEN MODAL ---
            if (interaction.customId === 'addtoken_modal') {
                try {
                    await interaction.deferReply({ flags: 64 });

                    const bearer = interaction.fields.getTextInputValue('bearer_input').trim();
                    const refresh = interaction.fields.getTextInputValue('refresh_input').trim();

                    if (!bearer || !refresh) {
                        return interaction.editReply({ content: '❌ Both tokens required.' });
                    }

                    // Build the token object - accept expired tokens too
                    const tokenEntry = {
                        bearer,
                        refresh,
                        addedAt: Date.now(),
                        expiresAt: getTokenExpiryMs(bearer),
                        accountInfo: null
                    };

                    tokenStock.push(tokenEntry);

                    await interaction.editReply({ content: '🔐 Logging into Nakama (3-tier)...' });

                    // Full login - works even if expired
                    const label = `[AddToken]`;
                    const result = await fullLogin(tokenEntry, label);

                    const expiryText = humanExpiry(tokenEntry.expiresAt);

                    if (result.success) {
                        const acc = result.account;
                        const accLine = acc ? `\n👤 **${acc.username}** (${acc.userId})` : '';
                        return interaction.editReply({
                            content: `✅ Token added & logged in!${accLine}\n🔑 Method: **${result.method}**\n⏳ ${expiryText}\n📦 Total: \`${tokenStock.length}\``
                        });
                    } else {
                        const jwtName = extractUsernameFromToken(bearer);
                        return interaction.editReply({
                            content: `⚠️ Token added but all login tiers failed.\n👤 JWT name: ${jwtName}\n⏳ ${expiryText}\n📦 Total: \`${tokenStock.length}\``
                        });
                    }
                } catch (err) {
                    console.error('[TMC] AddToken Modal Error:', err);
                    if (interaction.deferred) {
                        return interaction.editReply({ content: '❌ Error. Please try again.' });
                    } else {
                        return interaction.reply({ content: '❌ Error. Please try again.', flags: 64 });
                    }
                }
            }

            // --- STOCK MODAL ---
            if (interaction.customId === 'stock_modal') {
                try {
                    await interaction.deferReply({ flags: 64 });
                    
                    const bearer = interaction.fields.getTextInputValue('stock_bearer_input').trim();
                    const refresh = interaction.fields.getTextInputValue('stock_refresh_input').trim();
                    
                    if (!bearer || !refresh) {
                        return interaction.editReply({ content: '❌ Both tokens required.' });
                    }

                    const tokenEntry = {
                        bearer,
                        refresh,
                        addedAt: Date.now(),
                        expiresAt: getTokenExpiryMs(bearer),
                        accountInfo: null
                    };

                    tokenStock.push(tokenEntry);

                    await interaction.editReply({ content: '🔐 Logging into Nakama (3-tier)...' });

                    const label = `[Stock]`;
                    const result = await fullLogin(tokenEntry, label);

                    const expiryText = humanExpiry(tokenEntry.expiresAt);

                    if (result.success) {
                        const acc = result.account;
                        const accLine = acc ? `\n👤 **${acc.username}** (${acc.userId})` : '';
                        return interaction.editReply({
                            content: `✅ Token added & logged in!${accLine}\n🔑 Method: **${result.method}**\n⏳ ${expiryText}\n📦 Total: \`${tokenStock.length}\``
                        });
                    } else {
                        const jwtName = extractUsernameFromToken(bearer);
                        return interaction.editReply({
                            content: `⚠️ Token added but all login tiers failed.\n👤 JWT name: ${jwtName}\n⏳ ${expiryText}\n📦 Total: \`${tokenStock.length}\``
                        });
                    }
                } catch (err) {
                    console.error('[TMC] Stock Modal Error:', err);
                    if (interaction.deferred) {
                        return interaction.editReply({ content: '❌ Error. Please try again.' });
                    } else {
                        return interaction.reply({ content: '❌ Error. Please try again.', flags: 64 });
                    }
                }
            }
        }
    } catch (err) {
        console.error(`[TMC] Interaction Error:`, err);
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: "❌ Error. Try again.", flags: 64 }).catch(() => {});
        }
    }
});

// --- HEALTH CHECK HTTP SERVER ---
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            bot: 'online', 
            accounts: tokenStock.map(t => ({
                username: t.accountInfo?.username || extractUsernameFromToken(t.bearer),
                userId: t.accountInfo?.userId || 'unknown',
                valid: t.accountInfo?.valid || false,
                expires: t.expiresAt
            })),
            timestamp: Date.now() 
        }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Token Generator Bot is active!\n');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[TMC] HTTP server running on port ${PORT}`);
});

// --- LOGIN WITH RETRY ---
console.log('[TMC] 🔑 Attempting to login to Discord...');

if (!process.env.DISCORD_TOKEN) {
    console.error('[TMC] ❌ DISCORD_TOKEN environment variable is NOT set!');
} else {
    console.log(`[TMC] ✅ DISCORD_TOKEN is set (length: ${process.env.DISCORD_TOKEN.length})`);
    
    async function loginWithRetry(attempts = 5) {
        for (let i = 1; i <= attempts; i++) {
            try {
                console.log(`[TMC] 🔄 Login attempt ${i}/${attempts}...`);
                const loginPromise = client.login(process.env.DISCORD_TOKEN);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Login timeout after 30 seconds')), 30000);
                });
                await Promise.race([loginPromise, timeoutPromise]);
                console.log('[TMC] ✅ Discord login successful!');
                return true;
            } catch (err) {
                console.error(`[TMC] ❌ Login attempt ${i} failed:`, err.message);
                if (i === attempts) {
                    console.error('[TMC] ❌ All login attempts failed.');
                    return false;
                }
                await new Promise(resolve => setTimeout(resolve, 5000 * i));
            }
        }
        return false;
    }

    loginWithRetry().then(success => {
        if (!success) {
            console.error('[TMC] ❌ Bot failed to connect to Discord.');
        }
    });
}

process.on('unhandledRejection', (reason) => {
    console.error('[TMC] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[TMC] Uncaught Exception:', err);
});
