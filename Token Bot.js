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
console.log('[TMC.LOL] ✅ DNS set to Google DNS (8.8.8.8, 1.1.1.1)');

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
const cooldowns = new Map();
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
    if (diff <= 0) return 'EXPIRED';
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
    if (diff <= 0) return 'EXPIRED';
    return `${formatRemainingTime(expiresAt)} (${new Date(expiresAt).toUTCString()})`;
}

function isTokenExpired(tokenObj) {
    if (!tokenObj || !tokenObj.bearer) return true;
    return Date.now() >= getTokenExpiryMs(tokenObj.bearer);
}

function generateGenerationId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = 'GEN-';
    for (let i = 0; i < 6; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
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
        console.log(`[TMC.LOL] Cleaned ${cleaned} stuck token generations`);
    }
}, 30000);

// --- FIND WORKING API URL ---
async function findWorkingApiUrl() {
    console.log('[TMC.LOL] Searching for working API URL...');
    
    for (const url of API_URLS) {
        try {
            console.log(`[TMC.LOL] Testing: ${url}`);
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
                console.log(`[TMC.LOL] ✅ Found working API: ${url}`);
                ACTIVE_API_URL = url;
                apiWorking = true;
                return url;
            } else {
                console.log(`[TMC.LOL] ❌ Not a JSON API: ${url}`);
            }
        } catch (err) {
            console.log(`[TMC.LOL] ❌ Failed: ${url} - ${err.message}`);
        }
    }
    
    console.log('[TMC.LOL] ⚠️ No working API URL found. Using fallback mode.');
    apiWorking = false;
    return API_URLS[0];
}

// --- TOKEN VALIDATION ---
async function validateSteamToken(bearerToken, retries = 3) {
    const expiresAt = getTokenExpiryMs(bearerToken);
    const expired = Date.now() >= expiresAt;
    return {
        valid: !expired,
        status: expired ? 401 : 200,
        data: { valid: !expired },
        expiresAt: expiresAt,
        message: expired ? 'Token is EXPIRED' : `Token is valid, ${formatRemainingTime(expiresAt)} remaining`
    };
}

