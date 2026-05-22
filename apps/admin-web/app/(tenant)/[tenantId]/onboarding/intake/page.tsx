import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { identityApi } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';

export const metadata: Metadata = { title: 'Domain intake' };

interface IntakeResponse {
  state: 'absent' | 'pending' | 'requested' | 'processing' | 'complete' | 'skipped' | 'failed';
  classifiedDomain?: string | null;
  classifiedConfidence?: string | number | null;
  recommendedTemplateSlug?: string | null;
  recommendedConnectors?: string[];
  recommendedSeedSkills?: string[];
  interviewAnswers?: Array<{ question: string; answer: string }> | null;
  completedAt?: string | null;
}

const QUESTIONS: { id: string; question: string }[] = [
  { id: 'industry',     question: 'What industry do you operate in?' },
  { id: 'task_types',   question: 'What are your three most common task types?' },
  { id: 'systems',      question: 'What systems do you most need the platform to act on?' },
  { id: 'compliance',   question: 'Are there any compliance regimes you must satisfy? (SOC2, HIPAA, PCI, GDPR, etc.)' },
  { id: 'risk_profile', question: "What's your risk tolerance for autonomous actions on production data?" },
];

async function submitIntake(formData: FormData): Promise<void> {
  'use server';
  const tenantId = formData.get('tenantId') as string;
  const answers = QUESTIONS
    .map((q) => ({ question: q.question, answer: ((formData.get(`a_${q.id}`) as string) ?? '').trim() }))
    .filter((qa) => qa.answer.length > 0);

  const token = await getSessionToken();
  const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:3110';
  await fetch(`${IDENTITY_URL}/api/v1/tenants/${tenantId}/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ interviewAnswers: answers }),
  });
  redirect(`/t/${tenantId}/onboarding/intake?submitted=1`);
}

export default async function IntakePage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ submitted?: string }>;
}) {
  const { tenantId } = await params;
  const { submitted } = await searchParams;

  let intake: IntakeResponse | null = null;
  let fetchError: string | null = null;
  try {
    intake = await identityApi.get<IntakeResponse>(`/api/v1/tenants/${tenantId}/intake`);
  } catch (err: any) {
    fetchError = err.message;
  }

  const existingAnswers = new Map<string, string>();
  for (const qa of intake?.interviewAnswers ?? []) {
    existingAnswers.set(qa.question, qa.answer);
  }

  return (
    <>
      <PageHeader title="Domain intake" subtitle="Tell us about your domain so the platform can tailor itself." />
      {fetchError && <p style={{ color: '#c00' }}>Failed to load: {fetchError}</p>}
      {submitted && (
        <p style={{ color: '#1e3a8a', background: '#dbeafe', padding: '0.5rem 1rem', borderRadius: 4, fontSize: 13 }}>
          Intake submitted. The system will process it shortly. Refresh to see recommendations.
        </p>
      )}
      {intake?.state === 'complete' && (
        <p style={{ color: '#065f46', background: '#d1fae5', padding: '0.5rem 1rem', borderRadius: 4, fontSize: 13 }}>
          Intake complete{intake.classifiedDomain ? ` — classified as ${intake.classifiedDomain}` : ''}.
        </p>
      )}
      {intake?.state === 'failed' && (
        <p style={{ color: '#991b1b', background: '#fee2e2', padding: '0.5rem 1rem', borderRadius: 4, fontSize: 13 }}>
          Last intake attempt failed. Re-submitting will retry.
        </p>
      )}

      <form action={submitIntake} style={{ marginTop: '1rem', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <input type="hidden" name="tenantId" value={tenantId} />

        {QUESTIONS.map((q) => (
          <label key={q.id}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{q.question}</span>
            <textarea
              name={`a_${q.id}`}
              defaultValue={existingAnswers.get(q.question) ?? ''}
              rows={2}
              style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: 13, border: '1px solid #ddd', borderRadius: 4 }}
            />
          </label>
        ))}

        <button type="submit" style={{
          padding: '0.5rem 1.25rem', background: '#1a1a1a', color: '#fff', border: 'none',
          cursor: 'pointer', alignSelf: 'flex-start', fontSize: 13,
        }}>Submit intake</button>
      </form>

      {intake?.recommendedConnectors && intake.recommendedConnectors.length > 0 && (
        <div style={{ marginTop: '2rem', borderTop: '1px solid #eee', paddingTop: '1rem' }}>
          <h3 style={{ fontSize: 14, marginBottom: '0.5rem' }}>Recommendations</h3>
          {intake.recommendedTemplateSlug && (
            <p style={{ fontSize: 13, color: '#333' }}>
              Template: <code>{intake.recommendedTemplateSlug}</code>
            </p>
          )}
          <p style={{ fontSize: 13, color: '#333' }}>
            Connectors:{' '}
            {intake.recommendedConnectors.map((c) => (
              <code key={c} style={{ marginRight: '0.5rem' }}>{c}</code>
            ))}
          </p>
        </div>
      )}
    </>
  );
}
