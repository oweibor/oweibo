// packages/core-engine/src/general-coding/GeneralCodingPrompts.ts
//
// Re-export shim — the implementation lives in observability/GeneralCodingPrompts.ts
// (where Langfuse instrumentation utilities already live), but the plan specification
// (§16f.4) places this file at general-coding/GeneralCodingPrompts.ts.
//
// Any code that imports from the planned path gets the full implementation.
// The observability/ source remains the single authoritative file.
export * from '../observability/GeneralCodingPrompts.js';
