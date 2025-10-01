const fs = require('fs-extra');
const path = require('path');
const dotenv = require('dotenv');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');

dotenv.config();
const categories  = path.join(__dirname, 'Categories');
const logs_dir = path.join(__dirname, 'logs');
const threads_log_dir = path.join(logs_dir, 'threads');
const complete_logs = path.join(logs_dir, 'sent');
const history_lim = 50;
const startup_time = Date.now();



const TEMP_IGNORED_MSGS = new Set();
function tempIgnoreMessage(id, ttl = 7000) {
    if (!id) return;
    const key = String(id);
    TEMP_IGNORED_MSGS.add(key);
    setTimeout(() => { TEMP_IGNORED_MSGS.delete(key); }, ttl);
}

if (!BOT_TOKEN) {
    console.error('Missing BOT token in .env (bot_token)');
    process.exit(1);
}

const SERVERS_FILE = path.join(__dirname, 'servers.json');
let SERVERS = {};

function loadServers() {
    try {
        if (!fs.existsSync(SERVERS_FILE)) {
            SERVERS = {};
            return SERVERS;
        }
        const raw = fs.readFileSync(SERVERS_FILE, 'utf8');
        SERVERS = raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.warn('[log-bot] failed to load servers.json', e);
        SERVERS = {};
    }
    return SERVERS;
}
function saveServers() {
    try {
        fs.ensureDirSync(path.dirname(SERVERS_FILE));
        fs.writeFileSync(SERVERS_FILE, JSON.stringify(SERVERS, null, 2), 'utf8');
    } catch (e) {
        console.warn('[log-bot] failed to save servers.json', e);
    }
}
function getLogsChannelIdForGuild(guildId) {
    loadServers();
    if (!guildId) return null;
    return SERVERS[guildId] || null;
}

