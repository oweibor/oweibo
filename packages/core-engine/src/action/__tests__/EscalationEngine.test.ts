/**
 * S.1 — EscalationEngine tests.
 */
import {
  EscalationEngine,
  type IOrgGraphReader,
  type ITenantRoleReader,
} from '../EscalationEngine.js';
import { platformDefaultPolicy } from '../ApprovalSlaService.js';
import type { ApprovalSlaPolicy } from '@oweibo/core-contracts';

const TENANT = '11111111-1111-1111-1111-111111111111';

function makeOrg(stage0: { nodes: string[]; users: string[]; fromGraph: boolean },
                 reports: Record<string, { nodes: string[]; users: string[] }> = {}): IOrgGraphReader {
  return {
    async resolveApprovers() { return stage0; },
    async reportsTo(_tenantId, nodeIds) {
      // Concatenate the reports-to for every prior node.
      const nodes: string[] = [];
      const users: string[] = [];
      for (const id of nodeIds) {
        const next = reports[id];
        if (next) {
          nodes.push(...next.nodes);
          users.push(...next.users);
        }
      }
      return { nodes: Array.from(new Set(nodes)), users: Array.from(new Set(users)) };
    },
  };
}

function makeRoles(byRoleSet: ReadonlyArray<{ roles: string[]; users: string[] }>): ITenantRoleReader {
  return {
    async usersWithRoles(_tenantId, roles) {
      for (const e of byRoleSet) {
        if (e.roles.some((r) => roles.includes(r))) return e.users;
      }
      return [];
    },
  };
}

describe('EscalationEngine.resolveStage', () => {
  it('stage 0 returns the org-graph approvers when fromGraph is true', async () => {
    const engine = new EscalationEngine({
      org: makeOrg({ nodes: ['n1', 'n2'], users: ['u1', 'u2'], fromGraph: true }),
      roles: makeRoles([]),
    });
    const policy = platformDefaultPolicy(TENANT, 'financial.payment');
    const r = await engine.resolveStage({
      tenantId: TENANT, actionClass: 'financial.payment', policy,
      stage: 0, priorOrgNodeIds: [], priorUserIds: [],
    });
    expect(r.approverUserIds).toEqual(['u1', 'u2']);
    expect(r.orgNodeIds).toEqual(['n1', 'n2']);
    expect(r.chainExhausted).toBe(false);
  });

  it('stage 0 falls back to tenant_admin role when org graph is empty', async () => {
    const engine = new EscalationEngine({
      org: makeOrg({ nodes: [], users: [], fromGraph: false }),
      roles: makeRoles([{ roles: ['tenant_admin'], users: ['admin1'] }]),
    });
    const policy = platformDefaultPolicy(TENANT, 'financial.payment');
    const r = await engine.resolveStage({
      tenantId: TENANT, actionClass: 'financial.payment', policy,
      stage: 0, priorOrgNodeIds: [], priorUserIds: [],
    });
    expect(r.approverUserIds).toEqual(['admin1']);
    expect(r.chainExhausted).toBe(true);
  });

  it('stage 1 walks reports_to from prior nodes', async () => {
    const engine = new EscalationEngine({
      org: makeOrg(
        { nodes: ['mgr'], users: ['u1'], fromGraph: true },
        { mgr: { nodes: ['vp'], users: ['u_vp'] } },
      ),
      roles: makeRoles([]),
    });
    const policy = platformDefaultPolicy(TENANT, 'financial.payment');
    const r = await engine.resolveStage({
      tenantId: TENANT, actionClass: 'financial.payment', policy,
      stage: 1, priorOrgNodeIds: ['mgr'], priorUserIds: ['u1'],
    });
    expect(new Set(r.approverUserIds)).toEqual(new Set(['u1', 'u_vp']));
    expect(r.orgNodeIds).toEqual(['vp']);
    expect(r.chainExhausted).toBe(false);
  });

  it('stage N marks chain exhausted when no reports_to edges remain', async () => {
    const engine = new EscalationEngine({
      org: makeOrg(
        { nodes: ['top'], users: ['ceo'], fromGraph: true },
        {}, // no reports_to from top
      ),
      roles: makeRoles([]),
    });
    const policy = platformDefaultPolicy(TENANT, 'financial.payment');
    const r = await engine.resolveStage({
      tenantId: TENANT, actionClass: 'financial.payment', policy,
      stage: 1, priorOrgNodeIds: ['top'], priorUserIds: ['ceo'],
    });
    expect(r.approverUserIds).toEqual(['ceo']);
    expect(r.chainExhausted).toBe(true);
  });

  it('role_based resolution at stage 0 reads usersWithRoles', async () => {
    const engine = new EscalationEngine({
      org: makeOrg({ nodes: [], users: [], fromGraph: false }),
      roles: makeRoles([
        { roles: ['payment_approver', 'tenant_admin'], users: ['u-pay', 'u-admin'] },
      ]),
    });
    const policy: ApprovalSlaPolicy = {
      ...platformDefaultPolicy(TENANT, 'unclassified'),
      approverResolution: 'role_based',
      approverConfig: { roles: ['payment_approver'] },
    };
    const r = await engine.resolveStage({
      tenantId: TENANT, actionClass: 'unclassified', policy,
      stage: 0, priorOrgNodeIds: [], priorUserIds: [],
    });
    expect(new Set(r.approverUserIds)).toEqual(new Set(['u-pay', 'u-admin']));
    expect(r.chainExhausted).toBe(true);
  });

  it('role_based at stage > 0 just re-fires the same recipient set', async () => {
    const engine = new EscalationEngine({
      org: makeOrg({ nodes: [], users: [], fromGraph: false }),
      roles: makeRoles([]),
    });
    const policy: ApprovalSlaPolicy = {
      ...platformDefaultPolicy(TENANT, 'unclassified'),
      approverResolution: 'role_based',
      approverConfig: { roles: ['tenant_admin'] },
    };
    const r = await engine.resolveStage({
      tenantId: TENANT, actionClass: 'unclassified', policy,
      stage: 2, priorOrgNodeIds: [], priorUserIds: ['admin1'],
    });
    expect(r.approverUserIds).toEqual(['admin1']);
    expect(r.chainExhausted).toBe(true);
  });

  it('explicit_list at stage 0 returns the literal user list, deduplicated', async () => {
    const engine = new EscalationEngine({
      org: makeOrg({ nodes: [], users: [], fromGraph: false }),
      roles: makeRoles([]),
    });
    const policy: ApprovalSlaPolicy = {
      ...platformDefaultPolicy(TENANT, 'unclassified'),
      approverResolution: 'explicit_list',
      approverConfig: { users: ['a', 'b', 'a'] },
    };
    const r = await engine.resolveStage({
      tenantId: TENANT, actionClass: 'unclassified', policy,
      stage: 0, priorOrgNodeIds: [], priorUserIds: [],
    });
    expect(r.approverUserIds).toEqual(['a', 'b']);
  });
});
