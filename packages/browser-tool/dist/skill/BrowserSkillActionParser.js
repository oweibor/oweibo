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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserSkillActionParser = void 0;
// packages/browser-tool/src/skill/BrowserSkillActionParser.ts
// Parses skill YAML/JSON action lists and validates each action against
// BrowserActionSchema before they're queued for BrowserTool dispatch (M5).
const yaml = __importStar(require("js-yaml"));
const BrowserActionSchema_js_1 = require("../tool/BrowserActionSchema.js");
class BrowserSkillActionParser {
    parse(source) {
        let raw;
        try {
            raw = yaml.load(source);
        }
        catch (e) {
            return { actions: [], errors: [`yaml load failed: ${e.message}`] };
        }
        if (!Array.isArray(raw))
            return { actions: [], errors: ['top-level must be a list of actions'] };
        const actions = [];
        const errors = [];
        raw.forEach((item, i) => {
            const r = BrowserActionSchema_js_1.BrowserActionSchema.safeParse(item);
            if (r.success)
                actions.push(r.data);
            else
                errors.push(`action[${i}]: ${r.error.message}`);
        });
        return { actions, errors };
    }
}
exports.BrowserSkillActionParser = BrowserSkillActionParser;
//# sourceMappingURL=BrowserSkillActionParser.js.map