function isLogsChannelId(channelId, guildId) {
    if (!channelId) return false;
    loadServers();
    if (guildId) {
        const mapped = SERVERS[guildId];
        if (mapped && String(channelId) === String(mapped)) return true;
    }
    for (const gid of Object.keys(SERVERS || {})) {
        if (String(SERVERS[gid]) === String(channelId)) return true;
    }
    return false;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessageTyping
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

fs.ensureDirSync(categories );
fs.ensureDirSync(threads_log_dir);
fs.ensureDirSync(complete_logs);

function sanitizeName(name) {
    return String(name || '').replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
}

function channelBaseFolder(channel) {
    if (channel?.isThread?.() || channel?.isThread) {
        const parent = channel.parent;
        const categoryName = parent?.parent?.name || parent?.parentId || 'NoCategory';
        const channelName = parent?.name || parent?.id;
        const catFolder = `${parent?.parentId || 'nocat'} - ${sanitizeName(categoryName)}`;
        const chFolder = `${parent?.id || parent?.name} - ${sanitizeName(channelName)}`;
        return path.join(categories , catFolder, 'Channels', chFolder);
    } else {
        const categoryName = channel?.parent?.name || channel?.parentId || 'NoCategory';
        const channelName = channel?.name || channel?.id;
        const catFolder = `${channel?.parentId || 'nocat'} - ${sanitizeName(categoryName)}`;
        const chFolder = `${channel?.id || channel?.name} - ${sanitizeName(channelName)}`;
        return path.join(categories , catFolder, 'Channels', chFolder);
    }
}

function channelFolderName(channel) {
    const name = channel.name || channel.id;
    return `${channel.id} - ${name.replace(/[<>:"/\\|?*]/g, '_')}`;
}

async function historyFilePath(channel) {
    const base = channelBaseFolder(channel);
    await fs.ensureDir(base);
    if (channel?.isThread?.() || channel?.isThread) {
        const threadFolder = path.join(base, 'Threads', 'current');
        await fs.ensureDir(threadFolder);
        return path.join(threadFolder, `${channel.id}.json`);
    }
    return path.join(base, 'messages.json');
}

async function loadHistory(channel) {
    const fp = await historyFilePath(channel);
    try {
        const data = await fs.readFile(fp, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

async function saveHistory(channel, arr) {
    const fp = await historyFilePath(channel);
    await fs.ensureDir(path.dirname(fp));
    await fs.writeFile(fp, JSON.stringify(arr, null, 2), 'utf8');
}

function serializeMessage(msg) {
    return {
        id: msg.id,
        authorId: msg.author?.id,
        authorTag: msg.author?.tag,
        authorName: msg.member?.displayName || msg.author?.username || msg.author?.tag,
        webhookId: msg.webhookId || null,
        bot: msg.author?.bot || false,
        content: msg.content || '',
        createdAt: msg.createdAt?.toISOString?.() || new Date().toISOString(),
        attachments: msg.attachments?.map(a => ({ id: a.id, url: a.url, name: a.name })) || [],
        embeds: msg.embeds?.map(e => e.toJSON?.() || e) || []
    };
}

function normalizeSerialized(s) {
    const out = {
        content: (s.content || '').toString(),
        attachments: [],
        embeds: []
    };
    try {
        out.content = out.content.replace(/https?:\/\/[^\s]+/gi, (m) => {
            try {
                const u = new URL(m);
                const parts = (u.pathname || '').split('/').filter(Boolean);
                let last = parts.length ? parts[parts.length - 1] : '';
                last = (last || u.hostname || '').split('?')[0];
                return last || u.hostname || m;
            } catch (e) {
                return m;
            }
        });
    } catch (e) {
    }
    if (Array.isArray(s.attachments)) {
        out.attachments = s.attachments.map(a => ({ id: a.id || null, name: a.name || null }));
    }
    if (Array.isArray(s.embeds)) {
        out.embeds = s.embeds.map(e => {
            try {
                const copy = {};
                if (e.title) copy.title = e.title;
                if (e.description) copy.description = e.description;
                if (e.author && e.author.name) copy.author = { name: e.author.name };
                if (e.fields) copy.fields = (e.fields || []).map(f => ({ name: f.name, value: f.value }));
                return copy;
            } catch (err) {
                return {};
            }
        });
    }
    return out;
}

function serializedSummary(s) {
    const norm = normalizeSerialized(s || {});
    const parts = [];
    try {
        const c = (norm.content || '').toString().replace(/\s+/g, ' ').trim();
        if (c) parts.push(c);
    } catch (e) {}
    try {
        if (Array.isArray(norm.attachments) && norm.attachments.length) {
            const at = norm.attachments.map(a => (a.name || a.id || '')).filter(Boolean).join(',');
            if (at) parts.push(`att:${at}`);
        }
    } catch (e) {}
    try {
        if (Array.isArray(norm.embeds) && norm.embeds.length) {
            const embParts = norm.embeds.map(e => {
                const f = [];
                if (e.title) f.push(e.title);
                if (e.description) f.push(e.description);
                if (e.author && e.author.name) f.push(e.author.name);
                if (e.fields && Array.isArray(e.fields)) f.push(e.fields.map(ff => `${ff.name}:${ff.value}`).join(';'));
                return f.join('|');
            }).filter(Boolean).join('||');
            if (embParts) parts.push(`emb:${embParts}`);
        }
    } catch (e) {}
    return parts.join('||').toLowerCase();
}

async function addMessageToHistory(channel, msg) {
    const hist = await loadHistory(channel);
    hist.unshift(serializeMessage(msg));
    let removed = null;
    if (hist.length > history_lim) {
        removed = hist.pop();
    }
    await saveHistory(channel, hist);
    return removed;
}

function getFlagNumber(msg) {
    if (!msg) return 0;
    const f = msg.flags;
    if (!f) return 0;
    if (typeof f === 'number') return f;
    if (typeof f.bitfield === 'number') return f.bitfield;
    return 0;
}

function isInteractionPlaceholder(msg) {
    if (!msg) return false;
    try {
        const fromWebhook = Boolean(msg.webhookId);
        const isBot = Boolean(msg.author && msg.author.bot);
        const hasInteraction = Boolean(msg.interaction || msg.interaction_metadata);
        const flags = getFlagNumber(msg);
        const isEphemeralFlag = Boolean(flags & 128);
        const isType20 = (typeof msg.type === 'number' && msg.type === 20);
        return fromWebhook && isBot && (hasInteraction || isEphemeralFlag || isType20);
    } catch (e) {
        return false;
    }
}

async function removeMessageFromHistory(channel, messageId) {
    const hist = await loadHistory(channel);
    const idx = hist.findIndex(m => m.id === messageId);
    if (idx !== -1) {
        const [removed] = hist.splice(idx, 1);
        await saveHistory(channel, hist);
        return removed;
    }
    return null;
}

async function fetchAndSeed() {
  for (const [, guild] of client.guilds.cache) {
    if (ALLOWED_GUILD_IDS && !ALLOWED_GUILD_IDS.has(guild.id)) continue;
    await guild.channels.fetch();
    for (const [, channel] of guild.channels.cache) {
            try {
                if (channel.isTextBased && channel.viewable) {
                    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
                    if (messages) {
                        const arr = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
                        const ser = arr.map(serializeMessage).slice(0, history_lim);
                        const fp = await historyFilePath(channel);
                        await fs.ensureDir(path.dirname(fp));
                        await fs.writeFile(fp, JSON.stringify(ser, null, 2), 'utf8');
                    }
                    if (channel.threads) {
                        for (const [, thread] of channel.threads.cache) {
                            try {
                                let tmsgsAll = [];
                                try {
                                    let lastId = null;
                                    while (true) {
                                        const opts = lastId ? { limit: 100, before: lastId } : { limit: 100 };
                                        const batch = await thread.messages.fetch(opts).catch(() => null);
                                        if (!batch || batch.size === 0) break;
                                        const vals = Array.from(batch.values());
                                        tmsgsAll = tmsgsAll.concat(vals);
                                        if (batch.size < 100) break;
                                        lastId = vals[vals.length - 1].id;
                                    }
                                } catch (e) {
                                    tmsgsAll = (await thread.messages.fetch({ limit: 100 }).catch(() => null)) ? Array.from((await thread.messages.fetch({ limit: 100 }).catch(() => null)).values()) : [];
                                }
                                if (tmsgsAll && tmsgsAll.length) {
                                    const tarr = tmsgsAll.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
                                    const ser = tarr.map(serializeMessage);
                                    const fp = await historyFilePath(thread);
                                    await fs.ensureDir(path.dirname(fp));
                                    await fs.writeFile(fp, JSON.stringify(ser, null, 2), 'utf8').catch(() => {});
                                    try {
                                        const starter = await thread.fetchStarterMessage().catch(() => null);
                                        if (starter && starter.id) {
                                            const mapFile = path.join(threads_log_dir, `${starter.id}.json`);
                                            await fs.writeFile(mapFile, JSON.stringify({ threadId: thread.id, path: fp }, null, 2), 'utf8').catch(() => {});
                                        }
                                    } catch (e) {}
                                }
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {}
        }
    }
}

async function mapThreadStarter(starterMessageId, threadId, threadPath) {
  if (!starterMessageId) return;
  const mapFile = path.join(threads_log_dir, `${starterMessageId}.json`);
  await fs.ensureDir(path.dirname(mapFile));
  await fs.writeFile(mapFile, JSON.stringify({ threadId, path: threadPath }, null, 2), 'utf8').catch(() => {});
}

const BOT_TOKEN = process.env.bot_token;
const SERVER_IDS = (process.env.server_ids || process.env.SERVER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_GUILD_IDS = SERVER_IDS.length ? new Set(SERVER_IDS) : null;

async function findThreadFileByStarter(starterId) {
    if (!starterId) return null;
    async function walk(folder) {
        const items = await fs.readdir(folder).catch(() => []);
        for (const it of items) {
            const p = path.join(folder, it);
            const stat = await fs.stat(p).catch(() => null);
            if (!stat) continue;
            if (stat.isDirectory()) {
                const res = await walk(p);
                if (res) return res;
                continue;
            }
            if (!it.endsWith('.json')) continue;
            const np = p.replace(/\\/g, '/');
            if (!np.includes('/Threads/current') && !np.includes('/Threads/deleted')) continue;
            if (process.env.DEBUG_THREAD_SCAN) console.log('[log-bot] scanning thread file', p);
            const data = await fs.readFile(p, 'utf8').catch(() => null);
            if (!data) continue;
            let arr = null;
            try { arr = JSON.parse(data); } catch (e) { arr = null; }
            if (!Array.isArray(arr)) continue;
            if (arr.find(m => String(m.id) === String(starterId))) {
                const threadId = path.basename(p).replace(/\.json$/i, '');
                if (process.env.DEBUG_THREAD_SCAN) console.log('[log-bot] found starter in', p);
                return { threadId, path: p };
            }
        }
        return null;
    }
    try {
        return await walk(categories );
    } catch (e) {
        return null;
    }
}

async function findSerializedMessageById(messageId) {
    if (!messageId) return null;
    async function walk(folder) {
        const items = await fs.readdir(folder).catch(() => []);
        for (const it of items) {
            const p = path.join(folder, it);
            const stat = await fs.stat(p).catch(() => null);
            if (!stat) continue;
            if (stat.isDirectory()) {
                const res = await walk(p);
                if (res) return res;
                continue;
            }
            if (!it.endsWith('.json')) continue;
            const data = await fs.readFile(p, 'utf8').catch(() => null);
            if (!data) continue;
            let arr = null;
            try { arr = JSON.parse(data); } catch (e) { arr = null; }
            if (!Array.isArray(arr)) continue;
            const found = arr.find(m => String(m.id) === String(messageId));
            if (found) return { message: found, path: p };
        }
        return null;
    }
    try {
        return await walk(categories );
    } catch (e) {
        return null;
    }
}

function createDeletionEmbeds(removed, channel) {
    const embeds = [];
    const createdTs = Math.floor(new Date(removed.createdAt).getTime() / 1000);
    const meta = new EmbedBuilder()
        .setTitle('Message deleted')
        .addFields(
            { name: 'Sent by', value: `${removed.authorTag || removed.authorName || 'Unknown'} (${removed.authorId || 'N/A'})`, inline: true },
            { name: 'Channel', value: `<#${channel.id}>`, inline: true },
            { name: 'Time', value: `<t:${createdTs}:F>`, inline: true }
        )
        .setTimestamp();
    embeds.push(meta);
    if (removed.content && removed.content.length > 0) {
        const contentEmbed = new EmbedBuilder().setDescription(removed.content.substring(0, 4096));
        embeds.push(contentEmbed);
    }
    if (removed.embeds && removed.embeds.length > 0) {
        for (const e of removed.embeds) {
            try {
                const be = EmbedBuilder.from(e);
                embeds.push(be);
            } catch (err) {
                embeds.push(new EmbedBuilder().setDescription('Embed (could not fully parse)'));
            }
        }
    }
    return embeds;
}

async function sendDeletionLog(removed, channel) {
    let guildId = channel?.guildId || channel?.guild?.id || null;
    if (!guildId && removed && removed.channelId) {
        try {
            const ch = await client.channels.fetch(removed.channelId).catch(() => null);
            guildId = ch?.guildId || ch?.guild?.id || null;
        } catch (e) {}
    }
    const logsChannelId = getLogsChannelIdForGuild(guildId);
    if (!logsChannelId) {
        console.warn('[log-bot] no logs channel configured for guild', guildId);
        return;
    }
    const logs = await client.channels.fetch(logsChannelId).catch((err) => { console.error('[log-bot] failed to fetch logs channel', err); return null; });
    if (!logs || !logs.send) {
        console.warn('[log-bot] logs channel not available or send not permitted for', logsChannelId);
        return;
    }

    const mapFile = path.join(threads_log_dir, `${removed.id}.json`);
    const mapData = await fs.readFile(mapFile, 'utf8').catch(() => null);
    let threadMap = null;
    if (mapData) {
        try { threadMap = JSON.parse(mapData); } catch (e) { threadMap = null; }
    }

    const embeds = createDeletionEmbeds(removed, channel);

    const files = [];
    for (const a of removed.attachments || []) {
        try {
            const att = new AttachmentBuilder(a.url, { name: a.name || `${a.id}` });
            files.push(att);
        } catch (e) {}
    }

    try {
        const components = [];
        if (threadMap && threadMap.threadId) {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`view_thread_${removed.id}_p0`)
                    .setLabel('Thread')
                    .setEmoji('🧵')
                    .setStyle(ButtonStyle.Primary)
            );
            components.push(row);
        }
        const sentMessageIds = [];
        for (let i = 0; i < embeds.length; i += 10) {
            const slice = embeds.slice(i, i + 10);
            try {
                const sent = await logs.send({ embeds: slice, files: i === 0 ? files : [], components: i === 0 ? components : [] }).catch((err) => { console.error('[log-bot] logs.send failed', err); return null; });
                if (sent && sent.id) sentMessageIds.push(sent.id);
            } catch (err) {
                console.error('[log-bot] logs.send caught error', err);
            }
        }
        try {
            const outFile = path.join(complete_logs, `${removed.id}.json`);
            await fs.writeFile(outFile, JSON.stringify({ sent: sentMessageIds }, null, 2), 'utf8').catch(() => {});
        } catch (e) {}
    } catch (e) {
        let text = `Message deleted by ${removed.authorTag} (${removed.authorId}) in <#${channel.id}>\nSent: ${removed.createdAt}\n`;
        if (removed.content) text += `\nContent:\n${removed.content}\n`;
        if (text.length > 2000) {
            await logs.send(text.substring(0, 2000));
            await logs.send(text.substring(2000));
        } else {
            await logs.send(text);
        }
    }

    if (threadMap && threadMap.threadId) {
        try {
            const toDelete = await client.channels.fetch(threadMap.threadId).catch(() => null);
            if (toDelete && toDelete.isThread?.()) {
                await toDelete.delete().catch(() => {});
                const threadFile = threadMap.path;
                if (threadFile) {
                    const deletedFolder = path.join(path.dirname(threadFile), '..', 'deleted');
                    await fs.ensureDir(deletedFolder).catch(() => {});
                    const dest = path.join(deletedFolder, path.basename(threadFile));
                    await fs.move(threadFile, dest, { overwrite: true }).catch(() => {});
                    try {
                        const mapFilePath = path.join(threads_log_dir, `${removed.id}.json`);
                        await fs.writeFile(mapFilePath, JSON.stringify({ threadId: threadMap.threadId, path: dest }, null, 2), 'utf8').catch(() => {});
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }
}

let _initialized = false;

async function initializeOnce() {
    if (_initialized) return;
    _initialized = true;
    console.log(`Logged in as ${client.user?.tag || client.user}`);
    try {
        await fetchAndSeed();
        console.log('Seeded channel/thread histories');
        await computeStats().catch(() => {});
    } catch (e) {
        console.error('[log-bot] initialization error', e);
    }
}

async function deployCommands() {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    const commands = [
        {
            name: 'log_del',
            description: 'Delete logs without spamming',
            options: [{ name: 'log_message_id', type: 3, description: 'Message id', required: true }]
        },
        {
            name: 'logging_channel',
            description: 'Set or remove the logging channel for this server. Omit the channel to toggle current channel.',
            options: [{ name: 'channel', type: 7, description: 'Channel to use for logs (optional)', required: false }]
        }
    ];

    try {
        console.log(`Started refreshing ${commands.length} application (/) command(s).`);
        const data = await rest.put(Routes.applicationCommands(client.application.id), { body: commands });
        console.log(`Successfully reloaded ${Array.isArray(data) ? data.length : (Array.isArray(data) ? data.length : 0)} application (/) commands.`);
        if (Array.isArray(data)) data.forEach(cmd => console.log(`- ${cmd.name}`));
    } catch (error) {
        console.error('[log-bot] failed to deploy application commands', error);
    }
}

async function clearGuildCommands() {
    const guildIds = ALLOWED_GUILD_IDS && ALLOWED_GUILD_IDS.size ? Array.from(ALLOWED_GUILD_IDS) : Array.from(client.guilds.cache.keys());
    for (const gid of guildIds) {
        try {
            const g = await client.guilds.fetch(gid).catch(() => null);
            if (!g) continue;
            const before = await g.commands.fetch().catch(() => new Map());
            if (before && before.size) console.log(`[log-bot] clearing ${before.size} guild command(s) in ${g.id}`);
            await g.commands.set([]).catch((e) => { console.warn('[log-bot] failed to clear guild commands for', g.id, e); });
            console.log(`[log-bot] cleared guild commands in ${g.id}`);
        } catch (e) {
            console.warn('[log-bot] error while clearing guild commands for', gid, e);
        }
    }
}

async function onReady() {
    try {
        try { await client.application?.fetch(); } catch (e) { console.warn('[log-bot] failed to fetch application during startup', e); }
        await initializeOnce();
        await deployCommands();
    } catch (e) {
        console.error('[log-bot] onReady error', e);
    }
}

client.once('clientReady', () => { (async () => { await onReady(); })().catch(e => console.error('[log-bot] clientReady handler error', e)); });
client.once('ready', () => {
    console.warn('[log-bot] legacy "ready" event received — invoking startup for compatibility.');
    (async () => { await onReady(); })().catch(e => console.error('[log-bot] legacy ready handler error', e));
});

async function computeStats() {
    const dirItems = await fs.readdir(categories ).catch(() => []);
    let channelCount = 0;
    let totalMessages = 0;
    async function walkFolder(folder) {
        const items = await fs.readdir(folder).catch(() => []);
        for (const it of items) {
            const p = path.join(folder, it);
            const stat = await fs.stat(p).catch(() => null);
            if (!stat) continue;
            if (stat.isDirectory()) {
                await walkFolder(p);
                continue;
            }
            if (!it.endsWith('.json')) continue;
            channelCount += 1;
            const data = await fs.readFile(p, 'utf8').catch(() => null);
            if (!data) continue;
            try {
                const arr = JSON.parse(data);
                totalMessages += Array.isArray(arr) ? arr.length : 0;
            } catch (e) {}
        }
    }
    for (const item of dirItems) {
        const folder = path.join(categories , item);
        const stat = await fs.stat(folder).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;
        await walkFolder(folder);
    }

    const uptimeMs = Date.now() - startup_time;
    const uptime = msToShort(uptimeMs);

    const stats = {
        channels: channelCount,
        messages: totalMessages,
        uptime,
        timestamp: new Date().toISOString()
    };

    try {
        if (client.user) {
            const activity = `Tracking ${channelCount} channels, ${totalMessages} messages | Uptime ${uptime}`;
            await client.user.setPresence({ activities: [{ name: activity, type: ActivityType.Watching }] });
        }
    } catch (e) {}

    await fs.writeFile(path.join(__dirname, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8').catch(() => {});
}

function msToShort(duration) {
    let seconds = Math.floor(duration / 1000);
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds = seconds % 60;
    if (days > 0) return `${days}d${hours}h`;
    if (hours > 0) return `${hours}h${minutes}m`;
    if (minutes > 0) return `${minutes}m${seconds}s`;
    return `${seconds}s`;
}

setInterval(() => {
    if (!_initialized) return;
    computeStats().catch(() => {});
}, 5 * 1000);

computeStats().catch(() => {});

client.on('messageCreate', async (message) => {
    try {
        if (isInteractionPlaceholder(message)) return;
        if (!message || !message.id) return;
        if (TEMP_IGNORED_MSGS.has(String(message.id))) {
            TEMP_IGNORED_MSGS.delete(String(message.id));
            return;
        }
        if (!message.guild) return;
        if (ALLOWED_GUILD_IDS && !ALLOWED_GUILD_IDS.has(message.guild.id)) return;
        if (message.partial) await message.fetch().catch(() => {});
        const channel = message.channel;
        const removed = await addMessageToHistory(channel, message);
        if (message.hasThread) {
            const thread = await message.thread.fetch().catch(() => null);
            if (thread) {
                let tmsgsAll = [];
                try {
                    let lastId = null;
                    while (true) {
                        const opts = lastId ? { limit: 100, before: lastId } : { limit: 100 };
                        const batch = await thread.messages.fetch(opts).catch(() => null);
                        if (!batch || batch.size === 0) break;
                        const vals = Array.from(batch.values());
                        tmsgsAll = tmsgsAll.concat(vals);
                        if (batch.size < 100) break;
                        lastId = vals[vals.length - 1].id;
                    }
                } catch (e) {}
                const ser = tmsgsAll.sort((a, b) => b.createdTimestamp - a.createdTimestamp).map(serializeMessage);
                const fp = await historyFilePath(thread);
                await fs.ensureDir(path.dirname(fp));
                await fs.writeFile(fp, JSON.stringify(ser, null, 2), 'utf8').catch(() => {});
                await mapThreadStarter(message.id, thread.id, fp).catch(() => {});
            }
        }
    } catch (e) {
        console.error('messageCreate handler error', e);
    }
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
    try {
        if (isInteractionPlaceholder(oldMsg) || isInteractionPlaceholder(newMsg)) return;
        if (oldMsg && oldMsg.partial) oldMsg = await oldMsg.fetch().catch(() => null) || oldMsg;
        if (newMsg && newMsg.partial) newMsg = await newMsg.fetch().catch(() => null) || newMsg;
        if (!newMsg || !newMsg.guild || !newMsg.id) return;
        if (TEMP_IGNORED_MSGS.has(String(newMsg.id))) {
            TEMP_IGNORED_MSGS.delete(String(newMsg.id));
            return;
        }
        if (ALLOWED_GUILD_IDS && !ALLOWED_GUILD_IDS.has(newMsg.guild.id)) return;
        const channel = newMsg.channel || { id: newMsg.channelId };
        const oldSerialized = serializeMessage(oldMsg || newMsg);
        const newSerialized = serializeMessage(newMsg);
        try {
            const contentSame = String(oldSerialized.content || '') === String(newSerialized.content || '');
            const attachmentsSame = JSON.stringify(oldSerialized.attachments || []) === JSON.stringify(newSerialized.attachments || []);
            const oldEmbedsEmpty = !Array.isArray(oldSerialized.embeds) || oldSerialized.embeds.length === 0;
            const newEmbedsNonEmpty = Array.isArray(newSerialized.embeds) && newSerialized.embeds.length > 0;
            if (contentSame && attachmentsSame && oldEmbedsEmpty && newEmbedsNonEmpty) {
                return;
            }
        } catch (e) {}
        const oldSummary = serializedSummary(oldSerialized || {});
        const newSummary = serializedSummary(newSerialized || {});
        if (oldSummary === newSummary) return;
        try {
            const hist = await loadHistory(channel);
            const idx = hist.findIndex(m => m.id === newMsg.id);
            if (idx !== -1) {
                hist[idx] = newSerialized;
                await saveHistory(channel, hist);
            } else {
                hist.unshift(newSerialized);
                if (hist.length > history_lim) hist.pop();
                await saveHistory(channel, hist);
            }
        } catch (e) {}
        const logsChannelId = getLogsChannelIdForGuild(newMsg.guild.id);
        if (!logsChannelId) return;
        const logs = await client.channels.fetch(logsChannelId).catch(() => null);
        if (!logs || !logs.send) return;
        const createdTs = Math.floor(new Date(newSerialized.createdAt).getTime() / 1000);
        const meta = new EmbedBuilder()
            .setTitle('Message Edited')
            .addFields(
                { name: 'Sent by', value: `${newSerialized.authorTag || newSerialized.authorName || 'Unknown'} (${newSerialized.authorId || 'N/A'})`, inline: true },
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Sent', value: `<t:${createdTs}:F>`, inline: true }
            )
            .setTimestamp();
        const before = new EmbedBuilder().setTitle('Before').setDescription(oldSerialized.content || '(no text)');
        const after = new EmbedBuilder().setTitle('After').setDescription(newSerialized.content || '(no text)');
        await logs.send({ embeds: [meta, before, after] }).catch(() => {});
    } catch (e) {
        console.error('messageUpdate error', e);
    }
});

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function buildEmbedsForMessages(arr) {
    const embeds = [];
    for (const m of arr) {
        const title = m.authorName || m.authorTag || 'Unknown';
        let content = (m.content || '').toString();
        if (!content || content.trim().length === 0) {
            if ((m.embeds && m.embeds.length) || (m.attachments && m.attachments.length)) {
                content = (m.embeds && m.embeds.length) ? '_embed(s) attached_' : '_attachment(s) attached_';
            } else {
                continue;
            }
        }
        if (content.length > 4000) content = content.substring(0, 4000 - 3) + '...';
        const e = new EmbedBuilder()
            .setTitle(title)
            .setDescription(content)
            .setTimestamp(new Date(m.createdAt));
        embeds.push(e);
        if (m.embeds && m.embeds.length) {
            for (const raw of m.embeds) {
                try {
                    embeds.push(EmbedBuilder.from(raw));
                } catch (err) {
                    embeds.push(new EmbedBuilder().setDescription('_Embed (could not parse)_'));
                }
            }
        }
    }
    return embeds;
}

function buildPagesFromMessages(msgs, perPage = 38) {
    const pages = [];
    for (let i = 0; i < msgs.length; i += perPage) {
        const pageMsgs = msgs.slice(i, i + perPage);
        const embeds = [];
        let currentDesc = '';
        for (const m of pageMsgs) {
            const author = m.authorName || m.authorTag || 'Unknown';
            const ts = Math.floor(new Date(m.createdAt).getTime() / 1000);
            let content = (m.content || '').toString();
            if (!content || content.trim().length === 0) {
                if ((m.embeds && m.embeds.length) || (m.attachments && m.attachments.length)) {
                    content = (m.embeds && m.embeds.length) ? '_embed(s) attached_' : '_attachment(s) attached_';
                } else {
                    continue;
                }
            }
            const line = `**${author}** • <t:${ts}:F>\n${content}\n\n`;
            if (currentDesc.length + line.length > 4000) {
                embeds.push(new EmbedBuilder().setDescription(currentDesc));
                currentDesc = line;
                if (embeds.length >= 10) {
                    embeds[embeds.length - 1].setDescription((embeds[embeds.length - 1].data.description || '') + '\n... (truncated)');
                    currentDesc = '';
                    break;
                }
            } else {
                currentDesc += line;
            }
        }
        if (currentDesc && embeds.length < 10) embeds.push(new EmbedBuilder().setDescription(currentDesc));
        if (embeds.length === 0) embeds.push(new EmbedBuilder().setDescription('(no visible messages)'));
        pages.push(embeds);
    }
    return pages;
}

client.on('messageDelete', async (message) => {
    try {
        if (!message) return;
        if (isInteractionPlaceholder(message)) return;
        if (message.partial) message = await message.fetch().catch(() => null) || message;
        if (!message.id) return;
        if (TEMP_IGNORED_MSGS.has(String(message.id))) {
            TEMP_IGNORED_MSGS.delete(String(message.id));
            return;
        }
        let channel = message.channel || null;
        if (!channel && message.channelId) channel = await client.channels.fetch(message.channelId).catch(() => null);
        const guildId = message.guild?.id || channel?.guildId || channel?.guild?.id;
        if (ALLOWED_GUILD_IDS && guildId && !ALLOWED_GUILD_IDS.has(guildId)) return;
        let removed = null;
        try { removed = await removeMessageFromHistory(channel, message.id); } catch (e) { removed = null; }
        if (!removed) {
            const mapFile = path.join(threads_log_dir, `${message.id}.json`);
            const mapData = await fs.readFile(mapFile, 'utf8').catch(() => null);
            let obj = null;
            if (mapData) {
                try { obj = JSON.parse(mapData); } catch (e) { obj = null; }
            }
            if (obj && obj.path) {
                try {
                    const threadFile = obj.path;
                    const exists = await fs.pathExists(threadFile).catch(() => false);
                    if (exists) {
                        const deletedFolder = path.join(path.dirname(threadFile), '..', 'deleted');
                        await fs.ensureDir(deletedFolder).catch(() => {});
                        const dest = path.join(deletedFolder, path.basename(threadFile));
                        await fs.move(threadFile, dest, { overwrite: true }).catch(() => {});
                        await fs.writeFile(mapFile, JSON.stringify({ threadId: obj.threadId, path: dest }, null, 2), 'utf8').catch(() => {});
                    } else {
                        const possible = await findThreadFileByStarter(thread.id).catch(() => null);
                        if (possible && possible.path) {
                            const deletedFolder = path.join(path.dirname(possible.path), '..', 'deleted');
                            await fs.ensureDir(deletedFolder).catch(() => {});
                            const dest = path.join(deletedFolder, path.basename(possible.path));
                            await fs.move(possible.path, dest, { overwrite: true }).catch(() => {});
                            try {
                                await fs.writeFile(mapFile, JSON.stringify({ threadId: obj.threadId, path: dest }, null, 2), 'utf8').catch(() => {});
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
                if (obj && obj.threadId) {
                    try { const th = await client.channels.fetch(obj.threadId).catch(() => null); if (th && th.isThread?.()) await th.delete().catch(() => {}); } catch (e) {}
                }
            }
            removed = serializeMessage(message);
        }
        if (removed && !removed.channelId) removed.channelId = message.channelId || channel?.id;
        const channelForLog = channel || { id: message.channelId };
        await sendDeletionLog(removed, channelForLog);
    } catch (e) {
        console.error('messageDelete handler error', e);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.isButton()) return;
        const id = interaction.customId;
        if (id.startsWith('view_thread_')) {
            const parts = id.replace('view_thread_', '').split('_p');
            const starterId = parts[0];
            const page = parseInt(parts[1] || '0', 10) || 0;
            const mapFile = path.join(threads_log_dir, `${starterId}.json`);
            console.log('[log-bot] ViewThread interaction received for', starterId);
            let data = await fs.readFile(mapFile, 'utf8').catch(() => null);
            let obj = null;
            if (data) {
                try { obj = JSON.parse(data); } catch (e) { obj = null; }
            }
            if (!obj || !obj.path) {
                const found = await findThreadFileByStarter(starterId).catch(() => null);
                if (!found) return await interaction.reply({ content: 'No thread history found.', ephemeral: true });
                obj = found;
                try {
                    await fs.ensureDir(threads_log_dir);
                    await fs.writeFile(mapFile, JSON.stringify(obj, null, 2), 'utf8').catch(() => {});
                } catch (e) {}
            }
            const threadData = await fs.readFile(obj.path, 'utf8').catch(() => null);
            if (!threadData) return await interaction.reply({ content: 'Thread file missing.', ephemeral: true });
            let arr = []; try { arr = JSON.parse(threadData); } catch (e) { arr = []; }
            arr = Array.isArray(arr) ? arr.slice().reverse() : arr;
            const pages = buildPagesFromMessages(arr, 38);
            if (!pages.length) return await interaction.reply({ content: 'No visible messages in thread history.', ephemeral: true });
            const currentPage = Math.max(0, Math.min(page, pages.length - 1));
            const components = [];
            if (pages.length > 1) {
                const row = new ActionRowBuilder();
                if (currentPage > 0) row.addComponents(new ButtonBuilder().setCustomId(`thread_view_${starterId}_p${currentPage - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary));
                if (currentPage < pages.length - 1) row.addComponents(new ButtonBuilder().setCustomId(`thread_view_${starterId}_p${currentPage + 1}`).setLabel('Next').setStyle(ButtonStyle.Primary));
                components.push(row);
            }
            await interaction.deferUpdate().catch(() => {});
            try {
                const sent = interaction.message ? await interaction.message.reply({ embeds: pages[currentPage], components }).catch(async (err) => { console.error('[log-bot] reply failed', err); return await interaction.channel.send({ embeds: pages[currentPage], components }).catch(() => null); }) : await interaction.channel.send({ embeds: pages[currentPage], components }).catch(() => null);
                if (!sent) console.warn('[log-bot] View message not sent for', starterId);
            } catch (e) { console.error('[log-bot] Error creating view message', e); }
            return;
        }
        if (id.startsWith('thread_view_')) {
            const parts = id.replace('thread_view_', '').split('_p');
            const starterId = parts[0];
            const page = parseInt(parts[1] || '0', 10) || 0;
            const mapFile = path.join(threads_log_dir, `${starterId}.json`);
            const data = await fs.readFile(mapFile, 'utf8').catch(() => null);
            if (!data) return await interaction.reply({ content: 'No thread history found.', ephemeral: true });
            let obj; try { obj = JSON.parse(data); } catch (e) { obj = null; }
            if (!obj || !obj.path) return await interaction.reply({ content: 'Invalid thread mapping.', ephemeral: true });
            const threadData = await fs.readFile(obj.path, 'utf8').catch(() => null);
            if (!threadData) return await interaction.reply({ content: 'Thread file missing.', ephemeral: true });
            let arr = []; try { arr = JSON.parse(threadData); } catch (e) { arr = []; }
            arr = Array.isArray(arr) ? arr.slice().reverse() : arr;
            const pages = buildPagesFromMessages(arr, 38);
            if (!pages.length) return await interaction.reply({ content: 'No visible messages in thread history.', ephemeral: true });
            const currentPage = Math.max(0, Math.min(page, pages.length - 1));
            const components = [];
            if (pages.length > 1) {
                const row = new ActionRowBuilder();
                if (currentPage > 0) row.addComponents(new ButtonBuilder().setCustomId(`thread_view_${starterId}_p${currentPage - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary));
                if (currentPage < pages.length - 1) row.addComponents(new ButtonBuilder().setCustomId(`thread_view_${starterId}_p${currentPage + 1}`).setLabel('Next').setStyle(ButtonStyle.Primary));
                components.push(row);
            }
            try {
                await interaction.update({ embeds: pages[currentPage], components }).catch(async (err) => {
                    console.error('[log-bot] update failed', err);
                    await interaction.channel.send({ embeds: pages[currentPage], components }).catch(() => {});
                    await interaction.deferUpdate().catch(() => {});
                });
            } catch (e) { console.error('thread_view update error', e); }
        }
    } catch (e) {
        console.error('interactionCreate error', e);
    }
});

client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.isChatInputCommand()) return;
        if (!interaction.inGuild()) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
        if (ALLOWED_GUILD_IDS && !ALLOWED_GUILD_IDS.has(interaction.guildId)) return interaction.reply({ content: 'This server is not allowed to use this bot.', ephemeral: true });
        const member = interaction.member;
        if (!member) return interaction.reply({ content: 'Cannot determine member.', ephemeral: true });
        if (interaction.commandName === 'log_del') {
            const hasPerm = member.permissions ? member.permissions.has(PermissionsBitField.Flags.ManageMessages) || member.permissions.has(PermissionsBitField.Flags.Administrator) : false;
            if (!hasPerm) return interaction.reply({ content: 'You do not have permission to run this command.', ephemeral: true });
            const logMsgId = interaction.options.getString('log_message_id');
            if (!logMsgId) return interaction.reply({ content: 'Missing logs message id.', ephemeral: true });
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
            const guildLogsChannelId = getLogsChannelIdForGuild(interaction.guildId) || LOGS_CHANNEL_ID;
            const logsChannel = await client.channels.fetch(guildLogsChannelId).catch(() => null);
            if (!logsChannel) return interaction.editReply({ content: 'Logs channel not accessible.' }).catch(() => {});
            let origMessageId = null;
            let matchedSentObj = null;
            try {
                const sentFiles = await fs.readdir(complete_logs).catch(() => []);
                for (const sf of sentFiles) {
                    if (!sf.endsWith('.json')) continue;
                    const fp = path.join(complete_logs, sf);
                    const content = await fs.readFile(fp, 'utf8').catch(() => null);
                    if (!content) continue;
                    let obj = null; try { obj = JSON.parse(content); } catch (e) { obj = null; }
                    if (!obj || !Array.isArray(obj.sent)) continue;
                    if (obj.sent.find(x => String(x) === String(logMsgId))) {
                        origMessageId = path.basename(fp).replace(/\.json$/i, '');
                        matchedSentObj = { fp, obj };
                    }
                }
            } catch (e) {}
            let origInfo = null;
            if (origMessageId) {
                try { origInfo = await findSerializedMessageById(origMessageId); } catch (e) { origInfo = null; }
                if (!origInfo) {
                    try {
                        const threadMapFile = path.join(threads_log_dir, `${origMessageId}.json`);
                        const mapData = await fs.readFile(threadMapFile, 'utf8').catch(() => null);
                        if (mapData) {
                            let mapObj = null;
                            try { mapObj = JSON.parse(mapData); } catch (e) { mapObj = null; }
                            if (mapObj && mapObj.path) {
                                const threadData = await fs.readFile(mapObj.path, 'utf8').catch(() => null);
                                if (threadData) {
                                    let arr = []; try { arr = JSON.parse(threadData); } catch (e) { arr = []; }
                                    if (Array.isArray(arr)) {
                                        const found = arr.find(m => String(m.id) === String(origMessageId));
                                        if (found) origInfo = { message: found, path: mapObj.path };
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            }
            try {
                if (logsChannel && logsChannel.send) {
                    const actor = `${interaction.user.tag} (${interaction.user.id})`;
                    let origAuthor = 'Unknown';
                    let contentExcerpt = null;
                    let hadText = false, hadEmbed = false, hadAttachment = false;
                    if (origInfo && origInfo.message) {
                        origAuthor = `${origInfo.message.authorTag || origInfo.message.authorName || 'Unknown'} (${origInfo.message.authorId || ''})`;
                        hadText = Boolean(origInfo.message.content && String(origInfo.message.content).trim().length > 0);
                        hadEmbed = Array.isArray(origInfo.message.embeds) && origInfo.message.embeds.length > 0;
                        hadAttachment = Array.isArray(origInfo.message.attachments) && origInfo.message.attachments.length > 0;
                        if (hadText) contentExcerpt = String(origInfo.message.content).substring(0, 1000);
                    } else if (matchedSentObj && origMessageId) {
                        try {
                            const logMsg = await logsChannel.messages.fetch(logMsgId).catch(() => null);
                            if (logMsg && Array.isArray(logMsg.embeds) && logMsg.embeds.length) {
                                const emb = logMsg.embeds[0];
                                const sentByField = (emb.fields || []).find(f => f.name && f.name.toLowerCase().includes('sent by'));
                                if (sentByField && sentByField.value) {
                                    const m = sentByField.value.match(/^(.*)\s*\((\d{17,19}|N\/A)\)$/);
                                    if (m) {
                                        origAuthor = `${m[1].trim()} (${m[2]})`;
                                    } else {
                                        origAuthor = sentByField.value;
                                    }
                                }
                                hadText = Boolean(logMsg.embeds[1] && logMsg.embeds[1].description && String(logMsg.embeds[1].description).trim().length > 0);
                                hadEmbed = Boolean(logMsg.embeds.length > (hadText ? 2 : 1));
                                hadAttachment = Boolean(logMsg.attachments && logMsg.attachments.size > 0);
                                if (hadText && !contentExcerpt) contentExcerpt = logMsg.embeds[1]?.description?.substring(0, 1000) || null;
                            }
                        } catch (e) {}
                        if (!origAuthor || origAuthor === 'Unknown') origAuthor = `Unknown (${origMessageId})`;
                    } else if (origMessageId) {
                        origAuthor = `Unknown (${origMessageId})`;
                    }
                    const check = (v) => v ? '✅' : '❌';
                    const infoEmbed = new EmbedBuilder()
                        .setTitle('Log deleted')
                        .addFields(
                            { name: 'Log deleted by', value: actor, inline: true },
                            { name: 'Original message sent by', value: origAuthor, inline: true },
                            { name: 'Message had', value: `Text: ${check(hadText)}\nEmbed: ${check(hadEmbed)}\nAttachment: ${check(hadAttachment)}` }
                        )
                        .setTimestamp();
                    if (contentExcerpt) infoEmbed.setDescription(contentExcerpt);
                    await logsChannel.send({ embeds: [infoEmbed] }).catch(() => {});
                }
            } catch (e) {}
            let deleted = false;
            try {
                tempIgnoreMessage(logMsgId, 7000);
                const m = await logsChannel.messages.fetch(logMsgId).catch(() => null);
                if (m) {
                    await m.delete().catch(() => {});
                    deleted = true;
                }
            } catch (e) {}
            try {
                const sentFiles = await fs.readdir(complete_logs).catch(() => []);
                for (const sf of sentFiles) {
                    if (!sf.endsWith('.json')) continue;
                    const fp = path.join(complete_logs, sf);
                    const content = await fs.readFile(fp, 'utf8').catch(() => null);
                    if (!content) continue;
                    let obj = null; try { obj = JSON.parse(content); } catch (e) { obj = null; }
                    if (!obj || !Array.isArray(obj.sent)) continue;
                    const origLen = obj.sent.length;
                    obj.sent = obj.sent.filter(x => String(x) !== String(logMsgId));
                    if (obj.sent.length === 0) {
                        await fs.remove(fp).catch(() => {});
                    } else if (obj.sent.length !== origLen) {
                        await fs.writeFile(fp, JSON.stringify(obj, null, 2), 'utf8').catch(() => {});
                    }
                }
            } catch (e) {}
            if (!deleted) return interaction.editReply({ content: `Could not find or delete logs message id ${logMsgId}.` }).catch(() => {});
            await interaction.editReply({ content: `Deleted logs message ${logMsgId}.` }).catch(() => {});
            return;
        }
        if (interaction.commandName === 'logging_channel') {
            const hasPerm = member.permissions ? member.permissions.has(PermissionsBitField.Flags.ManageGuild) || member.permissions.has(PermissionsBitField.Flags.Administrator) : false;
            if (!hasPerm) return interaction.reply({ content: 'You do not have permission to change the logging channel.', ephemeral: true });
            const optChannel = interaction.options.getChannel('channel');
            const gid = interaction.guildId;
            loadServers();
            if (optChannel) {
                let canSend = false;
                try {
                    const fetched = await client.channels.fetch(optChannel.id).catch(() => null);
                    if (fetched && fetched.send) canSend = true;
                } catch (e) {}
                if (!canSend) return interaction.reply({ content: 'The selected channel is not a text channel the bot can send to.', ephemeral: true });
                SERVERS[gid] = optChannel.id;
                saveServers();
                return interaction.reply({ content: `Logging channel set to <#${optChannel.id}> for this server.`, ephemeral: true });
            }
            const current = SERVERS[gid] || null;
            if (current && String(current) === String(interaction.channelId)) {
                delete SERVERS[gid];
                saveServers();
                return interaction.reply({ content: `Logging channel mapping removed for this server. Bot will use default logs channel (if configured).`, ephemeral: true });
            } else {
                const ch = interaction.channel;
                let canSend = Boolean(ch && ch.send);
                if (!canSend) {
                    try { const f = await client.channels.fetch(interaction.channelId).catch(() => null); if (f && f.send) canSend = true; } catch (e) {}
                }
                if (!canSend) return interaction.reply({ content: 'Cannot use this channel for logs (bot cannot send here).', ephemeral: true });
                SERVERS[gid] = interaction.channelId;
                saveServers();
                return interaction.reply({ content: `Logging channel set to this channel (<#${interaction.channelId}>) for this server.`, ephemeral: true });
            }
        }
    } catch (e) {
        console.error('slash command handler error', e);
    }
});

client.on('threadCreate', async (thread) => {
    try {
        const starter = await thread.fetchStarterMessage().catch(() => null);
        if (!starter || !starter.id) return;
        const fp = await historyFilePath(thread);
        await mapThreadStarter(starter.id, thread.id, fp).catch(() => {});
    } catch (e) {}
});

client.on('threadDelete', async (thread) => {
    try {
        const dirItems = await fs.readdir(threads_log_dir).catch(() => []);
        let mappingFound = null;
        for (const item of dirItems) {
            if (!item.endsWith('.json')) continue;
            const fp = path.join(threads_log_dir, item);
            const data = await fs.readFile(fp, 'utf8').catch(() => null);
            if (!data) continue;
            let obj = null;
            try { obj = JSON.parse(data); } catch (e) { obj = null; }
            if (obj && obj.threadId === thread.id) {
                if (obj.path) {
                    const threadFile = obj.path;
                    const exists = await fs.pathExists(threadFile).catch(() => false);
                    if (exists) {
                        const deletedFolder = path.join(path.dirname(threadFile), '..', 'deleted');
                        await fs.ensureDir(deletedFolder).catch(() => {});
                        const dest = path.join(deletedFolder, path.basename(threadFile));
                        await fs.move(threadFile, dest, { overwrite: true }).catch(() => {});
                        try {
                            await fs.writeFile(fp, JSON.stringify({ threadId: obj.threadId, path: dest }, null, 2), 'utf8').catch(() => {});
                        } catch (e) {}
                        mappingFound = { starterId: item.replace(/\.json$/i, ''), mapFile: fp, path: dest };
                    } else {
                        const possible = await findThreadFileByStarter(thread.id).catch(() => null);
                        if (possible && possible.path) {
                            const deletedFolder = path.join(path.dirname(possible.path), '..', 'deleted');
                            await fs.ensureDir(deletedFolder).catch(() => {});
                            const dest = path.join(deletedFolder, path.basename(possible.path));
                            await fs.move(possible.path, dest, { overwrite: true }).catch(() => {});
                            try {
                                await fs.writeFile(fp, JSON.stringify({ threadId: obj.threadId, path: dest }, null, 2), 'utf8').catch(() => {});
                            } catch (e) {}
                            mappingFound = { starterId: item.replace(/\.json$/i, ''), mapFile: fp, path: dest };
                        }
                    }
                } else {
                    mappingFound = { starterId: item.replace(/\.json$/i, ''), mapFile: fp, path: obj.path || null };
                }
                try { const th = await client.channels.fetch(obj.threadId).catch(() => null); if (th && th.isThread?.()) await th.delete().catch(() => {}); } catch (e) {}
                break;
            }
        }
        try {
            const guildId = thread.guildId || thread?.guild?.id || (thread.parent ? thread.parent.guildId : null);
            const logsChannelId = getLogsChannelIdForGuild(guildId);
            if (logsChannelId) {
                const logsChannel = await client.channels.fetch(logsChannelId).catch(() => null);
                if (logsChannel && logsChannel.send) {
                    const created = thread.createdAt ? new Date(thread.createdAt) : new Date();
                    const createdTs = Math.floor(created.getTime() / 1000);
                    const title = 'Thread deleted';
                    const threadName = thread.name || `Thread ${thread.id}`;
                    const threadField = `${threadName} (${thread.id})`;
                    let madeUnder = '';
                    if (mappingFound && mappingFound.starterId && thread.parentId && guildId) {
                        const starterId = mappingFound.starterId;
                        const msgLink = `https://discord.com/channels/${guildId}/${thread.parentId}/${starterId}`;
                        madeUnder = `Message: [link](${msgLink}) in <#${thread.parentId}>`;
                    } else if (thread.parentId) {
                        madeUnder = `Channel: <#${thread.parentId}>`;
                    } else {
                        madeUnder = 'Unknown';
                    }
                    const emb = new EmbedBuilder()
                        .setTitle(title)
                        .addFields(
                            { name: 'Thread', value: threadField, inline: true },
                            { name: 'Made under / in', value: madeUnder, inline: true },
                            { name: 'Deleted', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true }
                        )
                        .setTimestamp();
                    const components = [];
                    if (mappingFound && mappingFound.starterId) {
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`view_thread_${mappingFound.starterId}_p0`)
                                .setLabel('Thread')
                                .setEmoji('🧵')
                                .setStyle(ButtonStyle.Primary)
                        );
                        components.push(row);
                    }
                    await logsChannel.send({ embeds: [emb], components }).catch(() => {});
                }
            }
        } catch (e) {}
    } catch (e) {}
});

client.login(BOT_TOKEN).catch((e) => {
    console.error('Failed to login:', e);
});

