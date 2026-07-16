import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'New Tenant' };

async function createTenantAction(formData: FormData): Promise<void> {
  'use server';
  const name = (formData.get('name') as string | null)?.trim() ?? '';
  const slug = (formData.get('slug') as string | null)?.trim() ?? '';
  if (!name || !slug) redirect('/platform/tenants/new?error=required');

  const token = await getSessionToken();
  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  const res = await fetch(`${IDENTITY_URL}/api/v1/platform/tenants`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ name, slug }),
  });

  if (!res.ok) {
    const { error } = await res.json() as { error: string };
    redirect(`/platform/tenants/new?error=${encodeURIComponent(error)}`);
  }

  const { tenant } = await res.json() as { tenant: { id: string } };
  redirect(`/platform/tenants/${tenant.id}`);
}

export default async function NewTenantPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <>
      <PageHeader title="New Tenant" subtitle="Create a tenant organisation" />

      {error && (
        <p role="alert" style={{ color: '#c00' }}>
          {error === 'required' ? 'Name and slug are required.' : `Error: ${error}`}
        </p>
      )}

      <form action={createTenantAction} style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <label>
          <span style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>Display name *</span>
          <input name="name" type="text" required minLength={2} maxLength={100}
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }} />
        </label>

        <label>
          <span style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>
            Slug * <small style={{ color: '#888' }}>(lowercase, alphanumeric, hyphens)</small>
          </span>
          <input name="slug" type="text" required minLength={2} maxLength={50}
            pattern="[a-z0-9-]+"
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }} />
        </label>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button type="submit" style={{
            padding: '0.5rem 1.25rem', background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer',
          }}>Create</button>
          <a href="/platform/tenants" style={{ padding: '0.5rem', color: '#555' }}>Cancel</a>
        </div>
      </form>
    </>
  );
}
