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

// --- TOKEN VALIDATION ---
async function validateSteamToken(bearerToken, retries = 3) {
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

// --- TOKEN REFRESH SYSTEM ---
async function refreshToken(refreshTk) {
    try {
        console.log('[TMC] 🔄 Attempting to refresh token via Nakama...');
        
        if (isRefreshing) {
            console.log('[TMC] ⏳ Refresh in progress, queuing...');
            return new Promise((resolve, reject) => {
                failedQueue.push({ resolve, reject });
            });
        }

        isRefreshing = true;
        console.log('[TMC] 🔒 Refresh lock acquired');

        const urlsToTry = [...API_URLS];
        if (ACTIVE_API_URL && urlsToTry.includes(ACTIVE_API_URL)) {
            urlsToTry.splice(urlsToTry.indexOf(ACTIVE_API_URL), 1);
            urlsToTry.unshift(ACTIVE_API_URL);
        }

        let lastError = null;

        for (const url of urlsToTry) {
            try {
                const refreshUrl = `${url}/v2/account/session/refresh`;
                console.log(`[TMC] 🔄 Trying refresh at: ${refreshUrl}`);
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
                    console.log(`[TMC] ❌ ${url} - Not JSON response (status ${response.status})`);
                    continue;
                }

                const data = await response.json();
                console.log(`[TMC] 📦 Response from ${url}:`, JSON.stringify(data).substring(0, 200));

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
                        console.log(`[TMC] ⚠️ ${url} - Refresh returned same token, skipping`);
                        continue;
                    }

                    if (newExpiry <= Date.now()) {
                        console.log(`[TMC] ⚠️ ${url} - Refreshed token already expired, skipping`);
                        continue;
                    }

                    console.log(`[TMC] ✅ Successfully refreshed token via ${url}!`);
                    console.log(`[TMC] New Bearer: ${newBearer.substring(0, 50)}...`);
                    console.log(`[TMC] New Refresh: ${newRefresh.substring(0, 50)}...`);
                    console.log(`[TMC] ⏳ ${humanExpiry(newExpiry)}`);

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
                            id: oldToken.id,
                            userId: oldToken.userId,
                            username: oldToken.username
                        };
                        tokenStock[0] = newToken;
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
                        expiresAt: newExpiry
                    };

                    processQueue(null, result);
                    isRefreshing = false;
                    console.log('[TMC] 🔓 Refresh lock released');
                    return result;
                } else {
                    console.log(`[TMC] ❌ ${url} - Status: ${response.status}`, data);
                    lastError = data;
                }
            } catch (err) {
                console.log(`[TMC] ❌ ${url} - ${err.message}`);
                lastError = err.message;
            }
        }

        console.log('[TMC] ❌ All refresh URLs failed');
        console.log('[TMC] ⚠️ Last error:', lastError);
        
        if (tokenStock.length > 0) {
            console.log('[TMC] 📦 Keeping existing token in stock');
            tokenStock[0].expiresAt = getTokenExpiryMs(tokenStock[0].bearer);
        }
        
        processQueue(new Error('All refresh URLs failed'), null);
        isRefreshing = false;
        return { success: false, error: lastError };

    } catch (err) {
        console.error('[TMC] Refresh error:', err.message);
        processQueue(err, null);
        isRefreshing = false;
        return { success: false, error: err.message };
    }
}

// --- REFRESH TOKEN IN STOCK ---
async function refreshTokenInStock() {
    console.log('[TMC] 🔄 Auto-refreshing token...');
    
    if (tokenStock.length === 0) {
        console.log('[TMC] Stock was empty, re-adding default token...');
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
        console.log('[TMC] ❌ No refresh token in stock!');
        return;
    }
    
    try {
        const refreshResult = await refreshToken(tokenObj.refresh);
        
        if (refreshResult.success) {
            console.log('[TMC] ✅ Token refreshed with NEW strings!');
            console.log(`[TMC] New Bearer: ${tokenStock[0].bearer.substring(0, 50)}...`);
            console.log(`[TMC] ⏳ ${humanExpiry(tokenStock[0].expiresAt)}`);
        } else {
            console.log('[TMC] ❌ Refresh failed, keeping existing token');
            console.log('[TMC] ⚠️ Error:', refreshResult.error || 'Unknown error');
            tokenStock[0].expiresAt = getTokenExpiryMs(tokenStock[0].bearer);
            tokenStock[0].addedAt = Date.now();
        }
    } catch (err) {
        console.error('[TMC] Error in refresh process:', err);
        console.log('[TMC] ❌ Keeping existing token - refresh failed');
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
        if (!apiWorking) {
            await findWorkingApiUrl();
        }
        await refreshTokenInStock();
        scheduleNextRefresh();
    }, delay);

    console.log(`[TMC] ⏱️ Next auto-refresh in ${Math.round(delay / 1000)}s`);
}

