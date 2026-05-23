-- T.6: tenant templates — industry/role profiles selectable at create time.
--
-- Cross-tenant catalog. Read by any tenant member through the read_any
-- policy; writes restricted to platform_admin. Existing tenants are not
-- affected — only new tenant_bootstrap rows reference a templateSlug.
--
-- Seeds the 'default' template so existing tenants continue to resolve
-- their bootstrap state cleanly. Other templates are added by platform
-- admins via the admin UI / SQL.

CREATE TABLE IF NOT EXISTS oweibo.tenant_templates (
  slug              TEXT         PRIMARY KEY,
  display_name      TEXT         NOT NULL,
  description       TEXT         NOT NULL,
  industries        TEXT[]       NOT NULL DEFAULT '{}',
  default_features  JSONB        NOT NULL DEFAULT '{}',
  default_quotas    JSONB        NOT NULL DEFAULT '{}',
  seed_memory_tags  TEXT[]       NOT NULL DEFAULT '{}',
  seed_skill_set    TEXT         NOT NULL DEFAULT 'platform-default',
  goal_template_set TEXT         NOT NULL DEFAULT 'platform-default',
  active            BOOLEAN      NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE oweibo.tenant_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE oweibo.tenant_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS read_any ON oweibo.tenant_templates;
CREATE POLICY read_any ON oweibo.tenant_templates FOR SELECT USING (true);

GRANT SELECT ON oweibo.tenant_templates TO oweibo_app;

-- Seed the default template so legacy tenants always resolve.
INSERT INTO oweibo.tenant_templates (slug, display_name, description)
VALUES ('default', 'Default', 'Generic starter — no industry specialization')
ON CONFLICT (slug) DO NOTHING;

-- Seed a few representative templates so the admin UI dropdown is non-empty
-- on fresh installs. Platform admins add/edit/remove these via raw SQL or
-- a future admin form.
INSERT INTO oweibo.tenant_templates (slug, display_name, description, industries, seed_memory_tags) VALUES
  ('fintech-smb',  'Fintech SMB',  'Small-to-mid financial-services teams; compliance-leaning defaults.', ARRAY['finance'], ARRAY['scope:starter','topic:reliability','topic:datastore']),
  ('ml-research',  'ML Research',  'Research labs and ML teams; experiment-heavy workflows.',           ARRAY['ml-research'], ARRAY['scope:starter','topic:testing','topic:debugging']),
  ('nextjs-saas',  'Next.js SaaS', 'Next.js-powered SaaS apps; web-first defaults.',                    ARRAY[]::TEXT[], ARRAY['scope:starter','language:typescript']),
  ('cli-tool',     'CLI Tool',     'Command-line tool authors and library teams.',                      ARRAY[]::TEXT[], ARRAY['scope:starter','language:typescript'])
ON CONFLICT (slug) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_tenant_templates_active
  ON oweibo.tenant_templates (active) WHERE active = true;

DO $$
BEGIN
  RAISE NOTICE 'T.6 tenant_templates installed (default + 4 starter slugs).';
END;
$$;
