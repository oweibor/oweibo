/**
 * Curriculum Learning — Proactive Dependency Changelog Scraper.
 *
 * Runs on CURRICULUM_CRON schedule (default: Monday 06:00).
 * For each dependency in the latest known_good deps_manifest.json:
 *   1. Fetches the package's recent GitHub releases via the GitHub API.
 *   2. Filters to releases newer than the manifest's timestamp.
 *   3. Embeds the release notes and upserts them into the Qdrant
 *      project_context collection so the Architect stage can retrieve
 *      breaking-change context before writing code against those packages.
 *
 * Skips packages that are not hosted on GitHub (no "github.com" in the
 * resolved URL, or no matching repo found via the npm registry lookup).
 *
 * Rate limiting: processes at most CURRICULUM_MAX_PKGS packages per run
 * to avoid hammering GitHub from low-power nodes.
 *
 * @module services/curriculum/deps
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const config = require('../../config');
const qdrant = require('../qdrant');
const embeddings = require('../embeddings');

const KNOWN_GOOD_BASE = '/var/kilo/known_good';
const GITHUB_API = 'https://api.github.com';

/**
 * Find the most recently modified known_good snapshot directory.
 * Returns null if none exist.
 *
 * @returnsAbsolute path to snapshot dir, or null
 */
function findLatestSnapshot() {
    if (!fs.existsSync(KNOWN_GOOD_BASE)) return null;

    const dirs = fs.readdirSync(KNOWN_GOOD_BASE)
        .map((d) => path.join(KNOWN_GOOD_BASE, d))
        .filter((d) => fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'deps_manifest.json')));

    if (dirs.length === 0) return null;

    return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

/**
 * Attempt to resolve a GitHub owner/repo for an npm package name.
 * Uses the npm registry's `repository` field.
 *
 * @parampkgName
 * @returns"owner/repo" or null
 */
async function resolveGitHubRepo(pkgName) {
    try {
        const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'kilo-pipeline-curriculum/1.0' },
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return null;

        const data = ((await res.json()) as any);
        const repoUrl = data.repository?.url || '';

        // Match "github.com/owner/repo" or "github:owner/repo"
        const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i)
            || repoUrl.match(/^github:([^/]+\/[^/.]+?)(?:\.git)?$/i);

        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Fetch recent GitHub releases newer than sinceDate.
 *
 * @paramownerRepo - "owner/repo"
 * @paramsinceDate
 * @returns
 */
async function fetchNewReleases(ownerRepo, sinceDate) {
    try {
        const headers = { 'User-Agent': 'kilo-pipeline-curriculum/1.0', 'Accept': 'application/vnd.github.v3+json' };
        if (process.env.GITHUB_TOKEN) {
            headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
        }

        const url = `${GITHUB_API}/repos/${ownerRepo}/releases?per_page=5`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });

        if (!res.ok) return [];

        const releases = ((await res.json()) as any);
        if (!Array.isArray(releases)) return [];

        return releases
            .filter((r) => r.published_at && new Date(r.published_at) > sinceDate && r.body)
            .map((r) => ({ tag: r.tag_name, body: r.body, published_at: r.published_at }));
    } catch {
        return [];
    }
}

/**
 * Upsert a release note into Qdrant project_context.
 *
 * @parampkgName
 * @paramownerRepo
 * @paramrelease
 */
async function indexRelease(pkgName, ownerRepo, release) {
    const text = `Package: ${pkgName} (${ownerRepo})\nVersion: ${release.tag}\n\n${release.body}`;
    const vector = await embeddings.embed(text);
    const id = uuidv4();

    await qdrant.upsert('project_context', [{
        id,
        vector,
        payload: {
            type: 'dep_changelog',
            package: pkgName,
            repo: ownerRepo,
            version: release.tag,
            published_at: release.published_at,
            content: text,
            indexed_at: new Date().toISOString(),
        },
    }]);

    logger.info('Curriculum: indexed release notes', { package: pkgName, version: release.tag });
}

/**
 * Main entry point for the curriculum cron.
 * Reads the latest deps_manifest.json and scrapes changelogs for new releases.
 *
 * @returns
 */
async function run() {
    logger.info('Curriculum learning run started');

    const snapshotDir = findLatestSnapshot();
    if (!snapshotDir) {
        logger.info('Curriculum: no known_good snapshot found, skipping');
        return { packages_checked: 0, releases_indexed: 0 };
    }

    const manifestPath = path.join(snapshotDir, 'deps_manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
        logger.error('Curriculum: failed to read deps_manifest.json', { error: err.message });
        return { packages_checked: 0, releases_indexed: 0 };
    }

    const sinceDate = manifest.timestamp ? new Date(manifest.timestamp) : new Date(0);
    const allDeps = {
        ...(manifest.dependencies || {}),
        ...(manifest.devDependencies || {}),
    };

    const pkgNames = Object.keys(allDeps);
    const maxPkgs = config.CURRICULUM_MAX_PKGS;
    const subset = pkgNames.slice(0, maxPkgs);

    logger.info('Curriculum: checking packages', { total: pkgNames.length, checking: subset.length, since: sinceDate.toISOString() });

    let packagesChecked = 0;
    let releasesIndexed = 0;

    for (const pkgName of subset) {
        packagesChecked++;

        const ownerRepo = await resolveGitHubRepo(pkgName);
        if (!ownerRepo) {
            logger.debug('Curriculum: no GitHub repo found', { package: pkgName });
            continue;
        }

        const newReleases = await fetchNewReleases(ownerRepo, sinceDate);
        if (newReleases.length === 0) {
            logger.debug('Curriculum: no new releases', { package: pkgName });
            continue;
        }

        for (const release of newReleases) {
            try {
                await indexRelease(pkgName, ownerRepo, release);
                releasesIndexed++;
            } catch (err) {
                logger.error('Curriculum: failed to index release', { package: pkgName, version: release.tag, error: err.message });
            }
        }
    }

    logger.info('Curriculum learning run complete', { packages_checked: packagesChecked, releases_indexed: releasesIndexed });
    return { packages_checked: packagesChecked, releases_indexed: releasesIndexed };
}

module.exports = { run };

export {};
