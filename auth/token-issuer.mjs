import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { identity, permissions, readToken, tokenPath, validateSecretFile } from './token-file.mjs';

const keyPath = '/run/github-app-key/app.pem';
const tokenDirectory = '/run/github-app-token';

/** Read a protected PEM without following symlinks or exposing parser diagnostics. */
export async function loadPrivateKey(filePath = keyPath) {
    let handle;
    try {
        const directory = await lstat(dirname(filePath));
        if (!directory.isDirectory() || directory.uid !== 0 || directory.gid !== 0 || (directory.mode & 0o777) !== 0o700) throw new Error();
        handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        validateSecretFile(await handle.stat());
        const privateKey = createPrivateKey(await handle.readFile());
        if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
        return privateKey;
    } catch {
        throw new Error('Private key unavailable');
    } finally {
        await handle?.close();
    }
}

/** Create a short-lived RS256 App assertion; neither assertion nor key leaves this process. */
export function createAssertion(privateKey, now = Date.now()) {
    const issued = Math.floor(now / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iat: issued - 60, exp: issued + 540, iss: String(identity.app_id) })).toString('base64url');
    const unsigned = `${header}.${claims}`;
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

/** Call only GitHub over HTTPS with bounded input/output, no redirects and sanitized failures. */
export async function githubRequest(path, credential, body, fetchRequest = fetch) {
    try {
        const response = await fetchRequest(`https://api.github.com${path}`, {
            method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'DesktopCommanderContainer-token-issuer',
                ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
            const retry = response.headers.get('retry-after');
            const retrySeconds = /^\d+$/.test(retry ?? '') ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
            const failure = new Error('GitHub request failed');
            failure.retryAfter = Math.min(300000, Math.max(0, (retrySeconds || 0) * 1000));
            await response.body?.cancel();
            throw failure;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.length;
                if (length > 262144) throw new Error();
                chunks.push(Buffer.from(chunk.value));
            }
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } finally {
            await reader.cancel();
        }
    } catch (failure) {
        const sanitized = new Error('GitHub request failed');
        sanitized.retryAfter = failure.retryAfter ?? 0;
        throw sanitized;
    }
}

/** Require precisely the approved permissions; new App grants do not enlarge issued credentials. */
export function validatePermissions(actual) {
    if (!actual || Object.keys(actual).length !== Object.keys(permissions).length
        || Object.entries(permissions).some(([key, value]) => actual[key] !== value)) {
        throw new Error('GitHub scope mismatch');
    }
}

/** Verify App and installation identity, then mint and verify one repository-scoped token. */
export async function issueToken(privateKey, request = githubRequest, now = Date.now()) {
    const assertion = createAssertion(privateKey, now);
    const app = await request('/app', assertion);
    if (app.id !== identity.app_id || app.slug !== 'the9ball-git-agent') throw new Error('App identity mismatch');
    const installation = await request(`/repos/${identity.repository}/installation`, assertion);
    if (installation.id !== identity.installation_id || installation.app_id !== identity.app_id
        || installation.account?.login !== 'the9ball' || installation.suspended_at !== null
        || installation.repository_selection !== 'selected') throw new Error('Installation mismatch');
    validatePermissions(installation.permissions);
    const result = await request(`/app/installations/${identity.installation_id}/access_tokens`, assertion,
        { repositories: ['DesktopCommanderContainer'], permissions });
    validatePermissions(result.permissions);
    const repositories = result.repositories;
    if (!Array.isArray(repositories) || repositories.length !== 1
        || repositories[0].full_name !== identity.repository
        || !/^ghs_[A-Za-z0-9_]+$/.test(result.token)
        || !Number.isFinite(Date.parse(result.expires_at))
        || Date.parse(result.expires_at) <= now + 600000
        || Date.parse(result.expires_at) > now + 3660000) throw new Error('Issued token scope or expiry mismatch');
    const accessible = await request('/installation/repositories', result.token);
    if (accessible.total_count !== 1 || accessible.repositories?.length !== 1
        || accessible.repositories[0].full_name !== identity.repository) throw new Error('Issued token scope mismatch');
    return { ...identity, token: result.token, expires_at: result.expires_at, permissions };
}

/** Publish one durable token generation without ever exposing partial contents to readers. */
export async function publishToken(document, directory = tokenDirectory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${directory}/.token-${randomUUID()}`;
    let handle;
    try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(JSON.stringify(document));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, `${directory}/token.json`);
        const directoryHandle = await open(directory, constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally {
        await handle?.close();
        await unlink(temporary).catch(() => {});
    }
}

/** Calculate a bounded jittered exponential retry delay, honoring bounded Retry-After. */
export function retryDelay(failures, retryAfter = 0, random = Math.random()) {
    return Math.max(retryAfter, Math.min(60000, 2000 * 2 ** Math.min(failures, 5)) * (0.8 + random * 0.2));
}

/** Keep issuance available across failures and restarts; logs contain only fixed event names. */
export async function runIssuer({ load = loadPrivateKey, issue = issueToken, publish = publishToken,
    read = readToken, sleep = delay, now = Date.now, signal } = {}) {
    let failures = 0;
    let nextAttempt = 0;
    const refreshAhead = 600000 + Math.random() * 60000;
    while (!signal?.aborted) {
        let current;
        try { current = read(); } catch { /* Missing or expired credentials require issuance. */ }
        if (now() >= nextAttempt && (!current || Date.parse(current.expires_at) - now() < refreshAhead)) {
            try {
                await publish(await issue(await load()));
                failures = 0;
                nextAttempt = now() + 1000;
                console.info('github-app token-published');
            } catch (failure) {
                nextAttempt = now() + retryDelay(failures++, failure.retryAfter);
                console.error('github-app refresh-failed');
            }
        }
        await sleep(Math.max(100, Math.min(10000, nextAttempt > now() ? nextAttempt - now() : 10000)), undefined, { signal });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const operation = process.argv[2] === '--check-key' ? loadPrivateKey(process.argv[3]) : runIssuer();
    operation.catch(() => { console.error('github-app issuer-stopped'); process.exitCode = 1; });
}
