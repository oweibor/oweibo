"use strict";
/**
 * VisualTriggerGuard — event-driven visual probe gate (§16c, Gap §5).
 *
 * Guards against unnecessary visual perception probes. Only triggers
 * visual analysis when file change events indicate UI-related modifications
 * (component files, CSS, templates, images).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VisualTriggerGuard = void 0;
const VISUAL_FILE_PATTERNS = [
    /\.(tsx|jsx)$/,
    /\.(css|scss|sass|less|styl)$/,
    /\.(html|hbs|ejs|pug|mustache)$/,
    /\.(svg|png|jpg|jpeg|gif|webp|ico)$/,
    /\.module\.(css|scss)$/,
    /tailwind\.config/,
    /theme\./,
    /\.stories\.(tsx|jsx|ts|js)$/,
];
const COMPONENT_DIRS = [
    'components', 'pages', 'views', 'layouts', 'templates',
    'ui', 'widgets', 'screens',
];
class VisualTriggerGuard {
    onVisualChange;
    pendingTriggers = [];
    debounceTimer = null;
    debounceMs;
    constructor(onVisualChange, debounceMs = 2000) {
        this.onVisualChange = onVisualChange;
        this.debounceMs = debounceMs;
    }
    handleFileChange(filePath, changeType) {
        const trigger = this.classify(filePath, changeType);
        if (!trigger.isVisualRelevant)
            return;
        this.pendingTriggers.push(trigger);
        // Debounce: wait for batch of changes to settle
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
    }
    async flush() {
        if (this.pendingTriggers.length === 0)
            return;
        const triggers = [...this.pendingTriggers];
        this.pendingTriggers = [];
        await this.onVisualChange(triggers);
    }
    classify(filePath, changeType) {
        const isVisualRelevant = VISUAL_FILE_PATTERNS.some(p => p.test(filePath))
            || COMPONENT_DIRS.some(dir => filePath.includes(`/${dir}/`) || filePath.includes(`\\${dir}\\`));
        let category = 'logic';
        if (/\.(tsx|jsx)$/.test(filePath) || COMPONENT_DIRS.some(d => filePath.includes(d))) {
            category = 'component';
        }
        else if (/\.(css|scss|sass|less|styl)$/.test(filePath)) {
            category = 'style';
        }
        else if (/\.(html|hbs|ejs|pug)$/.test(filePath)) {
            category = 'template';
        }
        else if (/\.(svg|png|jpg|jpeg|gif|webp|ico)$/.test(filePath)) {
            category = 'asset';
        }
        else if (/config/.test(filePath)) {
            category = 'config';
        }
        return { filePath, changeType, isVisualRelevant, category };
    }
    dispose() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingTriggers = [];
    }
}
exports.VisualTriggerGuard = VisualTriggerGuard;
//# sourceMappingURL=VisualTriggerGuard.js.map