// --- TOKEN REFRESH SYSTEM ---
async function refreshToken(refreshTk) {
    try {
        console.log('[TMC.LOL] 🔄 Attempting to refresh token via Nakama...');
        
        if (isRefreshing) {
            console.log('[TMC.LOL] ⏳ Refresh in progress, queuing...');
            return new Promise((resolve, reject) => {
                failedQueue.push({ resolve, reject });
            });
        }

        isRefreshing = true;
        console.log('[TMC.LOL] 🔒 Refresh lock acquired');

        const urlsToTry = [...API_URLS];
        if (ACTIVE_API_URL && urlsToTry.includes(ACTIVE_API_URL)) {
            urlsToTry.splice(urlsToTry.indexOf(ACTIVE_API_URL), 1);
            urlsToTry.unshift(ACTIVE_API_URL);
        }

        let lastError = null;

        for (const url of urlsToTry) {
            try {
                const refreshUrl = `${url}/v2/account/session/refresh`;
                console.log(`[TMC.LOL] 🔄 Trying refresh at: ${refreshUrl}`);
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
                    body: JSON.stringify({ 
                        token: refreshTk,
                        refresh_token: refreshTk
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.includes('application/json')) {
                    console.log(`[TMC.LOL] ❌ ${url} - Not JSON response (status ${response.status})`);
                    continue;
                }

                const data = await response.json();
                console.log(`[TMC.LOL] 📦 Response from ${url}:`, JSON.stringify(data).substring(0, 200));

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

                    if (!newBearer || newBearer === refreshTk) {
                        console.log(`[TMC.LOL] ⚠️ ${url} - Refresh returned same token, skipping`);
                        continue;
                    }

                    if (newExpiry <= Date.now()) {
                        console.log(`[TMC.LOL] ⚠️ ${url} - Refreshed token already expired, skipping`);
                        continue;
                    }

                    console.log(`[TMC.LOL] ✅ Successfully refreshed token via ${url}!`);
                    console.log(`[TMC.LOL] New Bearer: ${newBearer.substring(0, 50)}...`);
                    console.log(`[TMC.LOL] New Refresh: ${newRefresh.substring(0, 50)}...`);
                    console.log(`[TMC.LOL] ⏳ ${humanExpiry(newExpiry)}`);

                    DEFAULT_TOKEN.bearer = newBearer;
                    DEFAULT_TOKEN.refresh_token = newRefresh;
                    ACTIVE_API_URL = url;
                    apiWorking = true;
                    refreshAttempts = 0;

                    if (tokenStock.length > 0) {
                        const oldToken = tokenStock[0];
                        const newToken = {
                            bearer: newBearer,
                            refresh: newRefresh,
                            addedAt: Date.now(),
                            expiresAt: newExpiry,
                            id: oldToken.id || generateGenerationId(),
                            userId: oldToken.userId || 'system',
                            username: oldToken.username || 'System'
                        };
                        tokenStock[0] = newToken;
                    } else {
                        tokenStock.push({
                            bearer: newBearer,
                            refresh: newRefresh,
                            addedAt: Date.now(),
                            expiresAt: newExpiry,
                            id: generateGenerationId(),
                            userId: 'system',
                            username: 'System'
                        });
                    }

                    const result = {
                        success: true,
                        bearer: newBearer,
                        refresh: newRefresh,
                        expiresAt: newExpiry
                    };

                    processQueue(null, result);
                    isRefreshing = false;
                    console.log('[TMC.LOL] 🔓 Refresh lock released');
                    return result;
                } else {
                    console.log(`[TMC.LOL] ❌ ${url} - Status: ${response.status}`, data);
                    lastError = data;
                }
            } catch (err) {
                console.log(`[TMC.LOL] ❌ ${url} - ${err.message}`);
                lastError = err.message;
            }
        }

        console.log('[TMC.LOL] ❌ All refresh URLs failed');
        console.log('[TMC.LOL] ⚠️ Last error:', lastError);
        
        if (tokenStock.length > 0) {
            console.log('[TMC.LOL] 📦 Keeping existing token in stock');
            tokenStock[0].expiresAt = getTokenExpiryMs(tokenStock[0].bearer);
        }
        
        processQueue(new Error('All refresh URLs failed'), null);
        isRefreshing = false;
        return { success: false, error: lastError };

    } catch (err) {
        console.error('[TMC.LOL] Refresh error:', err.message);
        processQueue(err, null);
        isRefreshing = false;
        return { success: false, error: err.message };
    }
}

// --- REFRESH TOKEN IN STOCK ---
async function refreshTokenInStock() {
    console.log('[TMC.LOL] 🔄 Auto-refreshing token...');
    
    if (tokenStock.length === 0) {
        console.log('[TMC.LOL] Stock was empty, re-adding default token...');
        tokenStock.push({
            bearer: DEFAULT_TOKEN.bearer,
            refresh: DEFAULT_TOKEN.refresh_token,
            addedAt: Date.now(),
            expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
        });
        return;
    }
    
    const tokenObj = tokenStock[0];
    
    if (!tokenObj.refresh) {
        console.log('[TMC.LOL] ❌ No refresh token in stock!');
        return;
    }
    
    try {
        const refreshResult = await refreshToken(tokenObj.refresh);
        
        if (refreshResult.success) {
            console.log('[TMC.LOL] ✅ Token refreshed with NEW strings!');
            console.log(`[TMC.LOL] New Bearer: ${tokenStock[0].bearer.substring(0, 50)}...`);
            console.log(`[TMC.LOL] ⏳ ${humanExpiry(tokenStock[0].expiresAt)}`);
        } else {
            console.log('[TMC.LOL] ❌ Refresh failed, keeping existing token');
            console.log('[TMC.LOL] ⚠️ Error:', refreshResult.error || 'Unknown error');
            tokenStock[0].expiresAt = getTokenExpiryMs(tokenStock[0].bearer);
            tokenStock[0].addedAt = Date.now();
        }
    } catch (err) {
        console.error('[TMC.LOL] Error in refresh process:', err);
        console.log('[TMC.LOL] ❌ Keeping existing token - refresh failed');
    }
    
    console.log(`[TMC.LOL] Stock count: ${tokenStock.length}`);
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
            console.log('[TMC.LOL] Refresh already in progress, rescheduling...');
            scheduleNextRefresh();
            return;
        }
        if (!apiWorking) {
            await findWorkingApiUrl();
        }
        await refreshTokenInStock();
        scheduleNextRefresh();
    }, delay);

    console.log(`[TMC.LOL] ⏱️ Next auto-refresh in ${Math.round(delay / 1000)}s`);
}

