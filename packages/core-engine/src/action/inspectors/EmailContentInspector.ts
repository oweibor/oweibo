/**
 * S.5.a: EmailContentInspector — flags suspicious outbound email.
 *
 * Heuristics (no external DLP dep — that would couple us to a vendor):
 *
 *   * Recipient on an external domain when the thread is tagged
 *     `internal=true` → upgrade_to_approval
 *   * Attachment count > 10 OR total attachment size > 25 MB → forbid
 *   * Body contains a regex match for "AKIA[0-9A-Z]{16}" (AWS access
 *     key id) or similar high-confidence secret markers → forbid
 *   * Recipient list size > 50 → upgrade_to_approval (likely a blast)
 *
 * Payload shape expected:
 *   {
 *     to: string[], cc?: string[], bcc?: string[],
 *     subject: string, body: string,
 *     attachments?: Array<{ name: string; sizeBytes: number }>,
 *     threadTags?: string[],
 *     senderDomain?: string,
 *   }
 */
import type {
  ActionContext,
  ContentInspectionResult,
  IContentInspector,
} from '@oweibo/core-contracts';

interface EmailPayload {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  body?: string;
  attachments?: Array<{ name: string; sizeBytes: number }>;
  threadTags?: string[];
  senderDomain?: string;
}

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_RECIPIENTS = 50;

const HIGH_CONFIDENCE_SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'aws_access_key_id',     re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws_secret_access_key', re: /\b[a-zA-Z0-9/+=]{40}\b/ },
  { name: 'github_pat',            re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'slack_token',           re: /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'openai_key',            re: /\bsk-[A-Za-z0-9]{32,}\b/ },
];

export class EmailContentInspector implements IContentInspector {
  readonly name = 'email_content';

  appliesTo(actionClass: string): boolean {
    return actionClass === 'comm.external_email';
  }

  async inspect(ctx: ActionContext): Promise<ContentInspectionResult> {
    const p = (ctx.payload ?? {}) as EmailPayload;
    const recipients = [...(p.to ?? []), ...(p.cc ?? []), ...(p.bcc ?? [])];

    // Recipient blast.
    if (recipients.length > MAX_RECIPIENTS) {
      return {
        verdict: 'upgrade_to_approval',
        reason: `${recipients.length} recipients exceeds blast threshold of ${MAX_RECIPIENTS}`,
        details: { matched: 'RECIPIENT_BLAST', count: recipients.length },
      };
    }

    // Attachment caps.
    const attachments = p.attachments ?? [];
    if (attachments.length > MAX_ATTACHMENTS) {
      return {
        verdict: 'forbid',
        reason: `${attachments.length} attachments exceeds max of ${MAX_ATTACHMENTS}`,
        details: { matched: 'TOO_MANY_ATTACHMENTS', count: attachments.length },
      };
    }
    const totalBytes = attachments.reduce((acc, a) => acc + (a.sizeBytes ?? 0), 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      return {
        verdict: 'forbid',
        reason: `attachment total ${Math.round(totalBytes / 1_048_576)} MB exceeds 25 MB cap`,
        details: { matched: 'ATTACHMENT_BYTES', bytes: totalBytes },
      };
    }

    // Secret leak in body.
    const body = p.body ?? '';
    for (const pat of HIGH_CONFIDENCE_SECRET_PATTERNS) {
      if (pat.re.test(body)) {
        return {
          verdict: 'forbid',
          reason: `body contains likely ${pat.name}`,
          details: { matched: 'SECRET_LEAK', kind: pat.name },
        };
      }
    }

    // External recipient on internal-tagged thread.
    if (p.threadTags?.includes('internal') && p.senderDomain) {
      const externals = recipients.filter((r) => !endsWithDomain(r, p.senderDomain!));
      if (externals.length > 0) {
        return {
          verdict: 'upgrade_to_approval',
          reason: `internal-tagged thread has ${externals.length} external recipient(s)`,
          details: { matched: 'EXTERNAL_ON_INTERNAL_THREAD', externals },
        };
      }
    }

    return { verdict: 'allow' };
  }
}

function endsWithDomain(addr: string, domain: string): boolean {
  const at = addr.lastIndexOf('@');
  if (at < 0) return false;
  return addr.slice(at + 1).toLowerCase() === domain.toLowerCase();
}
