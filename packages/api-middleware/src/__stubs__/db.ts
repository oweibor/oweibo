export const appendAudit = async () => undefined;
export const prisma = {} as any;
export const withTenantContext = async (_ctx: any, fn: any) => fn({} as any);

export interface Principal {
  userId: string;
  tenantId: string;
  scopes: string[];
  authMethod: 'jwt' | 'apikey';
  keyId?: string;
}