function startAutoRefresh() {
    console.log('[TMC.LOL] ================================');
    console.log('[TMC.LOL] 🔄 AUTO-REFRESH STARTED');
    console.log('[TMC.LOL] ⏳ Tokens refresh BEFORE they expire!');
    console.log('[TMC.LOL] ================================');

    isRefreshing = false;
    failedQueue = [];
    refreshAttempts = 0;

    setTimeout(async () => {
        await findWorkingApiUrl();
        await refreshTokenInStock();
        scheduleNextRefresh();
    }, 5000);
}

// --- PROCESS TOKEN GENERATION ---
async function processTokenGeneration(interaction) {
    const userId = interaction.user.id;
    const member = interaction.member;
    
    await interaction.deferReply({ flags: 64 });
    
    const cooldownKey = `public_${userId}`;
    if (cooldowns.has(cooldownKey)) {
        const cooldownEnd = cooldowns.get(cooldownKey);
        if (Date.now() < cooldownEnd) {
            const remaining = cooldownEnd - Date.now();
            const minutes = Math.floor(remaining / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            return interaction.editReply({
                content: `⏳ **Please wait ${minutes}m ${seconds}s** before generating another token.`
            });
        }
    }
    
    if (activeGenerations.has(userId)) {
        const startTime = activeGenerations.get(userId);
        if (Date.now() - startTime < 60000) {
            return interaction.editReply({
                content: '⏳ **Please wait:** You already have a token generation in progress!'
            });
        } else {
            activeGenerations.delete(userId);
        }
    }
    
    activeGenerations.set(userId, Date.now());
    
    await interaction.editReply({
        content: '⏳ **Generating your token...** (Step 1/4: Starting)'
    });
    
    try {
        if (tokenStock.length === 0) {
            tokenStock.push({
                bearer: DEFAULT_TOKEN.bearer,
                refresh: DEFAULT_TOKEN.refresh_token,
                addedAt: Date.now(),
                expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
            });
        }
        
        await interaction.editReply({
            content: '⏳ **Generating your token...** (Step 2/4: Checking validity)'
        });
        
        let tokenObj = tokenStock[0];
        
        const refreshResult = await refreshToken(tokenObj.refresh);
        if (refreshResult.success) {
            tokenObj = tokenStock[0];
        }
        
        await interaction.editReply({
            content: '⏳ **Generating your token...** (Step 3/4: Finalizing)'
        });
        
        const validationResult = await validateSteamToken(tokenObj.bearer);
        
        if (validationResult.expiresAt) {
            tokenObj.expiresAt = validationResult.expiresAt;
        }
        
        const genId = generateGenerationId();
        tokenObj.id = genId;
        tokenObj.userId = interaction.user.id;
        tokenObj.username = interaction.user.tag;
        
        tokenStock.shift();
        tokenStock.push(tokenObj);
        
        cooldowns.set(`public_${userId}`, Date.now() + 5 * 60 * 1000);
        
        await interaction.editReply({
            content: '⏳ **Generating your token...** (Step 4/4: Sending)'
        });
        
        const expiryText = humanExpiry(tokenObj.expiresAt);
        const tokenExpired = Date.now() >= tokenObj.expiresAt;

        const tokenData = {
            token: {
                bearer: tokenObj.bearer,
                refresh_token: tokenObj.refresh,
                expires_at: new Date(tokenObj.expiresAt).toISOString(),
                added_at: new Date().toISOString(),
                generation_id: genId
            },
            auto_refresh: "Refreshed automatically before expiry"
        };
        
        const jsonString = JSON.stringify(tokenData, null, 2);
        const jsonBuffer = Buffer.from(jsonString, 'utf-8');
        const attachment = new AttachmentBuilder(jsonBuffer, { name: 'token.json' });
        
        const textVersion = `🔑 TOKEN GENERATOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BEARER TOKEN:
${tokenObj.bearer}

REFRESH TOKEN:
${tokenObj.refresh}

GENERATION ID:
${genId}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏳ Valid for: ${expiryText}
🔄 Auto-Refresh: Before expiry
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        
        const textBuffer = Buffer.from(textVersion, 'utf-8');
        const textAttachment = new AttachmentBuilder(textBuffer, { name: 'token.txt' });
        
        const embed = new EmbedBuilder()
            .setTitle('🔑 TOKEN GENERATOR')
            .setDescription('✅ **Token generated successfully!**\n\n' +
                '📁 **Files attached:**\n' +
                '• `token.json` - JSON format\n' +
                '• `token.txt` - Plain text format\n\n' +
                `🆔 **Generation ID:** \`${genId}\`\n` +
                `⏳ **Valid for:** ${expiryText}\n` +
                '🔄 **Auto-Refresh:** Before expiry')
            .setColor(tokenExpired ? 0xED4245 : 0x5865F2)
            .setFooter({ text: 'Auto-Refresh' });
        
        try {
            await interaction.user.send({
                embeds: [embed],
                files: [attachment, textAttachment]
            });
            
            activeGenerations.delete(userId);
            return interaction.editReply({
                content: `✅ **Token sent to your DMs!**\n🆔 **ID:** \`${genId}\`\n⏳ **${expiryText}**\n📦 **Tokens remaining:** ${tokenStock.length}`
            });
        } catch (err) {
            console.error('[TMC.LOL] DM Error:', err);
            activeGenerations.delete(userId);
            
            const fallbackEmbed = new EmbedBuilder()
                .setTitle('🔑 TOKEN GENERATOR')
                .setDescription('⚠️ **Could not send DM!** Here is your token:\n\n' +
                    '📁 **Download the attached files below**\n\n' +
                    `🆔 **Generation ID:** \`${genId}\`\n` +
                    `⏳ **Valid for:** ${expiryText}\n` +
                    '🔄 **Auto-Refresh:** Before expiry')
                .setColor(0xFEE75C)
                .setFooter({ text: 'Auto-Refresh' });
            
            return interaction.editReply({
                embeds: [fallbackEmbed],
                files: [attachment, textAttachment],
                content: '📩 **Token sent here because DMs failed.**'
            });
        }
        
    } catch (err) {
        console.error('[TMC.LOL] Token Generation Error:', err);
        activeGenerations.delete(userId);
        return interaction.editReply({
            content: '❌ **An error occurred. Please try again.**'
        });
    }
}

