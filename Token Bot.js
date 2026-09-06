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
// DEVICE_TOKEN = the LONG hex auth token from the game (NOT the device ID!)
//                Looks like: 140000003124252097EDD94B5D1DCB1601001001AA342F6A...
//                This is the "token" field from the /authenticate/device request body in Insomnia.
//                If empty, re-auth will NOT work — the server requires this hex blob.
const DEVICE_TOKEN = (process.env.DEVICE_TOKEN || '').trim().replace(/^["']|["']$/g, '');
const DEVICE_ID = (process.env.DEVICE_ID || '').trim().replace(/^["']|["']$/g, '');

let ACTIVE_API_URL = API_URLS[0];
let apiWorking = false;
let isRefreshing = false;
let isReAuthing = false;
let failedQueue = [];
let tokenStock = [];
let refreshTokenStack = []; // history of refresh tokens — newest first, try all if one dies
const MAX_REFRESH_STACK = 5;
const cooldowns = new Map();
const activeGenerations = new Map();
let refreshInterval = null;
let refreshRetryCount = 0;
const MAX_REFRESH_RETRIES = 5;
let deviceAuthDead = false;
let lastReAuthAttempt = 0;
const REAUTH_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown between re-auth attempts
const INJECT_SECRET = process.env.INJECT_SECRET || 'tmc-inject-2026'; // simple auth for inject endpoint

// --- TOKEN LIFETIME TRACKING ---
let tokenLifetime = {
    accessExpiresAt: 0,
    refreshExpiresAt: 0,
    lastRefreshSuccess: 0,
    refreshCount: 0
};

// --- DEFAULT TOKEN ---
let DEFAULT_TOKEN = {
  "bearer": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiJmZGYyMjdlOC1kMDFiLTQ1ODYtYjJhOC0zMGI3YTM5YmRlZjkiLCJ1aWQiOiJhMzQ5MTgxOS1lZGNkLTRiZDEtOTJkNS1hODJjZjk5NzBhNjYiLCJ1c24iOiIwelVHYjBrTVhyRGl0b1FYIiwidnJzIjp7ImF1dGhJRCI6Ijk0NDgxZTNlMWJjODQ1MTQ4NDlkZGU2MWMzZDdmNGYwIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiA5Ljk5LjkuOTk5OV9mZmZmZmZmZiIsImRldmljZUlEIjoiMTgzNTc2MWMyYThiNmM2MjliOTlmZmY5ZWRmZjI4OWQ3ZjNlYTEyOCJ9LCJleHAiOjE3ODg3MDQ5MjMsImlhdCI6MTc4ODcwMTMyM30.4MThYjqV0BzvM3QcSn0yFmPc730xosYPZ5jt5zzFSSI",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiJmZGYyMjdlOC1kMDFiLTQ1ODYtYjJhOC0zMGI3YTM5YmRlZjkiLCJ1aWQiOiJhMzQ5MTgxOS1lZGNkLTRiZDEtOTJkNS1hODJjZjk5NzBhNjYiLCJ1c24iOiIwelVHYjBrTVhyRGl0b1FYIiwidnJzIjp7ImF1dGhJRCI6Ijk0NDgxZTNlMWJjODQ1MTQ4NDlkZGU2MWMzZDdmNGYwIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiA5Ljk5LjkuOTk5OV9mZmZmZmZmZiIsImRldmljZUlEIjoiMTgzNTc2MWMyYThiNmM2MjliOTlmZmY5ZWRmZjI4OWQ3ZjNlYTEyOCJ9LCJleHAiOjE3ODg3MjI5MjMsImlhdCI6MTc4ODcwMTMyM30.bkI6FZ7q8QW5kR53T5MQ1xZ0ML3e9OCLgGRhoN7Vbnc"
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
    // Refresh at 25% of access token lifetime (more aggressive), clamp between 15s and 30min
    const bearerLife = getTokenLifetimeMs(DEFAULT_TOKEN.bearer);
    const delay = Math.floor(bearerLife * 0.25);
    const clamped = Math.max(15000, Math.min(delay, 30 * 60 * 1000));
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
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'SteamVR 1.77.4.3069_ddcdd3a4' },
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

// --- SAFETY: reset stuck refresh lock after 15s ---
setInterval(() => {
    if (isRefreshing) {
        console.log('[TMC] Safety: refreshing lock was stuck, force-releasing');
        isRefreshing = false;
        processQueue(new Error('Refresh lock timeout'), null);
    }
}, 15000);

// --- REFRESH TOKEN ---
async function refreshToken(refreshTk) {
    // Build list of tokens to try: input first, then stack
    const tokensToTry = [refreshTk];
    for (const st of refreshTokenStack) {
        if (st !== refreshTk && !tokensToTry.includes(st)) tokensToTry.push(st);
    }

    for (const tk of tokensToTry) {
        const result = await _refreshTokenSingle(tk);
        if (result && result.success) return result;
    }
    return { success: false, error: 'All refresh tokens failed' };
}

async function _refreshTokenSingle(refreshTk) {
    try {
        const refreshExp = getTokenExpiryMs(refreshTk);
        const expired = Date.now() >= refreshExp;
        
        if (expired) {
            console.log(`[TMC] Refresh token expired (${formatRemainingTime(refreshExp)} ago) — trying anyway (server grace period?)`);
        } else {
            const refreshLifeRemaining = refreshExp - Date.now();
            if (refreshLifeRemaining < 5 * 60 * 1000) {
                console.log(`[TMC] WARNING: Refresh token expires in ${formatRemainingTime(refreshExp)} — very low!`);
            }
        }
        
        if (isRefreshing) {
            console.log('[TMC] Refresh in progress, queuing...');
            return new Promise((resolve, reject) => {
                failedQueue.push({ resolve, reject });
            });
        }

        isRefreshing = true;

        const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');
        const MAX_RETRIES = 2;
        const allErrors = [];

        const urlsToTry = [...API_URLS];
        if (ACTIVE_API_URL && urlsToTry.includes(ACTIVE_API_URL)) {
            urlsToTry.splice(urlsToTry.indexOf(ACTIVE_API_URL), 1);
            urlsToTry.unshift(ACTIVE_API_URL);
        }

        for (const url of urlsToTry) {
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const refreshUrl = `${url}/v2/account/session/refresh`;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 20000);

                    const response = await fetch(refreshUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'SteamVR 1.77.4.3069_ddcdd3a4',
                            'Authorization': serverKeyAuth
                        },
                        body: JSON.stringify({ token: refreshTk }),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    let data = null;
                    let rawBody = '';
                    try {
                        rawBody = await response.text();
                        data = JSON.parse(rawBody);
                    } catch (parseErr) {
                        const snippet = rawBody.substring(0, 150).replace(/\s+/g, ' ');
                        console.log(`[TMC] ${url} (${attempt}) - Non-JSON (status ${response.status}): ${snippet}`);
                        allErrors.push(`${url}: non-JSON (${response.status})`);
                        if (response.status >= 500 && attempt < MAX_RETRIES) {
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                        break;
                    }

                    let newBearer = null;
                    let newRefresh = null;

                    if (data.token) { newBearer = data.token; newRefresh = data.refresh_token || refreshTk; }
                    else if (data.access_token) { newBearer = data.access_token; newRefresh = data.refresh_token || refreshTk; }
                    else if (data.bearer) { newBearer = data.bearer; newRefresh = data.refresh_token || refreshTk; }
                    else if (data.session_token) { newBearer = data.session_token; newRefresh = data.refresh_token || refreshTk; }

                    // 401 — try next token in stack
                    if (response.status === 401) {
                        console.log(`[TMC] 401 with this refresh token — will try next in stack`);
                        allErrors.push(`${url}: 401`);
                        isRefreshing = false;
                        return { success: false, error: '401' };
                    }

                    // 429 — rate limited
                    if (response.status === 429) {
                        console.log(`[TMC] Rate limited, waiting 5s...`);
                        allErrors.push(`${url}: 429`);
                        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }

                    // 5xx — server error, retry
                    if (response.status >= 500) {
                        allErrors.push(`${url}: ${response.status}`);
                        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }

                    // SUCCESS
                    if (response.status === 200 && newBearer) {
                        const newExpiry = getTokenExpiryMs(newBearer);
                        const newRefreshExpiry = newRefresh ? getTokenExpiryMs(newRefresh) : 0;

                        if (newExpiry <= Date.now()) {
                            allErrors.push(`${url}: returned expired token`);
                            continue;
                        }

                        console.log(`[TMC] REFRESH OK — Access: ${humanExpiry(newExpiry)}, Refresh: ${newRefreshExpiry > 0 ? humanExpiry(newRefreshExpiry) : 'same'}`);

                        DEFAULT_TOKEN.bearer = newBearer;
                        DEFAULT_TOKEN.refresh_token = newRefresh;
                        ACTIVE_API_URL = url;
                        apiWorking = true;
                        refreshRetryCount = 0;

                        // Push new refresh token to stack (if different)
                        pushRefreshTokenToStack(newRefresh);

                        updateTokenLifetimeTracking(newBearer, newRefresh);

                        if (tokenStock.length > 0) {
                            tokenStock[0] = {
                                bearer: newBearer, refresh: newRefresh,
                                addedAt: Date.now(), expiresAt: newExpiry,
                                refreshExpiresAt: newRefreshExpiry,
                                id: tokenStock[0].id || '', userId: tokenStock[0].userId || 'system',
                                username: tokenStock[0].username || 'System'
                            };
                        } else {
                            tokenStock.push({
                                bearer: newBearer, refresh: newRefresh,
                                addedAt: Date.now(), expiresAt: newExpiry,
                                refreshExpiresAt: newRefreshExpiry,
                                id: '', userId: 'system', username: 'System'
                            });
                        }

                        const result = {
                            success: true, bearer: newBearer, refresh: newRefresh,
                            expiresAt: newExpiry, refreshExpiresAt: newRefreshExpiry, newToken: true
                        };
                        processQueue(null, result);
                        isRefreshing = false;
                        saveTokenState(); // save after EVERY successful refresh
                        return result;
                    }

                    allErrors.push(`${url}: 200 but no token`);

                } catch (err) {
                    const errMsg = err.name === 'AbortError' ? 'timeout' : err.message;
                    allErrors.push(`${url}: ${errMsg}`);
                    if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        console.log(`[TMC] Refresh failed: ${allErrors.join(' | ')}`);
        refreshRetryCount++;
        isRefreshing = false;
        return { success: false, error: allErrors[allErrors.length - 1], retryCount: refreshRetryCount };
    } catch (err) {
        console.error('[TMC] Refresh error:', err.message);
        isRefreshing = false;
        return { success: false, error: err.message };
    }
}

// --- PUSH REFRESH TOKEN TO STACK (dedupe, newest first, max 5) ---
function pushRefreshTokenToStack(tk) {
    if (!tk || typeof tk !== 'string') return;
    // Remove if already exists
    refreshTokenStack = refreshTokenStack.filter(t => t !== tk);
    // Push newest to front
    refreshTokenStack.unshift(tk);
    // Trim to max
    if (refreshTokenStack.length > MAX_REFRESH_STACK) {
        refreshTokenStack = refreshTokenStack.slice(0, MAX_REFRESH_STACK);
    }
    console.log(`[TMC] Refresh token stack: ${refreshTokenStack.length} token(s)`);
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
                'User-Agent': 'SteamVR 1.77.4.3069_ddcdd3a4',
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
                clientUserAgent: "SteamVR 1.77.4.3069_ddcdd3a4",
                deviceID: deviceID
            }
        };

        console.log(`[TMC DEBUG] Device gen — Token length: ${deviceToken.length}, first10: ${deviceToken.substring(0,10)}, last10: ${deviceToken.substring(deviceToken.length-10)}`);
        console.log(`[TMC DEBUG] Device gen — DeviceID: ${deviceID}`);

        const response = await fetch(`${authUrl}?create=true&sync=false`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
                'Connection': 'keep-alive',
                'Accept': '*/*',
                'Accept-Encoding': 'deflate, gzip',
                'Authorization': serverKeyAuth,
                'x-unity-version': '6000.3.12f1'
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
            saveTokenState();
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

// --- FRESH DEVICE AUTH (no side effects — for user gens) ---
// does NOT update DEFAULT_TOKEN, tokenStock, or any global state
// returns a brand new independent token pair
async function freshDeviceAuth() {
    const dt = DEVICE_TOKEN;
    const did = DEVICE_ID;
    if (!dt || dt.length < 50) {
        return { success: false, error: 'DEVICE_TOKEN not set' };
    }
    if (!did || did.length < 5) {
        return { success: false, error: 'DEVICE_ID not set' };
    }

    const authUrl = `${ACTIVE_API_URL}/v2/account/authenticate/device`;
    const serverKeyAuth = 'Basic ' + Buffer.from(NAKAMA_SERVER_KEY + ':').toString('base64');

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const response = await fetch(`${authUrl}?create=true&sync=false`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
                'Connection': 'keep-alive',
                'Accept': '*/*',
                'Accept-Encoding': 'deflate, gzip',
                'Authorization': serverKeyAuth,
                'x-unity-version': '6000.3.12f1'
            },
            body: JSON.stringify({
                token: dt,
                vars: {
                    clientUserAgent: "SteamVR 1.77.4.3069_ddcdd3a4",
                    deviceID: did
                }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await response.json();

        let newBearer = data.token || data.access_token || data.bearer || null;
        let newRefresh = data.refresh_token || null;

        if (response.status === 200 && newBearer) {
            const newExpiry = getTokenExpiryMs(newBearer);
            console.log(`[TMC] Fresh device auth OK — expires ${humanExpiry(newExpiry)}`);
            return {
                success: true,
                bearer: newBearer,
                refresh: newRefresh,
                expiresAt: newExpiry
            };
        } else {
            const errMsg = data ? (data.message || data.error || JSON.stringify(data)) : 'no body';
            console.log(`[TMC] Fresh device auth failed (${response.status}): ${errMsg}`);
            return { success: false, error: `Status ${response.status}: ${errMsg}` };
        }
    } catch (err) {
        const errMsg = err.name === 'AbortError' ? 'timeout' : err.message;
        console.log(`[TMC] Fresh device auth error: ${errMsg}`);
        return { success: false, error: errMsg };
    }
}

// --- AUTO RE-AUTH FROM DEVICE (when refresh token dies) ---
async function autoReAuthFromDevice() {
    // If device auth is already confirmed dead, don't bother
    if (deviceAuthDead) {
        console.log('[TMC] Device auth confirmed dead (400) — skipping. POST to /inject to add fresh tokens.');
        return { success: false, error: 'Device auth dead — use /inject endpoint' };
    }

    // Respect cooldown
    const now = Date.now();
    if (now - lastReAuthAttempt < REAUTH_COOLDOWN_MS) {
        const cooldownLeft = Math.round((REAUTH_COOLDOWN_MS - (now - lastReAuthAttempt)) / 60000);
        console.log(`[TMC] Re-auth cooldown — try again in ${cooldownLeft}min. POST to /inject to skip.`);
        return { success: false, error: `Re-auth cooldown — ${cooldownLeft}min remaining` };
    }
    
    // Validate both credentials
    if (!DEVICE_ID) {
        console.log('[TMC] !! DEVICE_ID not set — cannot auto re-auth !!');
        console.log('[TMC] !! POST fresh tokens to /inject endpoint instead !!');
        return { success: false, error: 'No DEVICE_ID configured.' };
    }
    if (!DEVICE_TOKEN || DEVICE_TOKEN.length < 50) {
        console.log('[TMC] !! DEVICE_TOKEN not set — cannot auto re-auth !!');
        console.log('[TMC] !! POST fresh tokens to /inject endpoint instead !!');
        return { success: false, error: 'No valid DEVICE_TOKEN configured.' };
    }
    
    if (isReAuthing) {
        console.log('[TMC] Re-auth already in progress, skipping...');
        return { success: false, error: 'Re-auth in progress' };
    }
    
    isReAuthing = true;
    lastReAuthAttempt = Date.now();
    console.log('[TMC] ==========================================');
    console.log('[TMC] AUTO RE-AUTH: Attempting device auth (will not retry for 30min if 400)...');
    console.log('[TMC] ==========================================');
    
    try {
        // Try all URLs
        const urlsToTry = [...API_URLS];
        if (ACTIVE_API_URL && urlsToTry.includes(ACTIVE_API_URL)) {
            urlsToTry.splice(urlsToTry.indexOf(ACTIVE_API_URL), 1);
            urlsToTry.unshift(ACTIVE_API_URL);
        }
        
        // Steam auth session tickets (hex protobuf starting with 14000000)
        // Use /authenticate/device endpoint
        const authEndpoints = [
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
                        token: DEVICE_TOKEN,
                        vars: {
                            clientUserAgent: "SteamVR 1.77.4.3069_ddcdd3a4",
                            deviceID: DEVICE_ID
                        }
                    };

                    // DEBUG: log what we're actually sending
                    const bodyStr = JSON.stringify(body);
                    console.log(`[TMC DEBUG] Endpoint: ${authUrl}?create=true&sync=false`);
                    console.log(`[TMC DEBUG] Token length: ${DEVICE_TOKEN.length}, first10: ${DEVICE_TOKEN.substring(0,10)}, last10: ${DEVICE_TOKEN.substring(DEVICE_TOKEN.length-10)}`);
                    console.log(`[TMC DEBUG] DeviceID: ${DEVICE_ID}`);
                    console.log(`[TMC DEBUG] Body length: ${bodyStr.length}`);
                    console.log(`[TMC DEBUG] Full body: ${bodyStr}`);
                    console.log(`[TMC DEBUG] serverKeyAuth: ${serverKeyAuth}`);

                    const response = await fetch(`${authUrl}?create=true&sync=false`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)',
                            'Connection': 'keep-alive',
                            'Accept': '*/*',
                            'Accept-Encoding': 'deflate, gzip',
                            'Authorization': serverKeyAuth,
                            'x-unity-version': '6000.3.12f1'
                        },
                        body: bodyStr,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    
                    console.log(`[TMC DEBUG] Response status: ${response.status}`);

                    let data = null;
                    let rawBody = '';
                    try {
                        rawBody = await response.text();
                        console.log(`[TMC DEBUG] Response body: ${rawBody.substring(0, 500)}`);
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

                    // 400 = token consumed/expired — device auth is dead, stop retrying
                    if (response.status === 400) {
                        console.log('[TMC] !! Device auth ticket is CONSUMED/DEAD (400) — will not retry !!');
                        console.log('[TMC] !! The Steam auth ticket was already used by the game !!');
                        console.log('[TMC] !! To recover: POST fresh tokens to /inject endpoint or use Discord /inject !!');
                        deviceAuthDead = true;
                        isReAuthing = false;
                        processQueue(new Error('Device auth dead (400) — use /inject'), null);
                        return { success: false, error: 'Device auth dead (400)' };
                    }

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
                        
                        saveTokenState();
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

// --- TOKEN PERSISTENCE (saves to file so restarts don't kill tokens) ---
const fs = require('fs');
const path = require('path');
const TOKEN_STATE_FILE = path.join(process.cwd(), 'token_state.json');

function saveTokenState() {
    try {
        const state = {
            bearer: DEFAULT_TOKEN.bearer,
            refresh_token: DEFAULT_TOKEN.refresh_token,
            refreshTokenStack: refreshTokenStack.slice(0, MAX_REFRESH_STACK),
            tokenLifetime: { ...tokenLifetime },
            savedAt: Date.now()
        };
        fs.writeFileSync(TOKEN_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
        console.error('[TMC] Failed to save token state:', err.message);
    }
}

function loadTokenState() {
    try {
        if (!fs.existsSync(TOKEN_STATE_FILE)) {
            console.log('[TMC] No saved token state found, using defaults');
            return false;
        }
        const raw = fs.readFileSync(TOKEN_STATE_FILE, 'utf-8');
        const state = JSON.parse(raw);
        
        if (!state.bearer || !isValidJwt(state.bearer)) {
            console.log('[TMC] Saved bearer token invalid, using defaults');
            return false;
        }
        
        const bearerExp = getTokenExpiryMs(state.bearer);
        const now = Date.now();
        
        // If saved bearer is still valid, use it
        if (bearerExp > now) {
            DEFAULT_TOKEN.bearer = state.bearer;
            if (state.refresh_token && isValidJwt(state.refresh_token)) {
                DEFAULT_TOKEN.refresh_token = state.refresh_token;
            }
            // Restore refresh token stack
            if (Array.isArray(state.refreshTokenStack)) {
                refreshTokenStack = state.refreshTokenStack.filter(t => isValidJwt(t));
                if (refreshTokenStack.length > 0) console.log(`[TMC] Restored ${refreshTokenStack.length} refresh token(s) from stack`);
            }
            console.log(`[TMC] Loaded saved token state — access: ${humanExpiry(bearerExp)}`);
            return true;
        }
        
        // Bearer expired but refresh might still work
        if (state.refresh_token && isValidJwt(state.refresh_token)) {
            const refreshExp = getTokenExpiryMs(state.refresh_token);
            if (refreshExp > now) {
                DEFAULT_TOKEN.bearer = state.bearer;
                DEFAULT_TOKEN.refresh_token = state.refresh_token;
                // Restore refresh token stack
                if (Array.isArray(state.refreshTokenStack)) {
                    refreshTokenStack = state.refreshTokenStack.filter(t => isValidJwt(t));
                    if (refreshTokenStack.length > 0) console.log(`[TMC] Restored ${refreshTokenStack.length} refresh token(s) from stack`);
                }
                console.log(`[TMC] Loaded saved state — bearer expired but refresh alive: ${humanExpiry(refreshExp)}`);
                return true;
            }
        }
        
        console.log('[TMC] Saved tokens all expired, using defaults');
        return false;
    } catch (err) {
        console.error('[TMC] Failed to load token state:', err.message);
        return false;
    }
}

// Auto-save token state every 2 minutes (safety net)
setInterval(() => {
    if (DEFAULT_TOKEN.bearer) saveTokenState();
}, 2 * 60 * 1000);

// --- AUTO-REFRESH: every 60 seconds, no matter what ---
const REFRESH_INTERVAL_MS = 60 * 1000; // 60 seconds

function scheduleNextRefresh() {
    if (refreshInterval) clearTimeout(refreshInterval);

    const accessTimeLeft = tokenLifetime.accessExpiresAt - Date.now();
    const refreshTimeLeft = tokenLifetime.refreshExpiresAt - Date.now();

    // --- Refresh token dead or critical → full device re-auth ---
    if (tokenLifetime.refreshExpiresAt > 0 && refreshTimeLeft <= 0) {
        console.log('[TMC] Refresh token EXPIRED — checking re-auth options...');
        refreshInterval = setTimeout(async () => {
            refreshInterval = null;
            if (isReAuthing) { scheduleNextRefresh(); return; }
            if (!deviceAuthDead) {
                if (!apiWorking) await findWorkingApiUrl();
                await autoReAuthFromDevice();
            } else {
                console.log('[TMC] Refresh expired + device auth dead — waiting for /inject');
            }
            saveTokenState();
            scheduleNextRefresh();
        }, 2000);
        return;
    }

    // --- Access token expired → try refresh, then re-auth if it fails ---
    if (accessTimeLeft <= 0) {
        console.log('[TMC] Access token expired! Trying refresh...');
        refreshInterval = setTimeout(async () => {
            refreshInterval = null;
            if (!apiWorking) await findWorkingApiUrl();
            const result = await refreshTokenInStock();
            if (!result || !result.success) {
                console.log('[TMC] Refresh failed on expired token — device re-auth...');
                await autoReAuthFromDevice();
                saveTokenState();
            } else {
                refreshRetryCount = 0;
                saveTokenState();
            }
            scheduleNextRefresh();
        }, 5000);
        return;
    }

    // --- NORMAL: refresh every 60 seconds flat ---
    console.log(`[TMC] Next refresh in 60s (${formatRemainingTime(tokenLifetime.accessExpiresAt)} access left)`);

    refreshInterval = setTimeout(async () => {
        refreshInterval = null;
        if (isRefreshing) { scheduleNextRefresh(); return; }
        if (!apiWorking) await findWorkingApiUrl();

        const result = await refreshTokenInStock();

        if (!result || !result.success) {
            refreshRetryCount++;
            const errMsg = result ? (result.error || '') : '';
            const isAuthFailure = errMsg.includes('401') || errMsg.includes('expired') || errMsg.includes('invalid') ||
                                  errMsg.includes('Unauthorized') || errMsg.includes('token') || errMsg.includes('auth');

            if (isAuthFailure || refreshRetryCount >= 3) {
                console.log(`[TMC] Refresh failed (${isAuthFailure ? 'auth error' : 'max retries'}) — checking re-auth...`);
                refreshRetryCount = 0;
                if (!deviceAuthDead) {
                    await autoReAuthFromDevice();
                } else {
                    console.log('[TMC] Device auth dead — waiting for /inject to recover');
                }
                saveTokenState();
                scheduleNextRefresh();
                return;
            }

            console.log(`[TMC] Refresh failed (attempt ${refreshRetryCount}), will retry in 60s`);
        } else {
            refreshRetryCount = 0;
            saveTokenState();
        }

        scheduleNextRefresh();
    }, REFRESH_INTERVAL_MS);
}

function startAutoRefresh() {
    console.log('[TMC] Auto-refresh starting — interval: 60 seconds');
    console.log('[TMC] Every 60s: refresh token → if fails → device re-auth → repeat forever');
    if (!DEVICE_ID) {
        console.log('[TMC] !! DEVICE_ID NOT SET — auto re-auth will not work !!');
    } else if (!DEVICE_TOKEN || DEVICE_TOKEN.length < 50) {
        console.log('[TMC] !! DEVICE_TOKEN NOT SET or invalid — auto re-auth will not work !!');
        console.log('[TMC] !! DEVICE_TOKEN must be the long hex auth token (NOT the device ID) !!');
    } else {
        console.log('[TMC] Device auth: READY');
    }
    isRefreshing = false;
    isReAuthing = false;
    failedQueue = [];
    refreshRetryCount = 0;
    
    // Try to load saved token state from file
    loadTokenState();
    
    setTimeout(async () => {
        await findWorkingApiUrl();
        
        // Initialize token lifetime tracking
        updateTokenLifetimeTracking(DEFAULT_TOKEN.bearer, DEFAULT_TOKEN.refresh_token);
        
        const refreshTimeLeft = tokenLifetime.refreshExpiresAt - Date.now();
        const accessTimeLeft = tokenLifetime.accessExpiresAt - Date.now();
        
        // Push initial refresh token to stack
        if (DEFAULT_TOKEN.refresh_token) {
            pushRefreshTokenToStack(DEFAULT_TOKEN.refresh_token);
        }

        // Check if tokens are completely dead on startup
        if (refreshTimeLeft <= 0 && accessTimeLeft <= 0) {
            console.log('[TMC] Both tokens expired on startup');
            if (!deviceAuthDead) {
                console.log('[TMC] Attempting device re-auth (will mark dead on 400)...');
                const reAuthResult = await autoReAuthFromDevice();
                if (!reAuthResult || !reAuthResult.success) {
                    console.log('[TMC] !! Startup re-auth failed. POST to /inject or use Discord /inject !!');
                }
            } else {
                console.log('[TMC] !! Device auth dead — POST fresh tokens to /inject or use Discord /inject !!');
            }
        } else if (refreshTimeLeft <= 60 * 60 * 1000) {
            // Refresh token is low — proactively re-auth to get fresh one
            if (!deviceAuthDead) {
                console.log('[TMC] Refresh token low on startup — proactively re-authing for fresh token...');
                await autoReAuthFromDevice();
            } else {
                console.log('[TMC] Refresh token low on startup — device auth dead, waiting for /inject');
            }
        } else {
            // Tokens look okay — do first refresh to validate session
            const result = await refreshTokenInStock();
            if (!result || !result.success) {
                console.log('[TMC] First refresh failed, will attempt re-auth on next cycle');
            }
        }
        
        // Start smart scheduling
        scheduleNextRefresh();
    }, 1500);
    
    // --- WATCHDOG: safety net every 60 seconds ---
    setInterval(async () => {
        const now = Date.now();
        const accessTimeLeft = tokenLifetime.accessExpiresAt - now;
        const refreshTimeLeft = tokenLifetime.refreshExpiresAt - now;

        // If no refresh is scheduled and token exists, something stalled — actively refresh
        if (!refreshInterval && !isRefreshing && !isReAuthing && DEFAULT_TOKEN.bearer) {
            console.log('[TMC] Watchdog: stalled — actively refreshing now');
            const result = await refreshTokenInStock();
            if (!result || !result.success) {
                console.log('[TMC] Watchdog: refresh failed, will keep trying');
            }
            scheduleNextRefresh();
            return;
        }

        // Both tokens dead and not already handling it → emergency refresh (try anyway)
        if (accessTimeLeft <= 0 && refreshTimeLeft <= 0 && !isReAuthing) {
            console.log('[TMC] Watchdog: both tokens dead — emergency refresh attempt');
            const result = await refreshTokenInStock();
            if (!result || !result.success) {
                if (!deviceAuthDead) {
                    await autoReAuthFromDevice();
                } else {
                    console.log('[TMC] Watchdog: waiting for /inject');
                }
            }
            saveTokenState();
            scheduleNextRefresh();
        }

        // Access token critically low (< 3 min) and not refreshing — force refresh
        if (accessTimeLeft > 0 && accessTimeLeft < 3 * 60 * 1000 && !isRefreshing && !isReAuthing) {
            console.log('[TMC] Watchdog: access token critical — forcing refresh');
            await refreshTokenInStock();
            saveTokenState();
        }
    }, 60 * 1000);
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
        await interaction.editReply({ content: 'Generating fresh token via device auth...' });

        // FRESH device auth → gives the user their OWN independent token
        // this token is NOT in the stock, so auto-refresh won't kill it
        let userBearer = null;
        let userRefresh = null;
        let userExpiresAt = 0;

        const freshResult = await freshDeviceAuth();
        if (freshResult && freshResult.success) {
            userBearer = freshResult.bearer;
            userRefresh = freshResult.refresh;
            userExpiresAt = freshResult.expiresAt;
            console.log(`[TMC] Fresh token for user: ${humanExpiry(userExpiresAt)}`);
        } else {
            // device auth failed — fall back to stock token (may get invalidated by refresh)
            console.log(`[TMC] Device auth failed for user gen: ${freshResult ? freshResult.error : 'unknown'}, falling back to stock`);
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
            userBearer = tokenObj.bearer;
            userRefresh = tokenObj.refresh;
            userExpiresAt = tokenObj.expiresAt;
        }

        if (!hasNoCooldown) {
            cooldowns.set(`public_${userId}`, Date.now() + 5 * 60 * 1000);
        }

        const expiryText = humanExpiry(userExpiresAt);
        const tokenExpired = Date.now() >= userExpiresAt;

        const tokenData = {
            token: {
                bearer: userBearer,
                refresh_token: userRefresh
            }
        };
        
        const jsonString = JSON.stringify(tokenData, null, 2);
        const jsonBuffer = Buffer.from(jsonString, 'utf-8');
        const attachment = new AttachmentBuilder(jsonBuffer, { name: 'token.json' });
        
        const embed = new EmbedBuilder()
            .setDescription(
                `Fresh token generated!\n\n` +
                `token.json attached\n\n` +
                `Status: **${expiryText}**\n` +
                `Source: **Device Auth** (independent, won't be refreshed by bot)`
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
                    `Fresh token generated!\n\n` +
                    `token.json attached\n\n` +
                    `Status: **${expiryText}**\n` +
                    `Source: **Device Auth**`
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
    new SlashCommandBuilder()
        .setName('inject')
        .setDescription('Inject fresh tokens to keep bot alive')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

// --- READY ---
client.once('ready', async () => {
    console.log(`[TMC] ONLINE: ${client.user.tag}`);
    console.log(`[TMC] Connected to ${client.guilds.cache.size} server(s)`);

    // Load saved token state first
    loadTokenState();

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
                const deviceStatus = deviceAuthDead ? 'Device Auth: **DEAD** (use /inject)' : (DEVICE_ID ? (DEVICE_TOKEN && DEVICE_TOKEN.length >= 50 ? 'Device Auth: **READY**' : 'Device Auth: **MISSING TOKEN**') : 'Device Auth: **NOT SET**');
                const reAuthStatus = isReAuthing ? 'Re-auth: **IN PROGRESS**' : '';
                
                const embed = new EmbedBuilder()
                    .setDescription(
                        `**TMC Gen**\n\n` +
                        `Generate, refresh, and manage your tokens.\n\n` +
                        `${accessStatus}\n${refreshStatus}\n${deviceStatus}` +
                        (reAuthStatus ? `\n${reAuthStatus}` : '') +
                        `\nRefreshes done: **${health.refreshesDone}**` +
                        (deviceAuthDead ? `\n\n**Bot is alive but needs fresh tokens.**\nUse \`/inject\` or POST to \`/inject\` endpoint.` : '')
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

                return interaction.reply({ embeds: [embed], components: [row1] });
            }

            if (commandName === 'inject') {
                const modal = new ModalBuilder()
                    .setCustomId('inject_modal')
                    .setTitle('Inject Fresh Tokens');

                const bearerInput = new TextInputBuilder()
                    .setCustomId('inject_bearer')
                    .setLabel("PASTE YOUR BEARER TOKEN")
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(2000);

                const refreshInput = new TextInputBuilder()
                    .setCustomId('inject_refresh')
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

            if (interaction.customId === 'inject_modal') {
                await interaction.deferReply({ flags: 64 });
                try {
                    const bearerInput = interaction.fields.getTextInputValue('inject_bearer').trim();
                    const refreshInput = interaction.fields.getTextInputValue('inject_refresh').trim();

                    if (!bearerInput || !refreshInput) {
                        return interaction.editReply({ content: 'Both tokens required.' });
                    }
                    if (!isValidJwt(bearerInput)) {
                        return interaction.editReply({ content: 'Invalid bearer token format.' });
                    }
                    if (!isValidJwt(refreshInput)) {
                        return interaction.editReply({ content: 'Invalid refresh token format.' });
                    }

                    const newExpiry = getTokenExpiryMs(bearerInput);
                    if (newExpiry <= Date.now()) {
                        return interaction.editReply({ content: 'Bearer token is already expired.' });
                    }

                    // Apply tokens
                    DEFAULT_TOKEN.bearer = bearerInput;
                    DEFAULT_TOKEN.refresh_token = refreshInput;
                    pushRefreshTokenToStack(refreshInput);
                    deviceAuthDead = false;
                    refreshRetryCount = 0;
                    apiWorking = true;

                    if (tokenStock.length > 0) {
                        tokenStock[0] = {
                            bearer: bearerInput,
                            refresh: refreshInput,
                            addedAt: Date.now(),
                            expiresAt: newExpiry,
                            refreshExpiresAt: getTokenExpiryMs(refreshInput),
                            id: tokenStock[0].id || '',
                            userId: interaction.user.id,
                            username: interaction.user.username
                        };
                    } else {
                        tokenStock.push({
                            bearer: bearerInput,
                            refresh: refreshInput,
                            addedAt: Date.now(),
                            expiresAt: newExpiry,
                            refreshExpiresAt: getTokenExpiryMs(refreshInput),
                            id: '',
                            userId: interaction.user.id,
                            username: interaction.user.username
                        });
                    }

                    updateTokenLifetimeTracking(bearerInput, refreshInput);
                    saveTokenState();

                    // Restart refresh cycle
                    isRefreshing = false;
                    isReAuthing = false;
                    failedQueue = [];
                    processQueue(null, { success: true, bearer: bearerInput, refresh: refreshInput, expiresAt: newExpiry });
                    scheduleNextRefresh();

                    const embed = new EmbedBuilder()
                        .setDescription(
                            `Tokens injected!\n\n` +
                            `Access: **${humanExpiry(newExpiry)}**\n` +
                            `Refresh: **${humanExpiry(getTokenExpiryMs(refreshInput))}**\n` +
                            `Device auth reset: **YES**\n` +
                            `Refresh cycle restarted: **YES**`
                        )
                        .setColor(0x2ECC71)
                        .setFooter({ text: 'TMC Inject' });

                    return interaction.editReply({ embeds: [embed] });
                } catch (err) {
                    console.error('[TMC] Inject modal error:', err);
                    return interaction.editReply({ content: 'Error injecting tokens.' });
                }
            }
        }
    } catch (err) {
        console.error(`[TMC] Error:`, err);
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: "Error. Try again.", flags: 64 }).catch(() => {});
        }
    }
});

// --- INJECT TOKENS (POST fresh tokens to keep bot alive) ---
function handleInject(req, res) {
    // Read body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            // Check auth header
            const authHeader = req.headers['authorization'] || '';
            const injectKey = authHeader.replace('Bearer ', '').trim();
            if (injectKey !== INJECT_SECRET) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized — send Authorization: Bearer <INJECT_SECRET>' }));
                return;
            }

            const data = JSON.parse(body);
            const newBearer = data.bearer || data.token || data.access_token;
            const newRefresh = data.refresh_token || data.refresh;

            if (!newBearer) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing bearer/token field' }));
                return;
            }

            // Validate it's a real JWT
            if (!isValidJwt(newBearer)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JWT format for bearer' }));
                return;
            }

            const newExpiry = getTokenExpiryMs(newBearer);
            if (newExpiry <= Date.now()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Injected bearer token is already expired' }));
                return;
            }

            // Apply
            DEFAULT_TOKEN.bearer = newBearer;
            if (newRefresh && isValidJwt(newRefresh)) {
                DEFAULT_TOKEN.refresh_token = newRefresh;
                pushRefreshTokenToStack(newRefresh);
            }
            deviceAuthDead = false; // reset — might have fresh tokens now
            refreshRetryCount = 0;
            apiWorking = true;

            // Update stock
            if (tokenStock.length > 0) {
                tokenStock[0] = {
                    bearer: newBearer,
                    refresh: newRefresh || DEFAULT_TOKEN.refresh_token,
                    addedAt: Date.now(),
                    expiresAt: newExpiry,
                    refreshExpiresAt: newRefresh ? getTokenExpiryMs(newRefresh) : tokenStock[0].refreshExpiresAt,
                    id: tokenStock[0].id || '',
                    userId: tokenStock[0].userId || 'inject',
                    username: tokenStock[0].username || 'Inject'
                };
            } else {
                tokenStock.push({
                    bearer: newBearer,
                    refresh: newRefresh || DEFAULT_TOKEN.refresh_token,
                    addedAt: Date.now(),
                    expiresAt: newExpiry,
                    refreshExpiresAt: newRefresh ? getTokenExpiryMs(newRefresh) : 0,
                    id: '',
                    userId: 'inject',
                    username: 'Inject'
                });
            }

            updateTokenLifetimeTracking(newBearer, newRefresh || DEFAULT_TOKEN.refresh_token);
            saveTokenState();

            // Restart refresh cycle
            if (isRefreshing || isReAuthing) {
                console.log('[TMC] INJECT: Tokens received while re-auth in progress — overriding');
                isRefreshing = false;
                isReAuthing = false;
                failedQueue = [];
                processQueue(null, { success: true, bearer: newBearer, refresh: newRefresh, expiresAt: newExpiry });
            }
            scheduleNextRefresh();

            console.log(`[TMC] INJECT: Fresh tokens injected! Access: ${humanExpiry(newExpiry)}`);
            if (newRefresh) console.log(`[TMC] INJECT: Refresh: ${humanExpiry(getTokenExpiryMs(newRefresh))}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                accessExpiresIn: Math.round((newExpiry - Date.now()) / 1000) + 's',
                refreshExpiresIn: newRefresh ? Math.round((getTokenExpiryMs(newRefresh) - Date.now()) / 1000) + 's' : 'unknown',
                refreshesDone: tokenLifetime.refreshCount,
                refreshTokenStackSize: refreshTokenStack.length
            }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
        }
    });
}

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
            deviceAuthDead: deviceAuthDead,
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
            lastRefreshAgoMs: health.lastSuccessAgo,
            deviceAuthDead: deviceAuthDead
        }));
        return;
    }
    if (req.url === '/inject' && req.method === 'POST') {
        return handleInject(req, res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found — Available: /, /health, /status, POST /inject');
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
