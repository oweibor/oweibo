'use client';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

interface Tenant {
  tenantId: string;
  name:     string;
}

interface TenantSwitcherProps {
  currentTenantId: string | null;
  tenants:         Tenant[];
}

export function TenantSwitcher({ currentTenantId, tenants }: TenantSwitcherProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function handleChange(evt: React.ChangeEvent<HTMLSelectElement>) {
    const tenantId = evt.target.value;
    if (!tenantId || tenantId === currentTenantId) return;

    const res = await fetch('/api/switch-tenant', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tenantId }),
    });

    if (res.ok) {
      startTransition(() => {
        router.push(`/t/${tenantId}`);
        router.refresh();
      });
    } else {
      console.error('Tenant switch failed', await res.json());
    }
  }

  if (tenants.length <= 1) return null;

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: 13 }}>
      <span>Tenant:</span>
      <select
        value={currentTenantId ?? ''}
        onChange={handleChange}
        disabled={isPending}
        style={{ padding: '0.25rem 0.5rem' }}
      >
        {tenants.map(t => (
          <option key={t.tenantId} value={t.tenantId}>{t.name}</option>
        ))}
      </select>
    </label>
  );
}
