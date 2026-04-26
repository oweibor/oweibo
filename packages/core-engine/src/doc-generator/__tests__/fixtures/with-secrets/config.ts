/**
 * FIXTURE FILE — contains intentionally fake secrets for DocValidator testing.
 * None of these values are real credentials. They are test data only.
 */

// Fake Stripe key — matches sk_live_ pattern (underscores in body break real-key validation)
const FAKE_STRIPE_KEY = 'sk_live_FAKE_KEY_FIXTURE_TEST_ONLY_00';

// Fake GitHub PAT — matches ghp_ pattern
const FAKE_GH_PAT = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789';

// Fake AWS access key — matches AKIA pattern
const FAKE_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

// Fake PEM block
const FAKE_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtEsHAQYA==
-----END RSA PRIVATE KEY-----`;

// Regular config — should not be flagged
export const config = {
  apiVersion: 'v1',
  timeout: 30_000,
  retries: 3,
};

// Intentionally exported to appear in symbol extraction
export function getConfig() {
  return config;
}
