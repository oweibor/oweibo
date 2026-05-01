import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { identityApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Settings' };

async function updateSettingsAction(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const trust    = formData.get('trustModeDefault') as string;
  const token    = await getSessionToken();
  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  await fetch(`${IDENTITY_URL}/api/v1/tenants/${tenantId}/settings`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify({ trustModeDefault: trust }),
  });
  redirect(`/t/${tenantId}/settings?saved=1`);
}

export default async function SettingsPage({ params, searchParams }: {
  params:       Promise<{ tenantId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { tenantId } = await params;
  const { saved }    = await searchParams;

  let settings: any = null;
  try {
    const result = await identityApi.get<{ settings: any }>(`/api/v1/tenants/${tenantId}/settings`);
    settings = result.settings;
  } catch { /* show empty form */ }

  return (
    <>
      <PageHeader title="Settings" />
      {saved && <p style={{ color: '#065f46', background: '#d1fae5', padding: '0.5rem 1rem', borderRadius: 4 }}>Settings saved.</p>}

      <form action={updateSettingsAction} style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
        <input type="hidden" name="tenantId" value={tenantId} />

        <label>
          <span style={{ display: 'block', fontSize: 14, marginBottom: 4 }}>Default trust mode</span>
          <select name="trustModeDefault" defaultValue={settings?.trustModeDefault ?? 'supervised'}
            style={{ padding: '0.4rem 0.5rem', width: '100%' }}>
            <option value="supervised">supervised</option>
            <option value="graduated">graduated</option>
            <option value="autonomous">autonomous</option>
          </select>
        </label>

        <button type="submit" style={{
          padding: '0.5rem 1.25rem', background: '#1a1a1a', color: '#fff', border: 'none', cursor: 'pointer', alignSelf: 'flex-start',
        }}>Save</button>
      </form>
    </>
  );
}
