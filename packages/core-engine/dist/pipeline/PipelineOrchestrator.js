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
exports.PipelineOrchestrator = void 0;
const _00_memory_retrieval_stage_js_1 = require("./stages/00-memory-retrieval.stage.js");
const _01_architect_stage_js_1 = require("./stages/01-architect.stage.js");
const _02_orchestrate_stage_js_1 = require("./stages/02-orchestrate.stage.js");
const _03_tdd_gate_stage_js_1 = require("./stages/03-tdd-gate.stage.js");
const _03b_critic_gate_stage_js_1 = require("./stages/03b-critic-gate.stage.js");
const _04_static_gate_stage_js_1 = require("./stages/04-static-gate.stage.js");
const _05_deterministic_gate_stage_js_1 = require("./stages/05-deterministic-gate.stage.js");
const _06_semantic_gate_stage_js_1 = require("./stages/06-semantic-gate.stage.js");
const _06b_compliance_gate_stage_js_1 = require("./stages/06b-compliance-gate.stage.js");
const _07_adr_gate_stage_js_1 = require("./stages/07-adr-gate.stage.js");
const _08_promote_stage_js_1 = require("./stages/08-promote.stage.js");
const _08b_smoke_test_stage_js_1 = require("./stages/08b-smoke-test.stage.js");
const _09_documentation_stage_js_1 = require("./stages/09-documentation.stage.js");
const EntropyTracker_js_1 = require("../agentic/EntropyTracker.js");
const fsNode = __importStar(require("fs/promises"));
const pathNode = __importStar(require("path"));
const STAGE_ORDER = [
    '00-memory', '01-architect', '02-orchestrate', '03-tdd',
    '03b-critic', '04-static', '05-deterministic', '06-semantic',
    '06b-compliance', '07-adr', '08-promote', '08b-smoke', '09-documentation',
];
const STAGE_PROGRESS = {
    '00-memory': 30, '01-architect': 35, '02-orchestrate': 40, '03-tdd': 45,
    '03b-critic': 50, '04-static': 55, '05-deterministic': 60, '06-semantic': 70,
    '06b-compliance': 75, '07-adr': 80, '08-promote': 85, '08b-smoke': 88, '09-documentation': 92,
};
class PipelineOrchestrator {
    deps;
    stages;
    constructor(deps) {
        this.deps = deps;
        this.stages = new Map([
            ['00-memory', new _00_memory_retrieval_stage_js_1.MemoryRetrievalStage()],
            ['01-architect', new _01_architect_stage_js_1.ArchitectStage()],
            ['02-orchestrate', new _02_orchestrate_stage_js_1.OrchestrateStage()],
            ['03-tdd', new _03_tdd_gate_stage_js_1.TDDGateStage()],
            ['03b-critic', new _03b_critic_gate_stage_js_1.CriticGateStage()],
            ['04-static', new _04_static_gate_stage_js_1.StaticGateStage()],
            ['05-deterministic', new _05_deterministic_gate_stage_js_1.DeterministicGateStage()],
            ['06-semantic', new _06_semantic_gate_stage_js_1.SemanticGateStage()],
            ['06b-compliance', new _06b_compliance_gate_stage_js_1.ComplianceGateStage()],
            ['07-adr', new _07_adr_gate_stage_js_1.ADRGateStage()],
            ['08-promote', new _08_promote_stage_js_1.PromoteStage()],
            ['08b-smoke', new _08b_smoke_test_stage_js_1.SmokeTestStage()],
            ['09-documentation', new _09_documentation_stage_js_1.DocumentationStage()],
        ]);
    }
    async run(bundle, input, trace, sessionId) {
        const { sandbox, llm, memory, promptRegistry, eventBus } = this.deps;
        const workspacePath = `/workspaces/${input.scaffoldInput.tenantId}/${input.instruction.slice(0, 20).replace(/\W/g, '-')}`;
        const logger = {
            info: (msg) => console.info(`[Pipeline] ${msg}`),
            warn: (msg) => console.warn(`[Pipeline] ${msg}`),
            error: (msg) => console.error(`[Pipeline] ${msg}`),
        };
        const fs = {
            writeFile: async (p, content) => {
                await fsNode.mkdir(pathNode.dirname(p), { recursive: true });
                await fsNode.writeFile(p, content, 'utf8');
            },
            readFile: async (p) => fsNode.readFile(p, 'utf8'),
            exists: async (p) => fsNode.access(p).then(() => true).catch(() => false),
        };
        const ctx = {
            bundle,
            sandbox,
            fs,
            workspacePath,
            llm,
            llmConfig: { model: process.env['LLM_MODEL'] ?? 'claude-sonnet-4-6', temperature: 0.1 },
            promptRegistry,
            memory: memory,
            originalRequirements: '',
            scaffoldInput: input.scaffoldInput,
            trace,
            logger,
            taskId: input.instruction,
            sessionId,
        };
        const decisionLog = [];
        const pushDecision = (stage, result) => decisionLog.push({
            id: `${stage}-${Date.now()}`, stage, result, decision: result, rationale: result,
            requirementRef: '', alternatives: [], rejectedReasons: [], timestamp: new Date().toISOString(),
        });
        const tokensUsed = 0;
        // G17: Rule-of-3 entropy detection. Emits an EntropyViolation when a stage
        // fails 3+ times with semantically similar errors so the caller can trigger
        // an Architect Reset instead of looping indefinitely.
        const entropy = this.deps.redis ? new EntropyTracker_js_1.EntropyTracker(this.deps.redis, ctx.taskId) : null;
        for (const stageName of STAGE_ORDER) {
            const stage = this.stages.get(stageName);
            const progress = STAGE_PROGRESS[stageName] ?? 50;
            await eventBus.publish(sessionId, { taskId: ctx.taskId, type: 'stage-started', message: `Running ${stage.name}...`, progress });
            const result = await stage.execute(ctx);
            pushDecision(stageName, result.passed ? 'PASS' : `FAIL:${result.errorCode}`);
            if (result.passed) {
                await entropy?.recordSuccess(stageName);
            }
            else {
                const violation = await entropy?.recordFailure(stageName, result.message ?? result.errorCode ?? 'unknown');
                if (violation) {
                    logger.error(`[Pipeline] Entropy ${violation.recommendation} triggered for ${stageName} after ${violation.attempts} attempts.`);
                    return {
                        taskId: ctx.taskId,
                        status: 'failed',
                        stage: stageName,
                        error: {
                            stage: stageName,
                            attempt: violation.attempts,
                            maxAttempts: 3,
                            errorCode: 'GATE_FAILED',
                            message: `Entropy ${violation.recommendation}: ${violation.errorPattern}`,
                            recoveryStrategy: violation.recommendation === 'architect-reset' ? 'architect-replan'
                                : violation.recommendation === 'human-escalation' ? 'human-escalation'
                                    : 'retry',
                        },
                        decisionLog,
                        tokensUsed,
                    };
                }
            }
            if (!result.passed && result.blockPromotion) {
                return {
                    taskId: ctx.taskId,
                    status: 'failed',
                    stage: stageName,
                    error: {
                        stage: stageName,
                        attempt: 1,
                        maxAttempts: 3,
                        errorCode: (result.errorCode ?? 'GATE_FAILED'),
                        message: result.message ?? 'Stage failed',
                        recoveryStrategy: 'retry',
                    },
                    decisionLog,
                    tokensUsed,
                };
            }
        }
        await eventBus.publish(sessionId, { taskId: ctx.taskId, type: 'stage-completed', message: 'All pipeline gates passed.', progress: 90 });
        return { taskId: ctx.taskId, status: 'success', stage: '08b-smoke', artifacts: bundle, decisionLog, tokensUsed };
    }
}
exports.PipelineOrchestrator = PipelineOrchestrator;
//# sourceMappingURL=PipelineOrchestrator.js.map