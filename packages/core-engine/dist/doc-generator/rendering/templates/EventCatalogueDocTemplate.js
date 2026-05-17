"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventCatalogueDocTemplate = void 0;
class EventCatalogueDocTemplate {
    category = 'event-catalogue';
    fileName = 'event-catalogue.md';
    isApplicable(k) {
        const eventEdges = k.callGraph.filter((e) => e.callType === 'event-emit' || e.callType === 'event-subscribe');
        if (eventEdges.length === 0) {
            return { applicable: false, degradationLevel: 'skipped', reason: 'No event-emit or event-subscribe edges in call graph' };
        }
        return { applicable: true, degradationLevel: 'full' };
    }
    async render(k, _ctx, signal) {
        signal?.throwIfAborted();
        const emits = k.callGraph.filter((e) => e.callType === 'event-emit');
        const subscribes = k.callGraph.filter((e) => e.callType === 'event-subscribe');
        const lines = ['# Event Catalogue', ''];
        lines.push(`${emits.length} emit(s), ${subscribes.length} subscribe(s) detected.`, '');
        if (emits.length > 0) {
            lines.push('## Event Emissions', '');
            lines.push('| Event | Emitter File | Symbol | Line |');
            lines.push('|-------|-------------|--------|------|');
            for (const e of emits.slice(0, 50)) {
                lines.push(`| \`${e.calleeSymbol}\` | \`${e.callerFile.split('/').pop()}\` | \`${e.callerSymbol}\` | ${e.line} |`);
            }
            lines.push('');
        }
        if (subscribes.length > 0) {
            lines.push('## Event Subscriptions', '');
            lines.push('| Event | Subscriber File | Symbol | Line |');
            lines.push('|-------|----------------|--------|------|');
            for (const e of subscribes.slice(0, 50)) {
                lines.push(`| \`${e.calleeSymbol}\` | \`${e.callerFile.split('/').pop()}\` | \`${e.callerSymbol}\` | ${e.line} |`);
            }
            lines.push('');
        }
        const rendered = lines.join('\n');
        return {
            fileName: this.fileName,
            category: this.category,
            title: 'Event Catalogue',
            sections: [{ id: 'event-catalogue', title: 'Event Catalogue', content: rendered, order: 0 }],
            rendered,
        };
    }
}
exports.EventCatalogueDocTemplate = EventCatalogueDocTemplate;
//# sourceMappingURL=EventCatalogueDocTemplate.js.map