"use strict";
// DONE: Phase B.3a — NoveltyClassifier.
// Determines whether a completed task is "novel" — worth distilling into a lesson.
// Novel = first-of-its-kind error class, after-failure recovery, or novel tool sequence.
// Estimated to drop distillation volume by 60–80%.
// Pure logic; caller provides the bloom-filter / seen-set.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fingerprintToolSequence = fingerprintToolSequence;
exports.classifyNovelty = classifyNovelty;
/**
 * Fingerprint a tool sequence for deduplication.
 * Collapses runs of the same tool into one entry to avoid trivially-different sequences.
 */
function fingerprintToolSequence(tools) {
    const collapsed = [];
    for (const t of tools) {
        if (t !== collapsed[collapsed.length - 1])
            collapsed.push(t);
    }
    return collapsed.join(':');
}
/**
 * Classify whether a task result is novel enough to warrant distillation.
 *
 * Returns novel=true for:
 *   1. Any 'recovery' outcome (agent recovered from failure — high signal).
 *   2. A 'failure' with an unseen errorClass.
 *   3. A 'success' with an unseen tool-sequence fingerprint.
 *   4. A 'success' with subgoalCount > 8 (complex task, rarer signal).
 */
function classifyNovelty(task, context) {
    if (task.outcome === 'recovery') {
        return { novel: true, reason: 'recovery_outcome' };
    }
    if (task.outcome === 'failure' && task.errorClass) {
        if (!context.seenErrorClasses.has(task.errorClass)) {
            return { novel: true, reason: `new_error_class:${task.errorClass}` };
        }
    }
    if (task.outcome === 'success' && task.toolSequence && task.toolSequence.length > 0) {
        const fp = fingerprintToolSequence(task.toolSequence);
        if (!context.seenToolFingerprints.has(fp)) {
            return { novel: true, reason: `new_tool_sequence:${fp.slice(0, 40)}` };
        }
    }
    if (task.outcome === 'success' && (task.subgoalCount ?? 0) > 8) {
        return { novel: true, reason: 'high_complexity_success' };
    }
    return { novel: false, reason: 'seen_before' };
}
//# sourceMappingURL=NoveltyClassifier.js.map