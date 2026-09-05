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

// --- DEVICE AUTH CONFIG (for auto re-auth when refresh token dies) ---
// DEVICE_ID = your persistent hardware GUID (from yaml: a60f8dba...)
// DEVICE_TOKEN = optional — if empty, bot will use DEVICE_ID as the token
//                (Nakama device auth just needs a stable unique ID)
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const DEVICE_ID = process.env.DEVICE_ID || '';

let ACTIVE_API_URL = API_URLS[0];
let apiWorking = false;
let isRefreshing = false;
let isReAuthing = false;
let failedQueue = [];
let tokenStock = [];
const cooldowns = new Map();
const activeGenerations = new Map();
let refreshInterval = null;
let refreshRetryCount = 0;
const MAX_REFRESH_RETRIES = 5;

// --- TOKEN LIFETIME TRACKING ---
let tokenLifetime = {
    accessExpiresAt: 0,
    refreshExpiresAt: 0,
    lastRefreshSuccess: 0,
    refreshCount: 0
};

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

function getTokenIssuedAtMs(token) {
    const p = decodeJwt(token);
    if (p && typeof p.iat === 'number') return p.iat * 1000;
    return Date.now();
}

function getTokenLifetimeMs(token) {
    const exp = getTokenExpiryMs(token);
    const iat = getTokenIssuedAtMs(token);
    return Math.max(exp - iat, 60000);
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

function updateTokenLifetimeTracking(bearer, refreshToken) {
    const bearerExp = getTokenExpiryMs(bearer);
    const refreshExp = refreshToken ? getTokenExpiryMs(refreshToken) : 0;
    
    tokenLifetime.accessExpiresAt = bearerExp;
    tokenLifetime.refreshExpiresAt = refreshExp;
    tokenLifetime.lastRefreshSuccess = Date.now();
    tokenLifetime.refreshCount++;
    
    const accessLife = getTokenLifetimeMs(bearer);
    const refreshLife = refreshToken ? getTokenLifetimeMs(refreshToken) : 0;
    
    console.log(`[TMC] Token lifetime — access: ${Math.round(accessLife/1000/60)}min, refresh: ${refreshToken ? Math.round(refreshLife/1000/60) + 'min' : 'none'}`);
    console.log(`[TMC] Access expires: ${new Date(bearerExp).toLocaleTimeString()}, Refresh expires: ${refreshToken ? new Date(refreshExp).toLocaleTimeString() : 'unknown'}`);
    console.log(`[TMC] Total refreshes performed: ${tokenLifetime.refreshCount}`);
}

function getOptimalRefreshDelay() {
    // Refresh at 40% of access token lifetime, but clamp between 30s and 30min
    const bearerLife = getTokenLifetimeMs(DEFAULT_TOKEN.bearer);
    const delay = Math.floor(bearerLife * 0.4);
    const clamped = Math.max(30000, Math.min(delay, 30 * 60 * 1000));
    return clamped;
}

function getRefreshHealthStatus() {
    const now = Date.now();
    const accessRemaining = tokenLifetime.accessExpiresAt - now;
    const refreshRemaining = tokenLifetime.refreshExpiresAt - now;
    return {
        accessExpired: accessRemaining <= 0,
        accessRemainingMs: accessRemaining,
        refreshExpired: tokenLifetime.refreshExpiresAt > 0 && refreshRemaining <= 0,
        refreshRemainingMs: refreshRemaining,
        refreshesDone: tokenLifetime.refreshCount,
        lastSuccessAgo: tokenLifetime.lastRefreshSuccess ? now - tokenLifetime.lastRefreshSuccess : null
    };
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

// --- SAFETY: reset stuck refresh lock after 30s ---
setInterval(() => {
    if (isRefreshing) {
        console.log('[TMC] Safety: refreshing lock was stuck, force-releasing');
        isRefreshing = false;
        processQueue(new Error('Refresh lock timeout'), null);
    }
}, 30000);

// --- REFRESH TOKEN ---
async function refreshToken(refreshTk) {
    try {
        console.log('[TMC] Attempting to refresh token...');
        
        // Check if refresh token itself is expired before even trying
        const refreshExp = getTokenExpiryMs(refreshTk);
        if (Date.now() >= refreshExp) {
            console.log('[TMC] Refresh token is EXPIRED. Cannot refresh.');
            return { success: false, error: 'Refresh token expired. Need fresh device auth.' };
        }
        
        const refreshLifeRemaining = refreshExp - Date.now();
        if (refreshLifeRemaining < 5 * 60 * 1000) {
            console.log(`[TMC] WARNING: Refresh token expires in ${formatRemainingTime(refreshExp)} — very low!`);
        } else if (refreshLifeRemaining < 30 * 60 * 1000) {
            console.log(`[TMC] NOTICE: Refresh token expires in ${formatRemainingTime(refreshExp)}`);
        }
        
        if (isRefreshing) {
            console.log('[TMC] Refresh in progress, queuing...');
            return new Promise((resolve, reject) => {
                failedQueue.push({ resolve, reject });
            });
        }

        isRefreshing = true;
        console.log('[TMC] Refresh lock acquired');

        const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');

        // Try each URL with a retry per URL
        const MAX_RETRIES_PER_URL = 2;
        const allErrors = [];

        const urlsToTry = [...API_URLS];
        if (ACTIVE_API_URL && urlsToTry.includes(ACTIVE_API_URL)) {
            urlsToTry.splice(urlsToTry.indexOf(ACTIVE_API_URL), 1);
            urlsToTry.unshift(ACTIVE_API_URL);
        }

        for (const url of urlsToTry) {
            for (let attempt = 1; attempt <= MAX_RETRIES_PER_URL; attempt++) {
                try {
                    const refreshUrl = `${url}/v2/account/session/refresh`;
                    console.log(`[TMC] Trying refresh at: ${refreshUrl} (attempt ${attempt}/${MAX_RETRIES_PER_URL})`);
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 20000);

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

                    // Try to read response body regardless of status
                    let data = null;
                    let rawBody = '';
                    try {
                        rawBody = await response.text();
                        data = JSON.parse(rawBody);
                    } catch (parseErr) {
                        // Non-JSON response (HTML error page from cloudflare, etc.)
                        const snippet = rawBody.substring(0, 150).replace(/\s+/g, ' ');
                        console.log(`[TMC] ${url} (attempt ${attempt}) - Non-JSON response (status ${response.status}): ${snippet}`);
                        allErrors.push(`${url}: non-JSON (status ${response.status})`);
                        
                        // If it's a server error (5xx), retry this URL
                        if (response.status >= 500 && attempt < MAX_RETRIES_PER_URL) {
                            console.log(`[TMC] Server error, retrying in 2s...`);
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                        break; // Move to next URL
                    }

                    console.log(`[TMC] ${url} - Status: ${response.status}, Body:`, JSON.stringify(data).substring(0, 300));

                    // Extract token from response — handle ALL known formats
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
                    } else if (data.session_token) {
                        newBearer = data.session_token;
                        newRefresh = data.refresh_token || refreshTk;
                    }

                    // Handle 401 — server says token is invalid
                    if (response.status === 401) {
                        const errMsg = data ? (data.message || data.error || JSON.stringify(data)) : 'no body';
                        console.log(`[TMC] ${url} - 401 Unauthorized: ${errMsg}`);
                        allErrors.push(`${url}: 401 - ${errMsg}`);
                        
                        // If we got a token back despite 401, still try to use it
                        if (newBearer) {
                            console.log(`[TMC] Got token despite 401, attempting to use it...`);
                        } else {
                            if (attempt < MAX_RETRIES_PER_URL) {
                                await new Promise(r => setTimeout(r, 2000));
                            }
                            continue;
                        }
                    }

                    // Handle 429 — rate limited
                    if (response.status === 429) {
                        console.log(`[TMC] ${url} - Rate limited! Waiting 5s before retry...`);
                        allErrors.push(`${url}: 429 rate limited`);
                        if (attempt < MAX_RETRIES_PER_URL) {
                            await new Promise(r => setTimeout(r, 5000));
                            continue;
                        }
                        break;
                    }

                    // Handle 5xx — server error, retry
                    if (response.status >= 500) {
                        console.log(`[TMC] ${url} - Server error ${response.status}`);
                        allErrors.push(`${url}: ${response.status} server error`);
                        if (attempt < MAX_RETRIES_PER_URL) {
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                        break;
                    }

                    // SUCCESS: 200 with a token
                    if (response.status === 200 && newBearer) {
                        const newExpiry = getTokenExpiryMs(newBearer);
                        const newRefreshExpiry = getTokenExpiryMs(newRefresh);

                        if (newExpiry <= Date.now()) {
                            console.log(`[TMC] ${url} - Refreshed token already expired, skipping`);
                            allErrors.push(`${url}: returned expired token`);
                            continue;
                        }

                        console.log(`[TMC] Successfully refreshed token via ${url}!`);
                        console.log(`[TMC] New Bearer: ${newBearer.substring(0, 50)}...`);
                        console.log(`[TMC] New Refresh: ${newRefresh.substring(0, 50)}...`);
                        console.log(`[TMC] Access: ${humanExpiry(newExpiry)}, Refresh: ${humanExpiry(newRefreshExpiry)}`);

                        DEFAULT_TOKEN.bearer = newBearer;
                        DEFAULT_TOKEN.refresh_token = newRefresh;
                        ACTIVE_API_URL = url;
                        apiWorking = true;
                        refreshRetryCount = 0;

                        // Update token lifetime tracking
                        updateTokenLifetimeTracking(newBearer, newRefresh);

                        if (tokenStock.length > 0) {
                            const oldToken = tokenStock[0];
                            tokenStock[0] = {
                                bearer: newBearer,
                                refresh: newRefresh,
                                addedAt: Date.now(),
                                expiresAt: newExpiry,
                                refreshExpiresAt: newRefreshExpiry,
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
                                refreshExpiresAt: newRefreshExpiry,
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
                            refreshExpiresAt: newRefreshExpiry,
                            newToken: true
                        };
                        processQueue(null, result);
                        isRefreshing = false;
                        console.log('[TMC] Refresh lock released');
                        return result;
                    }

                    // 200 but no token in response — log and move on
                    console.log(`[TMC] ${url} - Got 200 but no token in response`);
                    allErrors.push(`${url}: 200 but no token field`);

                } catch (err) {
                    const errMsg = err.name === 'AbortError' ? 'timeout (20s)' : err.message;
                    console.log(`[TMC] ${url} (attempt ${attempt}) - ${errMsg}`);
                    allErrors.push(`${url}: ${errMsg}`);
                    
                    // On network/timeout errors, retry with delay
                    if (attempt < MAX_RETRIES_PER_URL) {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }
        }

        console.log('[TMC] All refresh URLs failed. Errors:', allErrors.join(' | '));
        refreshRetryCount++;
        
        if (tokenStock.length > 0) {
            tokenStock[0].expiresAt = getTokenExpiryMs(tokenStock[0].bearer);
        }

        processQueue(new Error('All refresh URLs failed'), null);
        isRefreshing = false;
        return { success: false, error: `All refresh URLs failed: ${allErrors[allErrors.length - 1]}`, retryCount: refreshRetryCount, allErrors };
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
                    refreshExpiresAt: newRefresh ? getTokenExpiryMs(newRefresh) : 0,
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
                    refreshExpiresAt: newRefresh ? getTokenExpiryMs(newRefresh) : 0,
                    id: '',
                    userId: 'system',
                    username: 'System'
                });
            }

            DEFAULT_TOKEN.bearer = newBearer;
            DEFAULT_TOKEN.refresh_token = newRefresh;

            // Update lifetime tracking
            updateTokenLifetimeTracking(newBearer, newRefresh);

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
    if (!deviceToken || deviceToken.length < 10) {
        return { success: false, error: 'Device token is too short or missing.' };
    }
    if (!deviceID || deviceID.length < 5) {
        return { success: false, error: 'Device ID is too short or missing.' };
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
                refreshExpiresAt: newRefresh ? getTokenExpiryMs(newRefresh) : 0,
                id: '',
                userId: 'device_auth',
                username: 'DeviceAuth'
            });

            // Update default
            DEFAULT_TOKEN.bearer = newBearer;
            if (newRefresh) DEFAULT_TOKEN.refresh_token = newRefresh;

            // Update lifetime tracking
            updateTokenLifetimeTracking(newBearer, newRefresh);

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

// --- AUTO RE-AUTH FROM DEVICE (when refresh token dies) ---
async function autoReAuthFromDevice() {
    // Need at minimum a DEVICE_ID — if no DEVICE_TOKEN, we use DEVICE_ID as the token
    // (Nakama device auth just needs a stable unique identifier)
    if (!DEVICE_ID) {
        console.log('[TMC] !! No DEVICE_ID env var set — cannot auto re-auth !!');
        console.log('[TMC] !! Set DEVICE_ID in your environment to enable auto re-auth !!');
        console.log('[TMC] !! Your device ID from yaml: a60f8dba6c418f905d889bca18d7aa36c9343c23 !!');
        return { success: false, error: 'No DEVICE_ID configured. Set DEVICE_ID env var.' };
    }
    
    // Use DEVICE_TOKEN if provided, otherwise fall back to DEVICE_ID as the token
    const authToken = DEVICE_TOKEN || DEVICE_ID;
    
    if (isReAuthing) {
        console.log('[TMC] Re-auth already in progress, skipping...');
        return { success: false, error: 'Re-auth in progress' };
    }
    
    isReAuthing = true;
    console.log('[TMC] ==========================================');
    console.log('[TMC] AUTO RE-AUTH: Refresh token dead, re-authenticating via device auth...');
    console.log('[TMC] ==========================================');
    
    try {
        // Try all URLs
        const urlsToTry = [...API_URLS];
        if (ACTIVE_API_URL && urlsToTry.includes(ACTIVE_API_URL)) {
            urlsToTry.splice(urlsToTry.indexOf(ACTIVE_API_URL), 1);
            urlsToTry.unshift(ACTIVE_API_URL);
        }
        
        // Try both auth endpoints — game uses /authenticate/steam, standard nakama uses /authenticate/device
        const authEndpoints = [
            '/v2/account/authenticate/steam',
            '/v2/account/authenticate/device'
        ];

        for (const url of urlsToTry) {
            for (const endpoint of authEndpoints) {
                for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const authUrl = `${url}${endpoint}`;
                    console.log(`[TMC] Re-auth attempt ${attempt}/3 at: ${authUrl}`);
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 20000);
                    const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');

                    const body = {
                        token: authToken,
                        vars: {
                            clientUserAgent: "SteamVR 1.88.1.3421_a3df6ce5",
                            deviceID: DEVICE_ID
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

                    let data = null;
                    let rawBody = '';
                    try {
                        rawBody = await response.text();
                        data = JSON.parse(rawBody);
                    } catch (parseErr) {
                        console.log(`[TMC] ${url} (attempt ${attempt}) - Non-JSON (status ${response.status}): ${rawBody.substring(0, 150)}`);
                        if (response.status >= 500 && attempt < 3) {
                            await new Promise(r => setTimeout(r, 3000));
                            continue;
                        }
                        break;
                    }

                    console.log(`[TMC] Re-auth response (status ${response.status}):`, JSON.stringify(data).substring(0, 300));

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
                        const newRefreshExpiry = newRefresh ? getTokenExpiryMs(newRefresh) : 0;

                        if (newExpiry <= Date.now()) {
                            console.log(`[TMC] ${url} - Re-auth returned expired token, skipping`);
                            continue;
                        }

                        console.log(`[TMC] ==========================================`);
                        console.log(`[TMC] RE-AUTH SUCCESSFUL!`);
                        console.log(`[TMC] New Bearer: ${newBearer.substring(0, 50)}...`);
                        if (newRefresh) console.log(`[TMC] New Refresh: ${newRefresh.substring(0, 50)}...`);
                        console.log(`[TMC] Access: ${humanExpiry(newExpiry)}, Refresh: ${newRefresh ? humanExpiry(newRefreshExpiry) : 'none'}`);
                        console.log(`[TMC] ==========================================`);

                        DEFAULT_TOKEN.bearer = newBearer;
                        if (newRefresh) DEFAULT_TOKEN.refresh_token = newRefresh;
                        ACTIVE_API_URL = url;
                        apiWorking = true;
                        refreshRetryCount = 0;
                        isReAuthing = false;

                        // Update token lifetime tracking
                        updateTokenLifetimeTracking(newBearer, newRefresh);

                        // Replace or add to stock
                        if (tokenStock.length > 0) {
                            tokenStock[0] = {
                                bearer: newBearer,
                                refresh: newRefresh,
                                addedAt: Date.now(),
                                expiresAt: newExpiry,
                                refreshExpiresAt: newRefreshExpiry,
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
                                refreshExpiresAt: newRefreshExpiry,
                                id: '',
                                userId: 'device_auth',
                                username: 'AutoReAuth'
                            });
                        }

                        // Process any queued requests
                        processQueue(null, { success: true, bearer: newBearer, refresh: newRefresh, expiresAt: newExpiry, newToken: true });
                        
                        return { success: true, bearer: newBearer, refresh: newRefresh, expiresAt: newExpiry };
                    } else {
                        const errMsg = data ? (data.message || data.error || JSON.stringify(data)) : 'no body';
                        console.log(`[TMC] ${url} - Re-auth failed (${response.status}): ${errMsg}`);
                        
                        if (response.status === 401) {
                            console.log(`[TMC] !! DEVICE TOKEN MAY BE REVOKED — check your DEVICE_TOKEN env var !!`);
                        }
                        
                        if (response.status === 429) {
                            console.log(`[TMC] Rate limited, waiting 5s...`);
                            await new Promise(r => setTimeout(r, 5000));
                        } else if (attempt < 3) {
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    }
                } catch (err) {
                    const errMsg = err.name === 'AbortError' ? 'timeout (20s)' : err.message;
                    console.log(`[TMC] ${url} (attempt ${attempt}) - ${errMsg}`);
                    if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
                }
            }
        }

        isReAuthing = false;
        console.log('[TMC] !! ALL RE-AUTH ATTEMPTS FAILED !!');
        console.log('[TMC] !! Check DEVICE_TOKEN and DEVICE_ID env vars !!');
        processQueue(new Error('Device re-auth failed'), null);
        return { success: false, error: 'All re-auth attempts failed' };
    } catch (err) {
        console.error('[TMC] Re-auth error:', err.message);
        isReAuthing = false;
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
            expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer),
            refreshExpiresAt: getTokenExpiryMs(DEFAULT_TOKEN.refresh_token)
        });
        return { success: true };
    }
    const tokenObj = tokenStock[0];
    if (!tokenObj.refresh) {
        console.log('[TMC] No refresh token in stock!');
        return { success: false, error: 'No refresh token' };
    }
    try {
        const refreshResult = await refreshToken(tokenObj.refresh);
        if (refreshResult && refreshResult.success) {
            console.log(`[TMC] Token refreshed — access: ${humanExpiry(refreshResult.expiresAt)}, refresh: ${humanExpiry(refreshResult.refreshExpiresAt)}`);
            return refreshResult;
        } else {
            console.log(`[TMC] Refresh failed: ${refreshResult ? refreshResult.error : 'unknown'}`);
            return refreshResult || { success: false, error: 'unknown' };
        }
    } catch (err) {
        console.log(`[TMC] Refresh exception: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// --- SMART AUTO-REFRESH ---
function scheduleNextRefresh() {
    if (refreshInterval) clearTimeout(refreshInterval);
    
    const delay = getOptimalRefreshDelay();
    const accessTimeLeft = tokenLifetime.accessExpiresAt - Date.now();
    const refreshTimeLeft = tokenLifetime.refreshExpiresAt - Date.now();
    
    // If refresh token is expired or about to expire, trigger re-auth instead of giving up
    if (tokenLifetime.refreshExpiresAt > 0 && refreshTimeLeft <= 30 * 60 * 1000) {
        const minsLeft = Math.round(refreshTimeLeft / 60000);
        if (refreshTimeLeft <= 0) {
            console.log('[TMC] Refresh token expired — triggering auto re-auth...');
        } else {
            console.log(`[TMC] Refresh token low (${minsLeft} min left) — triggering auto re-auth...`);
        }
        
        refreshInterval = setTimeout(async () => {
            refreshInterval = null;
            if (isReAuthing) { scheduleNextRefresh(); return; }
            if (!apiWorking) await findWorkingApiUrl();
            
            const reAuthResult = await autoReAuthFromDevice();
            if (reAuthResult && reAuthResult.success) {
                console.log('[TMC] Re-auth successful, resuming normal refresh cycle');
                refreshRetryCount = 0;
            } else {
                console.log('[TMC] Re-auth failed, retrying in 60s...');
            }
            scheduleNextRefresh();
        }, isReAuthing ? 5000 : 1000);
        return;
    }
    
    // If access token is still fresh, wait longer
    let actualDelay = delay;
    if (accessTimeLeft > 0) {
        // Refresh when 40% of lifetime remains, minimum 30s
        const refreshAt = Math.floor(accessTimeLeft * 0.4);
        actualDelay = Math.max(30000, Math.min(refreshAt, 30 * 60 * 1000));
    } else {
        // Token expired, try again in 30 seconds
        actualDelay = 30000;
        console.log('[TMC] Access token expired! Retrying in 30s...');
    }
    
    // Warn if refresh token is getting low
    if (tokenLifetime.refreshExpiresAt > 0) {
        const refreshMinsLeft = Math.round(refreshTimeLeft / 60000);
        if (refreshMinsLeft < 60 && refreshMinsLeft > 30) {
            console.log(`[TMC] Refresh token: ${refreshMinsLeft} min remaining`);
        }
    }
    
    console.log(`[TMC] Next refresh in ${Math.round(actualDelay/1000)}s (${formatRemainingTime(tokenLifetime.accessExpiresAt)} access left)`);
    
    refreshInterval = setTimeout(async () => {
        refreshInterval = null;
        if (isRefreshing) { scheduleNextRefresh(); return; }
        if (!apiWorking) await findWorkingApiUrl();
        
        const result = await refreshTokenInStock();
        
        if (!result || !result.success) {
            refreshRetryCount++;
            // If refresh failed and it looks like a 401/token issue, try re-auth
            const errMsg = result ? (result.error || '') : '';
            if (errMsg.includes('401') || errMsg.includes('expired') || errMsg.includes('invalid')) {
                console.log('[TMC] Refresh failed with auth error — triggering auto re-auth...');
                refreshRetryCount = 0;
                await autoReAuthFromDevice();
                scheduleNextRefresh();
                return;
            }
            const retryDelay = Math.min(30000 * refreshRetryCount, 5 * 60 * 1000);
            console.log(`[TMC] Refresh failed (attempt ${refreshRetryCount}), retrying in ${Math.round(retryDelay/1000)}s`);
            refreshInterval = setTimeout(async () => {
                refreshInterval = null;
                if (!apiWorking) await findWorkingApiUrl();
                
                const retryResult = await refreshTokenInStock();
                if (!retryResult || !retryResult.success) {
                    const retryErr = retryResult ? (retryResult.error || '') : '';
                    if (retryErr.includes('401') || retryErr.includes('expired') || retryErr.includes('invalid')) {
                        console.log('[TMC] Retry also failed with auth error — triggering auto re-auth...');
                        await autoReAuthFromDevice();
                    }
                }
                scheduleNextRefresh();
            }, retryDelay);
        } else {
            refreshRetryCount = 0;
            scheduleNextRefresh();
        }
    }, actualDelay);
}

function startAutoRefresh() {
    console.log('[TMC] Smart auto-refresh starting');
    console.log(`[TMC] Device auth: ${DEVICE_ID ? (DEVICE_TOKEN ? 'DEVICE_TOKEN + DEVICE_ID set' : 'DEVICE_ID set (using as token)') : 'NOT SET — set DEVICE_ID env var for auto re-auth'}`);
    isRefreshing = false;
    isReAuthing = false;
    failedQueue = [];
    refreshRetryCount = 0;
    
    setTimeout(async () => {
        await findWorkingApiUrl();
        
        // Initialize token lifetime tracking
        updateTokenLifetimeTracking(DEFAULT_TOKEN.bearer, DEFAULT_TOKEN.refresh_token);
        
        // Check if current refresh token is already expired — re-auth immediately
        const refreshTimeLeft = tokenLifetime.refreshExpiresAt - Date.now();
        if (refreshTimeLeft <= 0) {
            console.log('[TMC] Refresh token already expired on startup — re-authenticating...');
            const reAuthResult = await autoReAuthFromDevice();
            if (!reAuthResult || !reAuthResult.success) {
                console.log('[TMC] !! Startup re-auth failed. Bot will not work until device credentials are provided !!');
            }
        } else {
            // Do first refresh to validate session
            const result = await refreshTokenInStock();
            if (!result || !result.success) {
                console.log('[TMC] First refresh failed, will attempt re-auth on next cycle');
            }
        }
        
        // Start smart scheduling
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
                tokenStock[i].refreshExpiresAt = res.refreshExpiresAt || 0;
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
                expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer),
                refreshExpiresAt: getTokenExpiryMs(DEFAULT_TOKEN.refresh_token)
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

        // Device tokens are hex strings, NOT JWTs
        if (deviceToken.length < 10) {
            return interaction.editReply({ content: 'Device token is too short.' });
        }

        if (deviceID.length < 5) {
            return interaction.editReply({ content: 'Device ID is too short.' });
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
        .setName('dashboard')
        .setDescription('Token Generator panel'),
    new SlashCommandBuilder()
        .setName('cleandms')
        .setDescription('Delete all DM conversations the bot has')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

// --- READY ---
client.once('ready', async () => {
    console.log(`[TMC] ONLINE: ${client.user.tag}`);
    console.log(`[TMC] Connected to ${client.guilds.cache.size} server(s)`);

    tokenStock = [{
        bearer: DEFAULT_TOKEN.bearer,
        refresh: DEFAULT_TOKEN.refresh_token,
        addedAt: Date.now(),
        expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer),
        refreshExpiresAt: getTokenExpiryMs(DEFAULT_TOKEN.refresh_token)
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
        // Block ALL interactions in DMs
        if (!interaction.guild) {
            if (!interaction.replied && !interaction.deferred) {
                return interaction.reply({ content: 'Commands only work in the server.', flags: 64 }).catch(() => {});
            }
            return;
        }

        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            if (commandName === 'dashboard') {
                const health = getRefreshHealthStatus();
                const accessStatus = health.accessRemainingMs > 0 ? `Access: **${formatRemainingTime(tokenLifetime.accessExpiresAt)}**` : 'Access: **EXPIRED**';
                const refreshStatus = health.refreshRemainingMs > 0 ? `Refresh: **${formatRemainingTime(tokenLifetime.refreshExpiresAt)}**` : 'Refresh: **EXPIRED**';
                const deviceStatus = DEVICE_ID ? (DEVICE_TOKEN ? 'Device Auth: **FULL**' : 'Device Auth: **ID only**') : 'Device Auth: **NOT SET**';
                const reAuthStatus = isReAuthing ? 'Re-auth: **IN PROGRESS**' : '';
                
                const embed = new EmbedBuilder()
                    .setDescription(
                        `**TMC Gen**\n\n` +
                        `Generate, refresh, and manage your tokens.\n\n` +
                        `${accessStatus}\n${refreshStatus}\n${deviceStatus}` +
                        (reAuthStatus ? `\n${reAuthStatus}` : '') +
                        `\nRefreshes done: **${health.refreshesDone}**`
                    )
                    .setColor(health.accessExpired ? 0xED4245 : 0x2ECC71)
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

                const row4 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('force_refresh_btn')
                        .setLabel('Force Refresh Now')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('⚡')
                );

                const row5 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('update_device_token_btn')
                        .setLabel('Update Device Token')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('🔑')
                );

                return interaction.reply({ embeds: [embed], components: [row1, row2, row3, row4, row5] });
            }

            if (commandName === 'cleandms') {
                await interaction.deferReply({ flags: 64 });

                // Fetch all DM channels the bot has open
                let deletedCount = 0;
                let failedCount = 0;

                // Get all users the bot shares a DM with via cache
                const dmChannels = client.channels.cache.filter(ch => ch.type === 1); // DM type = 1
                const total = dmChannels.size;

                if (total === 0) {
                    return interaction.editReply({ content: 'No open DM conversations found.' });
                }

                await interaction.editReply({ content: `Found ${total} DM conversations. Deleting...` });

                for (const [, channel] of dmChannels) {
                    try {
                        await channel.delete('Clean DMs command');
                        deletedCount++;
                    } catch (err) {
                        failedCount++;
                    }
                }

                return interaction.editReply({
                    content: `DM cleanup complete!\n- Deleted: **${deletedCount}**\n- Failed: **${failedCount}**\n- Total found: **${total}**`
                });
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

            if (interaction.customId === 'force_refresh_btn') {
                await interaction.deferReply({ flags: 64 });
                try {
                    if (isRefreshing) {
                        return interaction.editReply({ content: 'A refresh is already in progress...' });
                    }
                    const result = await refreshTokenInStock();
                    if (result && result.success) {
                        const health = getRefreshHealthStatus();
                        const embed = new EmbedBuilder()
                            .setDescription(
                                `Force refresh successful!\n\n` +
                                `Access: **${formatRemainingTime(tokenLifetime.accessExpiresAt)}**\n` +
                                `Refresh: **${formatRemainingTime(tokenLifetime.refreshExpiresAt)}**\n` +
                                `Total refreshes: **${health.refreshesDone}**`
                            )
                            .setColor(0x2ECC71)
                            .setFooter({ text: `TMC Gen` });
                        return interaction.editReply({ embeds: [embed] });
                    } else {
                        return interaction.editReply({
                            content: `Refresh failed: ${result ? result.error : 'unknown error'}`
                        });
                    }
                } catch (err) {
                    return interaction.editReply({ content: 'Error during force refresh.' });
                }
            }
        }

        if (interaction.isModalSubmit()) {
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
        const health = getRefreshHealthStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            bot: client.user ? 'online' : 'offline', 
            stock: tokenStock.length,
            accessExpiresIn: health.accessRemainingMs > 0 ? Math.round(health.accessRemainingMs / 1000) + 's' : 'expired',
            refreshExpiresIn: health.refreshRemainingMs > 0 ? Math.round(health.refreshRemainingMs / 1000) + 's' : (health.refreshExpired ? 'expired' : 'unknown'),
            refreshesDone: health.refreshesDone,
            timestamp: Date.now() 
        }));
        return;
    }
    if (req.url === '/status') {
        const health = getRefreshHealthStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            access: {
                expiresAt: tokenLifetime.accessExpiresAt,
                remainingMs: health.accessRemainingMs,
                remainingHuman: health.accessRemainingMs > 0 ? formatRemainingTime(tokenLifetime.accessExpiresAt) : 'EXPIRED'
            },
            refresh: {
                expiresAt: tokenLifetime.refreshExpiresAt,
                remainingMs: health.refreshRemainingMs,
                remainingHuman: health.refreshRemainingMs > 0 ? formatRemainingTime(tokenLifetime.refreshExpiresAt) : (health.refreshExpired ? 'EXPIRED' : 'unknown')
            },
            refreshesDone: health.refreshesDone,
            lastRefreshAgoMs: health.lastSuccessAgo
        }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found — Available: /, /health, /status');
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
