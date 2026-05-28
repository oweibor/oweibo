"use strict";
/**
 * S.0: ActionLineage — append-only audit tree linking every decision
 * upstream of an action execution.
 *
 * Used by S.3 (rollback finds the originating decision) and S.7
 * (forensic replay reconstructs the full tree). Lineage is never
 * mutated after write; the partitioned table sheds old months on a
 * rolling 180-day window.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=ActionLineage.js.map