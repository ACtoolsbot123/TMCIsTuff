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

// --- DNS FIX FOR RENDER ---
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
console.log('[TMC] ✅ DNS set');

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
  "bearer": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiIxN2ZmMmM5Yi1mYmE5LTQ3NjgtOGJiZC0yYjU4YzYxZTBjZTIiLCJ1aWQiOiJhMzQ5MTgxOS1lZGNkLTRiZDEtOTJkNS1hODJjZjk5NzBhNjYiLCJ1c24iOiIwelVHYjBrTVhyRGl0b1FYIiwidnJzIjp7ImF1dGhJRCI6ImJiOTNmYmUyNDBlODRmN2VhZTIyYzM4ZGQ4MGViODkzIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiA5Ljk5LjkuOTk5OV9mZmZmZmZmZiIsImRldmljZUlEIjoiMTgzNTc2MWMyYThiNmM2MjliOTlmZmY5ZWRmZjI4OWQ3ZjNlYTEyOCJ9LCJleHAiOjE3ODg1NDgyNTIsImlhdCI6MTc4ODU0NDY1Mn0.JM15u2Z9CBdTCFZGPJCbEN4lsfij--in7iWaDFSTEsM",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiIxN2ZmMmM5Yi1mYmE5LTQ3NjgtOGJiZC0yYjU4YzYxZTBjZTIiLCJ1aWQiOiJhMzQ5MTgxOS1lZGNkLTRiZDEtOTJkNS1hODJjZjk5NzBhNjYiLCJ1c24iOiIwelVHYjBrTVhyRGl0b1FYIiwidnJzIjp7ImF1dGhJRCI6ImJiOTNmYmUyNDBlODRmN2VhZTIyYzM4ZGQ4MGViODkzIiwiY2xpZW50VXNlckFnZW50IjoiU3RlYW1WUiA5Ljk5LjkuOTk5OV9mZmZmZmZmZiIsImRldmljZUlEIjoiMTgzNTc2MWMyYThiNmM2MjliOTlmZmY5ZWRmZjI4OWQ3ZjNlYTEyOCJ9LCJleHAiOjE3ODg1NjYyNTIsImlhdCI6MTc4ODU0NDY1Mn0.xyrQCXAjxzEZN5-rTNndDtwnupYchZZ7vwRDY1Z9KTE"
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

// --- REFRESH TOKEN - FIXED ---
async function refreshToken(refreshTk) {
    try {
        console.log('[TMC] 🔄 Attempting to refresh token...');
        
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
                    console.log(`[TMC] ❌ ${url} - Not JSON response`);
                    continue;
                }

                const data = await response.json();
                console.log(`[TMC] 📦 Response:`, JSON.stringify(data).substring(0, 300));

                let newBearer = null;
                let newRefresh = null;

                // Check multiple response formats
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

                // Check if we got a NEW token (different from the old one)
                if (response.status === 200 && newBearer) {
                    const newExpiry = getTokenExpiryMs(newBearer);
                    
                    // Make sure we actually got a new token
                    if (newBearer === refreshTk) {
                        console.log(`[TMC] ⚠️ ${url} - Refresh returned SAME token, skipping`);
                        continue;
                    }

                    if (newExpiry <= Date.now()) {
                        console.log(`[TMC] ⚠️ ${url} - Refreshed token already expired`);
                        continue;
                    }

                    console.log(`[TMC] ✅ Successfully refreshed token via ${url}!`);
                    console.log(`[TMC] New Bearer: ${newBearer.substring(0, 50)}...`);
                    console.log(`[TMC] New Refresh: ${newRefresh.substring(0, 50)}...`);
                    console.log(`[TMC] ⏳ ${humanExpiry(newExpiry)}`);

                    // Update DEFAULT_TOKEN
                    DEFAULT_TOKEN.bearer = newBearer;
                    DEFAULT_TOKEN.refresh_token = newRefresh;
                    ACTIVE_API_URL = url;
                    apiWorking = true;

                    // Update tokenStock
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
                    console.log('[TMC] 🔓 Refresh lock released');
                    return result;
                } else {
                    console.log(`[TMC] ❌ ${url} - Status: ${response.status}`, data);
                }
            } catch (err) {
                console.log(`[TMC] ❌ ${url} - ${err.message}`);
            }
        }

        console.log('[TMC] ❌ All refresh URLs failed');
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
            console.log('[TMC] ✅ Token refreshed');
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
    console.log('[TMC] 🔄 Auto-refresh every 1 minute');
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

