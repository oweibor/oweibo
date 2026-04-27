'use strict';

/**
 * ESLint rule: no-direct-prisma
 *
 * Bans direct `prisma.*` method calls (query, mutate) from any file that is not:
 *   packages/db/src/client.ts          (where the singleton is created)
 *   packages/db/src/withTenantContext.ts (the only legal query path)
 *
 * This enforces the withTenantContext chokepoint: all database access must flow
 * through withTenantContext() so that RLS session params are always set.
 *
 * Mirrors the no-direct-qdrant rule used for Qdrant access.
 *
 * Usage in eslint.config.js:
 *   import noDirect from './scripts/eslint-rules/no-direct-prisma.js';
 *   ...
 *   plugins: { local: { rules: { 'no-direct-prisma': noDirect } } },
 *   rules:   { 'local/no-direct-prisma': 'error' }
 */

/** Files that are legally allowed to import and use prisma directly. */
const ALLOWED_FILES = [
  /packages[/\\]db[/\\]src[/\\]client\.[jt]s$/,
  /packages[/\\]db[/\\]src[/\\]withTenantContext\.[jt]s$/,
  // Test files that import prisma for seeding/assertions
  /__tests__[/\\].*\.[jt]s$/,
];

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct prisma.* access outside packages/db/src/withTenantContext.ts',
      category: 'Security',
      recommended: true,
    },
    schema: [],
    messages: {
      noDirectPrisma:
        'Direct prisma.{{ method }}() call detected. Use withTenantContext() from @oweibo/db instead. ' +
        'Direct access bypasses RLS session parameters and breaks tenant isolation.',
    },
  },

  create(context) {
    const filename = context.getFilename();

    // Allow the chokepoint files
    if (ALLOWED_FILES.some(re => re.test(filename))) {
      return {};
    }

    // Track local variable names that refer to prisma
    const prismaAliases = new Set();

    return {
      // Detect: import { prisma } from '@oweibo/db'
      ImportDeclaration(node) {
        if (
          node.source.value === '@oweibo/db' ||
          node.source.value?.toString().includes('packages/db')
        ) {
          for (const spec of node.specifiers) {
            if (
              spec.type === 'ImportSpecifier' &&
              spec.imported.name === 'prisma'
            ) {
              prismaAliases.add(spec.local.name);
            }
            if (spec.type === 'ImportDefaultSpecifier') {
              // import db from '@oweibo/db' — flag if 'prisma' is a common alias
              prismaAliases.add(spec.local.name);
            }
          }
        }
      },

      // Detect: const { prisma } = require('@oweibo/db')
      VariableDeclarator(node) {
        if (
          node.init?.type === 'CallExpression' &&
          node.init.callee.name === 'require' &&
          node.init.arguments[0]?.value?.toString().includes('@oweibo/db')
        ) {
          if (node.id.type === 'ObjectPattern') {
            for (const prop of node.id.properties) {
              if (prop.key?.name === 'prisma') {
                prismaAliases.add(prop.value?.name ?? 'prisma');
              }
            }
          } else if (node.id.type === 'Identifier') {
            prismaAliases.add(node.id.name);
          }
        }
      },

      // Detect: prisma.user.findMany() etc.
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          prismaAliases.has(node.object.name)
        ) {
          // Allow prisma.$transaction (used inside withTenantContext itself, caught by file allowlist)
          // but flag all model accessors
          const prop = node.property.name;
          if (prop && !prop.startsWith('$') && prop !== 'on') {
            context.report({
              node,
              messageId: 'noDirectPrisma',
              data: { method: prop },
            });
          }
        }
      },
    };
  },
};
