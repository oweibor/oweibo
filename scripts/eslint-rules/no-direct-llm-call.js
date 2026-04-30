'use strict';

/**
 * no-direct-llm-call — blocks direct imports of LLM provider clients outside BaseLLMClient.
 *
 * All LLM calls must flow through BaseLLMClient.generate() which instruments them
 * with OpenTelemetry GenAI semantic convention spans and applies the circuit breaker.
 * Direct imports of OllamaClient, OpenAIClient, AnthropicClient bypass both.
 *
 * Mirrors the no-direct-prisma ESLint rule (packages/db boundary) and the dep-cruiser rule.
 */

const BLOCKED_PROVIDERS = new Set([
  'OllamaClient',
  'OpenAIClient',
  'AnthropicClient',
  'DeepSeekClient',
  'OpenRouterClient',
]);

const ALLOWED_FROM_PATTERN = /services\/llm\/BaseLLMClient/;
const TEST_PATTERN         = /__tests__\//;

module.exports = {
  meta: {
    type:     'problem',
    docs:     { description: 'Disallow direct imports of LLM provider clients outside BaseLLMClient' },
    schema:   [],
    messages: {
      noDirectLlmCall:
        'Direct import of "{{ provider }}" is forbidden outside BaseLLMClient. ' +
        'Use BaseLLMClient.generate() so OTel spans and circuit breaking are applied consistently.',
    },
  },

  create(context) {
    const filename = context.getFilename();
    if (ALLOWED_FROM_PATTERN.test(filename) || TEST_PATTERN.test(filename)) return {};

    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        for (const provider of BLOCKED_PROVIDERS) {
          if (typeof src === 'string' && src.includes(provider)) {
            context.report({
              node,
              messageId: 'noDirectLlmCall',
              data: { provider },
            });
          }
        }
      },

      // CJS require()
      CallExpression(node) {
        if (
          node.callee.type !== 'Identifier' ||
          node.callee.name !== 'require' ||
          node.arguments.length === 0 ||
          node.arguments[0].type !== 'Literal'
        ) return;

        const src = node.arguments[0].value;
        for (const provider of BLOCKED_PROVIDERS) {
          if (typeof src === 'string' && src.includes(provider)) {
            context.report({
              node,
              messageId: 'noDirectLlmCall',
              data: { provider },
            });
          }
        }
      },
    };
  },
};
