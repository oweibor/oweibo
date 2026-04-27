import type { Prisma, PrismaClient } from '@prisma/client';

export type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface TenantContext {
  tenantId: string;
  userId?: string;
}

export interface Principal {
  sub: string;
  kind: 'user' | 'api_key' | 'agent';
  scopes: string[];
  ctx: TenantContext;
  actAs?: { sub: string; tenantId: string };
}

export { Prisma };
