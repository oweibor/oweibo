/**
 * Request body validation middleware.
 *
 * Provides a `validate(schema)` factory that attaches to Express routes and
 * rejects malformed input before it reaches business logic.  Validation rules
 * are expressed as plain field-descriptor objects so there is no runtime schema
 * dependency to manage.
 *
 * Also exports the pre-built validators for the known route bodies.
 *
 * @module middleware/validate
 */

const logger = require('../services/logger');

// ── Field descriptors ─────────────────────────────────────────────────────────

type FieldType = 'string' | 'string?' | 'enum' | 'enum?';

interface FieldRule {
    type: FieldType;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    values?: string[];          // used by 'enum' / 'enum?'
    patternMsg?: string;        // human-readable description for pattern errors
}

type Schema = Record<string, FieldRule>;

// ── Validator factory ─────────────────────────────────────────────────────────

/**
 * Build an Express middleware that validates `req.body` against `schema`.
 * Returns 400 with a structured error body on the first violation found.
 */
function validate(schema: Schema) {
    return (req: any, res: any, next: () => void) => {
        const body = req.body || {};

        for (const [field, rule] of Object.entries(schema)) {
            const value = body[field];
            const required = rule.type === 'string' || rule.type === 'enum';

            // Presence check
            if (value === undefined || value === null || value === '') {
                if (required) {
                    return res.status(400).json({
                        error: 'Bad Request',
                        message: `'${field}' is required`,
                    });
                }
                continue; // optional field absent — skip further checks
            }

            // Type check
            if (typeof value !== 'string') {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: `'${field}' must be a string`,
                });
            }

            // Length checks
            if (rule.minLength !== undefined && value.length < rule.minLength) {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: `'${field}' must be at least ${rule.minLength} character(s)`,
                });
            }
            if (rule.maxLength !== undefined && value.length > rule.maxLength) {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: `'${field}' must be at most ${rule.maxLength} character(s)`,
                });
            }

            // Pattern check
            if (rule.pattern && !rule.pattern.test(value)) {
                return res.status(400).json({
                    error: 'Bad Request',
                    message: `'${field}' ${rule.patternMsg || 'contains invalid characters'}`,
                });
            }

            // Enum check
            if ((rule.type === 'enum' || rule.type === 'enum?') && rule.values) {
                if (!rule.values.includes(value)) {
                    return res.status(400).json({
                        error: 'Bad Request',
                        message: `'${field}' must be one of: ${rule.values.join(' | ')}`,
                    });
                }
            }
        }

        next();
    };
}

// ── Pre-built schemas ─────────────────────────────────────────────────────────

/** Safe identifier: UUID format or slug (no path separators, no null bytes). */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_ID_MSG     = 'must contain only alphanumeric characters, hyphens, or underscores (max 128)';

/** Absolute path: must start with / and not contain null bytes or .. segments. */
const WORKSPACE_PATTERN = /^\/[^\0]*$/;
const WORKSPACE_MSG      = 'must be an absolute POSIX path with no null bytes';

const TASK_SCHEMA: Schema = {
    workspace_path: {
        type:       'string',
        minLength:  2,
        maxLength:  1024,
        pattern:    WORKSPACE_PATTERN,
        patternMsg: WORKSPACE_MSG,
    },
    instruction: {
        type:      'string',
        minLength: 1,
        maxLength: 16_384,   // ~4 096 tokens
    },
    task_id: {
        type:       'string?',
        pattern:    SAFE_ID_PATTERN,
        patternMsg: SAFE_ID_MSG,
    },
    trust_mode_override: {
        type:   'enum?',
        values: ['supervised', 'graduated', 'autonomous'],
    },
};

const TASK_CLEAR_SCHEMA: Schema = {
    task_id: {
        type:       'string',
        pattern:    SAFE_ID_PATTERN,
        patternMsg: SAFE_ID_MSG,
    },
    action: {
        type:   'enum?',
        values: ['provide_guidance', 'mark_permanent', 'reset_ledger'],
    },
    guidance: {
        type:      'string?',
        maxLength: 4_096,
    },
    hash: {
        type:       'string?',
        pattern:    /^[a-f0-9]{64}$/,
        patternMsg: 'must be a 64-char hex string (SHA-256)',
    },
};

const SCRAPE_SCHEMA: Schema = {
    url: {
        type:      'string',
        minLength: 8,
        maxLength: 2_048,
        pattern:   /^https?:\/\/.+/,
        patternMsg: 'must be a valid HTTP/HTTPS URL',
    },
    depth: {
        type:       'string?',
        pattern:    /^[0-9]{1,2}$/,
        patternMsg: 'must be a 1-2 digit integer string',
    },
};

module.exports = { validate, TASK_SCHEMA, TASK_CLEAR_SCHEMA, SCRAPE_SCHEMA };

export {};
