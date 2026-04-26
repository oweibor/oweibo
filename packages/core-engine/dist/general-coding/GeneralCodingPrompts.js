"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
// packages/core-engine/src/general-coding/GeneralCodingPrompts.ts
//
// Re-export shim — the implementation lives in observability/GeneralCodingPrompts.ts
// (where Langfuse instrumentation utilities already live), but the plan specification
// (§16f.4) places this file at general-coding/GeneralCodingPrompts.ts.
//
// Any code that imports from the planned path gets the full implementation.
// The observability/ source remains the single authoritative file.
__exportStar(require("../observability/GeneralCodingPrompts.js"), exports);
//# sourceMappingURL=GeneralCodingPrompts.js.map