/**
 * BetterAuth instance — manages user sessions and organizations.
 *
 * The multiOrganization plugin provides the tenant-as-organization model.
 * betterauth.* tables are managed exclusively by this library; oweibo.*
 * tables are kept in sync via the Postgres trigger in migrations/001.
 */
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { multiOrganization } from 'better-auth/plugins';
import { prisma } from '@oweibo/db';
import { config } from '../config.js';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_BASE_URL,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
  },

  session: {
    expiresIn:  config.REFRESH_TOKEN_TTL,
    updateAge:  3600, // re-issue cookie after 1 h of activity
  },

  plugins: [
    multiOrganization(),
  ],

  trustedOrigins: (process.env['TRUSTED_ORIGINS'] ?? 'http://localhost:3000').split(','),
});

export type Session = typeof auth.$Infer.Session;
export type User    = typeof auth.$Infer.Session.user;
