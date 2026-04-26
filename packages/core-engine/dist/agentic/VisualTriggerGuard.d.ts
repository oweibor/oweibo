/**
 * VisualTriggerGuard — event-driven visual probe gate (§16c, Gap §5).
 *
 * Guards against unnecessary visual perception probes. Only triggers
 * visual analysis when file change events indicate UI-related modifications
 * (component files, CSS, templates, images).
 */
export interface VisualTrigger {
    readonly filePath: string;
    readonly changeType: 'added' | 'modified' | 'deleted';
    readonly isVisualRelevant: boolean;
    readonly category: 'component' | 'style' | 'template' | 'asset' | 'config' | 'logic';
}
export declare class VisualTriggerGuard {
    private readonly onVisualChange;
    private pendingTriggers;
    private debounceTimer;
    private readonly debounceMs;
    constructor(onVisualChange: (triggers: VisualTrigger[]) => Promise<void>, debounceMs?: number);
    handleFileChange(filePath: string, changeType: 'added' | 'modified' | 'deleted'): void;
    private flush;
    private classify;
    dispose(): void;
}
//# sourceMappingURL=VisualTriggerGuard.d.ts.map