"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelCommandParser = exports.ChannelEventBridge = exports.ChannelRouter = exports.IdentityResolver = exports.DuplicateBotTokenError = exports.ChannelCredentialVault = exports.BotInstanceManager = void 0;
exports.startGateway = startGateway;
// packages/channel-gateway/src/index.ts
// startGateway() bootstrap (§21.11)
const TelegramAdapter_js_1 = require("./adapters/TelegramAdapter.js");
const DiscordAdapter_js_1 = require("./adapters/DiscordAdapter.js");
const SlackAdapter_js_1 = require("./adapters/SlackAdapter.js");
const WhatsAppAdapter_js_1 = require("./adapters/WhatsAppAdapter.js");
const SignalAdapter_js_1 = require("./adapters/SignalAdapter.js");
const iMessageAdapter_js_1 = require("./adapters/iMessageAdapter.js");
const GoogleChatAdapter_js_1 = require("./adapters/GoogleChatAdapter.js");
const IRCAdapter_js_1 = require("./adapters/IRCAdapter.js");
const WebChatAdapter_js_1 = require("./adapters/WebChatAdapter.js");
const ChannelCredentialVault_js_1 = require("./ChannelCredentialVault.js");
const BotInstanceManager_js_1 = require("./BotInstanceManager.js");
const IdentityResolver_js_1 = require("./IdentityResolver.js");
const ChannelRouter_js_1 = require("./ChannelRouter.js");
const ChannelEventBridge_js_1 = require("./ChannelEventBridge.js");
const ChannelCommandParser_js_1 = require("./ChannelCommandParser.js");
async function startGateway(deps) {
    const jwtSecret = await deps.secrets.getSecret('oweibo/gateway/webchat-jwt-secret') ?? 'change-me';
    const adapters = new Map([
        ['telegram', new TelegramAdapter_js_1.TelegramAdapter()],
        ['discord', new DiscordAdapter_js_1.DiscordAdapter()],
        ['slack', new SlackAdapter_js_1.SlackAdapter()],
        ['whatsapp', new WhatsAppAdapter_js_1.WhatsAppAdapter()],
        ['signal', new SignalAdapter_js_1.SignalAdapter()],
        ['imessage', new iMessageAdapter_js_1.iMessageAdapter()],
        ['googlechat', new GoogleChatAdapter_js_1.GoogleChatAdapter()],
        ['irc', new IRCAdapter_js_1.IRCAdapter()],
        ['webchat', new WebChatAdapter_js_1.WebChatAdapter()],
    ]);
    // Inject jwt secret into WebChatAdapter after construction
    const webchat = adapters.get('webchat');
    webchat.jwtSecret = jwtSecret;
    const credVault = new ChannelCredentialVault_js_1.ChannelCredentialVault(deps.secrets, deps.redis);
    const identity = new IdentityResolver_js_1.IdentityResolver(deps.redis);
    const commandParser = new ChannelCommandParser_js_1.ChannelCommandParser(deps.interventionGw, adapters, deps.redis);
    const router = new ChannelRouter_js_1.ChannelRouter(identity, commandParser, deps.intentPipeline);
    const manager = new BotInstanceManager_js_1.BotInstanceManager(adapters, credVault, router);
    const bridge = new ChannelEventBridge_js_1.ChannelEventBridge(deps.eventBus, adapters, deps.contextStore);
    bridge.subscribe();
    // Register all (tenantId, platform) pairs declared at startup.
    // Failures are logged but do not abort startup — remaining bots continue.
    const results = await Promise.allSettled(deps.initialRegistrations.map(r => manager.register(r)));
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            console.error(`[channel-gateway] Failed to register bot for`, deps.initialRegistrations[i], '—', r.reason);
        }
    });
    return manager;
}
var BotInstanceManager_js_2 = require("./BotInstanceManager.js");
Object.defineProperty(exports, "BotInstanceManager", { enumerable: true, get: function () { return BotInstanceManager_js_2.BotInstanceManager; } });
var ChannelCredentialVault_js_2 = require("./ChannelCredentialVault.js");
Object.defineProperty(exports, "ChannelCredentialVault", { enumerable: true, get: function () { return ChannelCredentialVault_js_2.ChannelCredentialVault; } });
Object.defineProperty(exports, "DuplicateBotTokenError", { enumerable: true, get: function () { return ChannelCredentialVault_js_2.DuplicateBotTokenError; } });
var IdentityResolver_js_2 = require("./IdentityResolver.js");
Object.defineProperty(exports, "IdentityResolver", { enumerable: true, get: function () { return IdentityResolver_js_2.IdentityResolver; } });
var ChannelRouter_js_2 = require("./ChannelRouter.js");
Object.defineProperty(exports, "ChannelRouter", { enumerable: true, get: function () { return ChannelRouter_js_2.ChannelRouter; } });
var ChannelEventBridge_js_2 = require("./ChannelEventBridge.js");
Object.defineProperty(exports, "ChannelEventBridge", { enumerable: true, get: function () { return ChannelEventBridge_js_2.ChannelEventBridge; } });
var ChannelCommandParser_js_2 = require("./ChannelCommandParser.js");
Object.defineProperty(exports, "ChannelCommandParser", { enumerable: true, get: function () { return ChannelCommandParser_js_2.ChannelCommandParser; } });
//# sourceMappingURL=index.js.map