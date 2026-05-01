import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';

export default async function RootPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  // Platform admins land on tenant management; tenant users land on their dashboard
  if (user.scopes.includes('platform:tenants:read')) redirect('/platform/tenants');
  if (user.tenant_id) redirect(`/t/${user.tenant_id}`);
  redirect('/unauthorized');
}