function startAutoRefresh() {
    console.log('[TMC] ================================');
    console.log('[TMC] 🔄 AUTO-REFRESH STARTED');
    console.log('[TMC] ⏳ Tokens refresh BEFORE they expire!');
    console.log('[TMC] ================================');

    isRefreshing = false;
    failedQueue = [];
    refreshAttempts = 0;

    setTimeout(async () => {
        await findWorkingApiUrl();
        await refreshTokenInStock();
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
            return interaction.editReply({
                content: '⏳ Please wait...'
            });
        } else {
            activeGenerations.delete(userId);
        }
    }
    
    activeGenerations.set(userId, Date.now());
    
    await interaction.editReply({
        content: '⏳ Generating...'
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
            content: '⏳ Validating...'
        });
        
        let tokenObj = tokenStock[0];
        
        const refreshResult = await refreshToken(tokenObj.refresh);
        if (refreshResult.success) {
            tokenObj = tokenStock[0];
        }
        
        await interaction.editReply({
            content: '⏳ Finalizing...'
        });
        
        const validationResult = await validateSteamToken(tokenObj.bearer);
        
        if (validationResult.expiresAt) {
            tokenObj.expiresAt = validationResult.expiresAt;
        }
        
        tokenObj.userId = interaction.user.id;
        tokenObj.username = interaction.user.tag;
        
        tokenStock.shift();
        tokenStock.push(tokenObj);
        
        await interaction.editReply({
            content: '⏳ Sending...'
        });
        
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
                `✅ Token generated!\n\n` +
                `📁 token.json attached\n\n` +
                `⏳ Status: **${expiryText}**`
            )
            .setColor(tokenExpired ? 0xED4245 : 0x2ECC71)
            .setFooter({ text: `TMC Gen` });
        
        try {
            await interaction.user.send({
                embeds: [embed],
                files: [attachment]
            });
            
            activeGenerations.delete(userId);
            return interaction.editReply({
                content: `✅ Token sent!\n⏳ ${expiryText}`
            });
        } catch (err) {
            console.error('[TMC] DM Error:', err);
            activeGenerations.delete(userId);
            
            const fallbackEmbed = new EmbedBuilder()
                .setDescription(
                    `⚠️ Could not send DM!\n\n` +
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
        return interaction.editReply({
            content: '❌ Error. Please try again.'
        });
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
].map(command => command.toJSON());

// --- READY EVENT ---
client.once('ready', async () => {
    try {
        console.log(`[TMC] 🚀 ONLINE: ${client.user.tag}`);
        console.log('[TMC] 🔑 Token Generator Active');
        console.log('[TMC] 🔄 Auto-Refresh Active');
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

            // --- STOCK COMMAND (Admin only) ---
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
                            content: '❌ Error: Both tokens required.'
                        });
                    }

                    const validation = await validateSteamToken(bearer);
                    
                    if (!validation.valid) {
                        return interaction.editReply({
                            content: `❌ Invalid token: ${validation.message}`
                        });
                    }
                    
                    tokenStock.push({
                        bearer,
                        refresh,
                        addedAt: Date.now(),
                        expiresAt: getTokenExpiryMs(bearer)
                    });

                    return interaction.editReply({
                        content: `📦 Token added! Total: \`${tokenStock.length}\``
                    });
                } catch (err) {
                    console.error('[TMC] Stock Modal Error:', err);
                    if (interaction.deferred) {
                        return interaction.editReply({
                            content: '❌ Error. Please try again.'
                        });
                    } else {
                        return interaction.reply({
                            content: '❌ Error. Please try again.',
                            flags: 64
                        });
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
        res.end(JSON.stringify({ status: 'ok', bot: 'online', timestamp: Date.now() }));
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
