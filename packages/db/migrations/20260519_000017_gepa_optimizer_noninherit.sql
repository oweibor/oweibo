-- Migration: Make the gepa_optimizer → oweibo_app grant non-inheriting.
--
-- The Phase prompt-privilege lockdown (20260519_000014) issued:
--   REVOKE INSERT, UPDATE ON oweibo.prompt_versions FROM oweibo_app;
--   GRANT  gepa_optimizer TO oweibo_app;
--
-- That GRANT used PostgreSQL's default INHERIT semantics, so oweibo_app
-- automatically inherited gepa_optimizer's INSERT/UPDATE on prompt_versions
-- — silently re-granting the very privilege the REVOKE just removed.
-- The structural barrier the migration intended (writes require an explicit
-- SET LOCAL ROLE gepa_optimizer) was reduced to a stylistic preference:
-- any oweibo_app session could INSERT into prompt_versions directly.
--
-- Fix: re-issue the membership WITH INHERIT FALSE, SET TRUE — same pattern
-- the platform_admin lockdown used. Member can still SET ROLE to escalate,
-- but does not auto-inherit privileges. The REVOKE actually bites now.
--
-- Requires: 20260519_000014_prompt_privilege_lockdown.sql.

REVOKE gepa_optimizer FROM oweibo_app;
GRANT  gepa_optimizer TO   oweibo_app WITH INHERIT FALSE, SET TRUE;

DO $$
BEGIN
  RAISE NOTICE 'gepa_optimizer → oweibo_app grant tightened to non-inheriting. prompt_versions writes now require explicit SET LOCAL ROLE gepa_optimizer.';
END;
$$;
