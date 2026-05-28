"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainCurrencyFeedEgressBlocked = void 0;
/**
 * Labeled error a feed adapter MUST throw when the egress proxy denies
 * its destination. The platform alerting layer pivots on this string.
 */
class DomainCurrencyFeedEgressBlocked extends Error {
    feedId;
    destination;
    code = 'DOMAIN_CURRENCY_FEED_EGRESS_BLOCKED';
    constructor(feedId, destination) {
        super(`DOMAIN_CURRENCY_FEED_EGRESS_BLOCKED: feed=${feedId} dest=${destination}`);
        this.feedId = feedId;
        this.destination = destination;
        this.name = 'DomainCurrencyFeedEgressBlocked';
    }
}
exports.DomainCurrencyFeedEgressBlocked = DomainCurrencyFeedEgressBlocked;
//# sourceMappingURL=IDomainCurrency.js.map