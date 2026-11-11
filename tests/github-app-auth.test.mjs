import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { identity, permissions, readToken, commandEnvironment } from '/usr/local/lib/github-app/token-file.mjs';
import { createAssertion, githubRequest, issueToken, loadPrivateKey, publishToken, retryDelay,
    runIssuer } from '/usr/local/lib/github-app/token-issuer.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** Build a synthetic one-hour credential; production values never enter this suite. */
function tokenDocument(generation = 'SYNTHETIC_A', now = Date.now()) {
    return { ...identity, token: `ghs_${generation}`, expires_at: new Date(now + 3600000).toISOString(), permissions };
}

/** Supply deterministic protected scratch storage and always remove synthetic secrets. */
async function withDirectory(action) {
    const directory = await mkdtemp(join(tmpdir(), 'github-app-unit-'));
    await chmod(directory, 0o700);
    try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Model the exact App/installation/token API exchange and permit negative fixtures. */
function fakeApi(overrides = {}, calls = []) {
    return async (path, credential, body) => {
        calls.push({ path, body });
        if (path === '/app') return { id: identity.app_id, slug: 'the9ball-git-agent', ...overrides.app };
        if (path.endsWith('/installation')) return { id: identity.installation_id, app_id: identity.app_id,
            account: { login: 'the9ball' }, suspended_at: null, repository_selection: 'selected',
            permissions, ...overrides.installation };
        if (path.endsWith('/access_tokens')) return { ...tokenDocument(),
            repositories: [{ full_name: identity.repository }], ...overrides.token };
        if (path === '/installation/repositories') return { total_count: 1,
            repositories: [{ full_name: identity.repository }], ...overrides.repositories };
        throw new Error('Unexpected API request');
    };
}

/** Verify assertion signature and GitHub's bounded clock-skew claims. */
test('JWT is RS256, scoped to the App and bounded to ten minutes including skew', () => {
    const now = Date.now();
    const parts = createAssertion(privateKey, now).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    assert.equal(claims.iss, String(identity.app_id));
    assert.equal(claims.iat, Math.floor(now / 1000) - 60);
    assert.equal(claims.exp - claims.iat, 600);
    assert.ok(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url')));
});

/** Prove requested and returned repository/permission bounds are independently checked. */
test('issuance validates App, installation, returned scope and effective repository access', async () => {
    const calls = [];
    const document = await issueToken(privateKey, fakeApi({}, calls));
    assert.equal(document.repository, identity.repository);
    assert.deepEqual(calls[2].body, { repositories: ['DesktopCommanderContainer'], permissions });
    for (const overrides of [
        { app: { id: 1 } }, { app: { slug: 'other' } },
        { installation: { id: 1 } }, { installation: { account: { login: 'other' } } },
        { installation: { app_id: 1 } }, { installation: { suspended_at: '2026-01-01' } },
        { installation: { repository_selection: 'all' } },
        { installation: { permissions: { ...permissions, workflows: 'write' } } },
        { token: { repositories: [{ full_name: 'other/repository' }] } },
        { token: { repositories: [{ full_name: identity.repository }, { full_name: 'other/repository' }] } },
        { token: { permissions: { ...permissions, contents: 'read' } } },
        { token: { expires_at: new Date(0).toISOString() } },
        { token: { expires_at: new Date(Date.now() + 7200000).toISOString() } },
        { token: { token: 'unsupported-format' } },
        { repositories: { total_count: 2 } },
    ]) await assert.rejects(issueToken(privateKey, fakeApi(overrides)));
});

/** Exercise secret parsing, symlink and permission failures without leaking parser contents. */
test('protected key loader refuses unsafe permissions and symlinks', async () => {
    await withDirectory(async (directory) => {
        const file = join(directory, 'app.pem');
        await writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
        assert.equal((await loadPrivateKey(file)).asymmetricKeyType, 'rsa');
        await chmod(file, 0o644);
        await assert.rejects(loadPrivateKey(file), /Private key unavailable/);
        await chmod(file, 0o600);
        await symlink(file, join(directory, 'link.pem'));
        await assert.rejects(loadPrivateKey(join(directory, 'link.pem')), /Private key unavailable/);
        await writeFile(file, 'SYNTHETIC_PRIVATE_PARSE_CANARY');
        await assert.rejects(loadPrivateKey(file), { message: 'Private key unavailable' });
    });
});

/** Concurrent readers must see complete generations and reject all expired/unsafe records. */
test('atomic rotation preserves coherent scope, owner, mode and bounded expiry', async () => {
    await withDirectory(async (directory) => {
        const file = join(directory, 'token.json');
        await publishToken(tokenDocument(), directory);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        const readers = [];
        for (let generation = 0; generation < 30; generation++) {
            readers.push(publishToken(tokenDocument(`SYNTHETIC_${generation}`), directory));
            assert.equal(readToken(file).repository, identity.repository);
        }
        await Promise.all(readers);
        assert.match(readToken(file).token, /^ghs_SYNTHETIC_/);
        for (const invalid of [
            { repository: 'other/repository' }, { app_id: 1 }, { installation_id: 1 },
            { token: 'legacy-pat' }, { permissions: { contents: 'read' } },
            { expires_at: new Date(Date.now() + 30000).toISOString() },
            { expires_at: 'malformed' },
        ]) {
            await publishToken({ ...tokenDocument(), ...invalid }, directory);
            assert.throws(() => readToken(file), { message: 'GitHub App credential unavailable' });
        }
        await publishToken(tokenDocument(), directory);
        await chmod(file, 0o644);
        assert.throws(() => readToken(file));
        await chmod(file, 0o600);
        await symlink(file, join(directory, 'link.json'));
        assert.throws(() => readToken(join(directory, 'link.json')));
        await writeFile(file, '{SYNTHETIC_PARSE_CANARY');
        assert.throws(() => readToken(file), { message: 'GitHub App credential unavailable' });
    });
});

/** Bound retries and suppress API bodies/headers and raw transport error text. */
test('HTTP failures are bounded and contain no response or transport canaries', async () => {
    let captured;
    const success = await githubRequest('/app', 'SYNTHETIC_ASSERTION', undefined, async (url, options) => {
        captured = { url, options };
        return new Response('{"id":5706210}');
    });
    assert.equal(success.id, identity.app_id);
    assert.equal(captured.url, 'https://api.github.com/app');
    assert.equal(captured.options.redirect, 'error');
    assert.ok(captured.options.signal);
    await assert.rejects(githubRequest('/app', 'SYNTHETIC_ASSERTION', undefined, async () =>
        new Response('SYNTHETIC_RESPONSE_CANARY', { status: 429, headers: { 'Retry-After': '99999' } })),
    (failure) => failure.message === 'GitHub request failed' && failure.retryAfter === 300000);
    await assert.rejects(githubRequest('/app', 'SYNTHETIC_ASSERTION', undefined, async () => {
        throw new Error('SYNTHETIC_NETWORK_CANARY');
    }), { message: 'GitHub request failed' });
    assert.equal(retryDelay(0, 0, 0), 1600);
    assert.equal(retryDelay(30, 0, 1), 60000);
    assert.equal(retryDelay(1, 120000), 120000);
});

/** Simulate failure, expiry and recovery across a wall-clock jump without real-time sleeps. */
test('issuer retries without losing last generation and resumes after network recovery', async () => {
    let now = Date.now();
    let document = tokenDocument('SYNTHETIC_OLD', now - 3300000);
    let attempts = 0;
    let sleeps = 0;
    const events = [];
    const controller = new AbortController();
    const previousInfo = console.info;
    const previousError = console.error;
    console.info = console.error = (message) => events.push(message);
    try {
        await runIssuer({ signal: controller.signal, now: () => now, load: async () => privateKey,
            read: () => { if (Date.parse(document.expires_at) < now) throw new Error(); return document; },
            issue: async () => {
                attempts++;
                if (attempts < 3) throw new Error('SYNTHETIC_FAILURE_CANARY');
                return tokenDocument('SYNTHETIC_RECOVERED', now);
            }, publish: async (updated) => { document = updated; },
            sleep: async () => {
                sleeps++;
                now += 120000;
                if (sleeps === 4) controller.abort();
            },
        });
    } finally { console.info = previousInfo; console.error = previousError; }
    assert.equal(attempts, 3);
    assert.equal(document.token, 'ghs_SYNTHETIC_RECOVERED');
    assert.deepEqual(events, ['github-app refresh-failed', 'github-app refresh-failed', 'github-app token-published']);
    attempts = 0;
    const restarted = new AbortController();
    await runIssuer({ signal: restarted.signal, read: () => document, now: () => now,
        issue: async () => { attempts++; }, sleep: async () => restarted.abort() });
    assert.equal(attempts, 0);
});

/** Inherited token/debug/helper overrides must not reach authentication subprocesses. */
test('command environment removes stale credentials and tracing overrides', () => {
    const environment = commandEnvironment({ GH_TOKEN: 'SYNTHETIC_PAT', GITHUB_TOKEN: 'SYNTHETIC_PAT',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_ASKPASS: 'bad',
        GIT_TRACE_CURL: '1', GH_DEBUG: 'api', HOME: '/root', PATH: '/usr/bin' });
    assert.deepEqual(environment, { HOME: '/root', PATH: '/usr/bin' });
});