// --- SLASH COMMANDS ---
const commandsData = [
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Open form to add token stock')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('Post the token generator panel'),
].map(command => command.toJSON());

// --- READY EVENT ---
client.once('ready', async () => {
    try {
        console.log(`[TMC.LOL] 🚀 ONLINE: ${client.user.tag}`);
        console.log('[TMC.LOL] 🔑 Token Generator Active');
        console.log('[TMC.LOL] 🔄 Auto-Refresh Active');
        console.log(`[TMC.LOL] 👑 Connected to ${client.guilds.cache.size} server(s)`);
        console.log('[TMC.LOL] ================================');

        isRefreshing = false;
        failedQueue = [];

        tokenStock = [{
            bearer: DEFAULT_TOKEN.bearer,
            refresh: DEFAULT_TOKEN.refresh_token,
            addedAt: Date.now(),
            expiresAt: getTokenExpiryMs(DEFAULT_TOKEN.bearer)
        }];
        console.log('[TMC.LOL] 📦 Default token added to stock');

        await findWorkingApiUrl();

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        try {
            console.log('[TMC.LOL] 🔄 Registering slash commands...');
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commandsData },
            );
            console.log('[TMC.LOL] ✅ Slash commands registered successfully!');
        } catch (error) {
            console.error('[TMC.LOL] Failed to register slash commands:', error);
        }
        
        startAutoRefresh();
        console.log('[TMC.LOL] ✅ Bot is fully ready!');
    } catch (err) {
        console.error('[TMC.LOL] Ready event error:', err);
    }
});

// --- ERROR HANDLING ---
client.on('error', err => {
    console.error('[TMC.LOL] Client error:', err);
});

client.on('disconnect', () => {
    console.log('[TMC.LOL] Disconnected from Discord, attempting to reconnect...');
});