// --- GENERATE TOKEN ---
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
                    content: `⏳ Please wait ${minutes}m ${seconds}s`
                });
            }
        }
    }
    
    if (activeGenerations.has(userId)) {
        const startTime = activeGenerations.get(userId);
        if (Date.now() - startTime < 60000) {
            return interaction.editReply({ content: '⏳ Please wait...' });
        } else {
            activeGenerations.delete(userId);
        }
    }
    
    activeGenerations.set(userId, Date.now());
    
    try {
        await interaction.editReply({ content: '⏳ Generating...' });
        
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
                `✅ Token generated!\n\n` +
                `📁 token.json attached\n\n` +
                `⏳ Status: **${expiryText}**`
            )
            .setColor(tokenExpired ? 0xED4245 : 0x2ECC71)
            .setFooter({ text: `TMC Gen` });
        
        try {
            await interaction.user.send({ embeds: [embed], files: [attachment] });
            activeGenerations.delete(userId);
            return interaction.editReply({ content: `✅ Token sent!\n⏳ ${expiryText}` });
        } catch (err) {
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
        console.error('[TMC] Error:', err);
        activeGenerations.delete(userId);
        return interaction.editReply({ content: '❌ Error. Try again.' });
    }
}

// --- REFRESH BUTTON HANDLER ---
async function processRefreshToken(interaction) {
    await interaction.deferReply({ flags: 64 });
    
    try {
        if (tokenStock.length === 0) {
            return interaction.editReply({ content: '❌ No tokens in stock to refresh.' });
        }
        
        await interaction.editReply({ content: '🔄 Attempting to refresh token...' });
        
        const tokenObj = tokenStock[0];
        if (!tokenObj.refresh) {
            return interaction.editReply({ content: '❌ No refresh token found in stock!' });
        }
        
        // Log the old token for comparison
        console.log('[TMC] Old Bearer:', tokenObj.bearer.substring(0, 50) + '...');
        
        const refreshResult = await refreshToken(tokenObj.refresh);
        
        if (refreshResult.success && refreshResult.newToken) {
            const expiryText = humanExpiry(tokenStock[0].expiresAt);
            
            // Verify the token actually changed
            const oldBearer = tokenObj.bearer;
            const newBearer = tokenStock[0].bearer;
            
            const embed = new EmbedBuilder()
                .setDescription(
                    `✅ Token refreshed successfully!\n\n` +
                    `📋 **New Bearer:** \`${newBearer.substring(0, 50)}...\`\n` +
                    `📋 **New Refresh:** \`${tokenStock[0].refresh.substring(0, 50)}...\`\n\n` +
                    `⏳ Status: **${expiryText}**\n` +
                    `🔄 Token changed: **${oldBearer !== newBearer ? '✅ YES' : '❌ NO'}**`
                )
                .setColor(0x2ECC71)
                .setFooter({ text: `TMC Gen` });
            
            return interaction.editReply({ embeds: [embed] });
        } else {
            return interaction.editReply({ 
                content: `❌ Failed to refresh token.\n\nError: ${refreshResult.error || 'Unknown error'}\n\n💡 Try using /stock to add a fresh token from the game.` 
            });
        }
    } catch (err) {
        console.error('[TMC] Refresh Error:', err);
        return interaction.editReply({ content: '❌ Error refreshing token. Try again.' });
    }
}

