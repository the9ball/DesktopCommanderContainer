import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const mode = process.argv[2];

if (mode) {
    const { identity, permissions, readToken } = await import('/usr/local/lib/github-app/token-file.mjs');
    const { publishToken } = await import('/usr/local/lib/github-app/token-issuer.mjs');
    if (mode === 'seed') {
        mkdirSync('/run/github-app-key', { recursive: true, mode: 0o700 });
        chmodSync('/run/github-app-key', 0o700);
        writeFileSync('/run/github-app-key/app.pem', 'SYNTHETIC_KEY_ISOLATION_CANARY', { mode: 0o600 });
    }
    if (['seed', 'rotate', 'expire'].includes(mode)) {
        await publishToken({ ...identity, permissions, token: `ghs_SYNTHETIC_${mode}`,
            expires_at: new Date(Date.now() + (mode === 'expire' ? -1000 : 3600000)).toISOString() });
    } else if (mode === 'read') {
        assert.equal(existsSync('/run/github-app-key/app.pem'), false);
        assert.throws(() => writeFileSync('/run/github-app-token/unauthorized', 'not-secret'),
            (failure) => ['EROFS', 'EACCES'].includes(failure.code));
        const generation = readToken().token.slice('ghs_SYNTHETIC_'.length);
        assert.ok(['seed', 'rotate'].includes(generation));
        console.info(`generation=${generation}; key-invisible; volume-read-only`);
    } else if (mode === 'expired') {
        assert.throws(() => readToken(), { message: 'GitHub App credential unavailable' });
        console.info('expired-failed-closed');
    } else if (mode !== 'seed') throw new Error('Unknown volume fixture operation');
} else {
    /** Run Docker without shell interpolation and never include captured secrets in failures. */
    function docker(argumentsToDocker, allowFailure = false) {
        const result = spawnSync('docker', argumentsToDocker, { encoding: 'utf8', timeout: 60000 });
        if (!allowFailure) assert.equal(result.status, 0, `Docker ${argumentsToDocker[0]} must succeed`);
        return result.stdout.trim();
    }

    /** Prove actual named-volume isolation/rotation using only uniquely named synthetic resources. */
    test('named volumes isolate keys, enforce consumer RO and support expiry/recovery', () => {
        const image = process.env.GITHUB_APP_TEST_IMAGE;
        assert.ok(image, 'Set GITHUB_APP_TEST_IMAGE to an already built local candidate');
        const prefix = `issue10-volume-${randomUUID().slice(0, 8)}`;
        const keyVolume = `${prefix}-key`;
        const tokenVolume = `${prefix}-token`;
        const containers = [];
        const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        /** Start a fresh process with only the explicitly authorized fixture mounts. */
        function fixture(operation, keyAccess, tokenAccess) {
            const name = `${prefix}-${operation}-${containers.length}`;
            const mounts = ['--mount', `type=volume,src=${tokenVolume},dst=/run/github-app-token${tokenAccess === 'ro' ? ',readonly' : ''}`];
            if (keyAccess) mounts.push('--mount', `type=volume,src=${keyVolume},dst=/run/github-app-key${keyAccess === 'ro' ? ',readonly' : ''}`);
            const identifier = docker(['create', '--name', name, '--network', 'none', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', ...mounts, '--entrypoint', 'node', image,
                '/tmp/github-app-docker.test.mjs', operation]);
            containers.push(identifier);
            docker(['cp', resolve(root, 'auth'), `${identifier}:/usr/local/lib/github-app`]);
            docker(['cp', fileURLToPath(import.meta.url), `${identifier}:/tmp/github-app-docker.test.mjs`]);
            const output = docker(['start', '--attach', identifier]);
            assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', identifier]), '0');
            return output;
        }
        try {
            docker(['volume', 'create', keyVolume]);
            docker(['volume', 'create', tokenVolume]);
            fixture('seed', 'rw', 'rw');
            assert.match(fixture('read', undefined, 'ro'), /generation=seed; key-invisible; volume-read-only/);
            fixture('rotate', 'ro', 'rw');
            assert.match(fixture('read', undefined, 'ro'), /generation=rotate/);
            fixture('expire', 'ro', 'rw');
            assert.match(fixture('expired', undefined, 'ro'), /expired-failed-closed/);
            fixture('rotate', 'ro', 'rw');
            assert.match(fixture('read', undefined, 'ro'), /generation=rotate/);
        } finally {
            for (const identifier of containers) docker(['rm', '-f', identifier], true);
            docker(['volume', 'rm', keyVolume, tokenVolume], true);
        }
    });
}