// --- INTERACTION CREATE ---
client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            const { commandName } = interaction;

            // --- DASHBOARD COMMAND ---
            if (commandName === 'dashboard') {
                const embed = new EmbedBuilder()
                    .setTitle('🔑 TOKEN GENERATOR')
                    .setDescription(
                        'Generate your token below!\n\n' +
                        '⚠️ **Please open your DMs** to receive your token!\n' +
                        '🔄 **Auto-Refresh:** Before expiry\n' +
                        '⏳ **Tokens refresh automatically!**'
                    )
                    .setColor(0x5865F2)
                    .setFooter({ text: 'Auto-Refresh' });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('gen_public')
                        .setLabel('Generate Token')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🔑')
                );

                return interaction.reply({ embeds: [embed], components: [row] });
            }

            // --- STOCK COMMAND (Admin only) ---
            if (commandName === 'stock') {
                const modal = new ModalBuilder()
                    .setCustomId('stock_modal')
                    .setTitle('📦 Add Token Stock');

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
            if (interaction.customId === 'stock_modal') {
                try {
                    await interaction.deferReply({ flags: 64 });
                    
                    const bearer = interaction.fields.getTextInputValue('stock_bearer_input').trim();
                    const refresh = interaction.fields.getTextInputValue('stock_refresh_input').trim();
                    
                    if (!bearer || !refresh) {
                        return interaction.editReply({
                            content: '❌ **Error:** Both Bearer and Refresh tokens are required.'
                        });
                    }

                    // Validate the token
                    const validation = await validateSteamToken(bearer);
                    
                    if (!validation.valid) {
                        return interaction.editReply({
                            content: `❌ **Invalid Token!** The token appears to be expired or invalid.\n\n**Valid for:** ${humanExpiry(validation.expiresAt)}`
                        });
                    }
                    
                    tokenStock.push({
                        bearer,
                        refresh,
                        addedAt: Date.now(),
                        expiresAt: getTokenExpiryMs(bearer)
                    });

                    return interaction.editReply({
                        content: `📦 **Successfully added token to stock!**\n\nTotal tokens: \`${tokenStock.length}\``
                    });
                } catch (err) {
                    console.error('[TMC.LOL] Stock Modal Error:', err);
                    if (interaction.deferred) {
                        return interaction.editReply({
                            content: '❌ **Error:** Failed to process token. Please try again.'
                        });
                    } else {
                        return interaction.reply({
                            content: '❌ **Error:** Failed to process token. Please try again.',
                            flags: 64
                        });
                    }
                }
            }
        }
    } catch (err) {
        console.error(`[TMC.LOL] Interaction Error:`, err);
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: "❌ An error occurred. Please try again.", flags: 64 }).catch(() => {});
        }
    }
});

// --- HEALTH CHECK HTTP SERVER ---
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', bot: 'online', timestamp: Date.now() }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Token Generator Bot is active!\nAuto-refreshes before expiry.\n');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[TMC.LOL] HTTP server running on port ${PORT}`);
});

// --- LOGIN WITH RETRY ---
console.log('[TMC.LOL] 🔑 Attempting to login to Discord...');

if (!process.env.DISCORD_TOKEN) {
    console.error('[TMC.LOL] ❌ DISCORD_TOKEN environment variable is NOT set!');
} else {
    console.log(`[TMC.LOL] ✅ DISCORD_TOKEN is set (length: ${process.env.DISCORD_TOKEN.length})`);
    
    async function loginWithRetry(attempts = 5) {
        for (let i = 1; i <= attempts; i++) {
            try {
                console.log(`[TMC.LOL] 🔄 Login attempt ${i}/${attempts}...`);
                const loginPromise = client.login(process.env.DISCORD_TOKEN);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Login timeout after 30 seconds')), 30000);
                });
                await Promise.race([loginPromise, timeoutPromise]);
                console.log('[TMC.LOL] ✅ Discord login successful!');
                return true;
            } catch (err) {
                console.error(`[TMC.LOL] ❌ Login attempt ${i} failed:`, err.message);
                if (i === attempts) {
                    console.error('[TMC.LOL] ❌ All login attempts failed.');
                    return false;
                }
                await new Promise(resolve => setTimeout(resolve, 5000 * i));
            }
        }
        return false;
    }

    loginWithRetry().then(success => {
        if (!success) {
            console.error('[TMC.LOL] ❌ Bot failed to connect to Discord.');
        }
    });
}

process.on('unhandledRejection', (reason) => {
    console.error('[TMC.LOL] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[TMC.LOL] Uncaught Exception:', err);
});