// --- SLASH COMMANDS ---
const commandsData = [
    new SlashCommandBuilder().setName('stock').setDescription('Add token stock').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('dashboard').setDescription('Token Generator panel'),
    new SlashCommandBuilder().setName('refreshall').setDescription('Refresh all tokens in stock pool').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

// --- READY ---
client.once('ready', async () => {
    console.log(`[TMC] 🚀 ONLINE: ${client.user.tag}`);
    console.log(`[TMC] 👑 Connected to ${client.guilds.cache.size} server(s)`);

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
        console.log('[TMC] ✅ Commands registered');
    } catch (error) {
        console.error('[TMC] Failed to register commands:', error);
    }
    startAutoRefresh();
    console.log('[TMC] ✅ Bot ready!');
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
                    .setDescription(`**TMC Gen**\n\nClick below to generate your token.`)
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
                        .setLabel('🔄 Refresh Token')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🔄')
                );

                return interaction.reply({ embeds: [embed], components: [row1, row2] });
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
                    return interaction.editReply({ content: '❌ No tokens in stock to refresh.' });
                }
                
                await interaction.editReply({ content: `🔄 Refreshing all ${tokenStock.length} tokens...` });
                const { successCount, failCount } = await refreshAllTokens();
                
                return interaction.editReply({ 
                    content: `✅ Refresh complete!\n- Successful: **${successCount}**\n- Failed: **${failCount}**\n- Total Stock: **${tokenStock.length}**` 
                });
            }
        }

        // --- BUTTON HANDLERS ---
        if (interaction.isButton()) {
            if (interaction.customId === 'gen_public') {
                return await processTokenGeneration(interaction);
            }
            
            if (interaction.customId === 'refresh_token_btn') {
                return await processRefreshToken(interaction);
            }
        }

        if (interaction.isModalSubmit() && interaction.customId === 'stock_modal') {
            await interaction.deferReply({ flags: 64 });
            const bearer = interaction.fields.getTextInputValue('stock_bearer_input').trim();
            const refresh = interaction.fields.getTextInputValue('stock_refresh_input').trim();
            
            if (!bearer || !refresh) {
                return interaction.editReply({ content: '❌ Error: Both tokens required.' });
            }

            const validation = await validateSteamToken(bearer);
            if (!validation.valid) {
                return interaction.editReply({ content: `❌ Invalid token: ${validation.message}` });
            }
            
            tokenStock.push({
                bearer, refresh,
                addedAt: Date.now(),
                expiresAt: getTokenExpiryMs(bearer)
            });

            return interaction.editReply({ content: `📦 Token added! Total: \`${tokenStock.length}\`` });
        }
    } catch (err) {
        console.error(`[TMC] Error:`, err);
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: "❌ Error. Try again.", flags: 64 }).catch(() => {});
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
console.log('[TMC] 🔑 Logging in...');

if (!process.env.DISCORD_TOKEN) {
    console.error('[TMC] ❌ DISCORD_TOKEN not set!');
} else {
    console.log(`[TMC] ✅ Token set (length: ${process.env.DISCORD_TOKEN.length})`);
    client.login(process.env.DISCORD_TOKEN).catch(err => {
        console.error('[TMC] ❌ Login failed:', err.message);
        setTimeout(() => {
            console.log('[TMC] 🔄 Retrying login...');
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
    console.log('[TMC] ⏳ Bot is alive...');
}, 45000);

client.on('disconnect', () => {
    console.log('[TMC] ❌ Disconnected! Reconnecting in 3 seconds...');
    setTimeout(() => {
        client.login(process.env.DISCORD_TOKEN).catch(() => {});
    }, 3000);
});

client.on('resume', () => console.log('[TMC] ✅ Connection resumed'));
client.on('reconnecting', () => console.log('[TMC] 🔄 Reconnecting...'));
client.on('rateLimit', (info) => console.log(`[TMC] ⚠️ Rate limit hit: ${info.timeout}ms`));

// External URL self-ping loop
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    setInterval(() => {
        fetch(`${RENDER_EXTERNAL_URL}/health`).catch(() => {});
    }, 14 * 60 * 1000);
    console.log(`[TMC] 🌐 Keep-alive active targeting: ${RENDER_EXTERNAL_URL}`);
}
