import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { identity, permissions } from '/usr/local/lib/github-app/token-file.mjs';

/** Invoke a subprocess with captured credentials; failures never include captured output. */
function command(executable, argumentsToCommand, options = {}) {
    return spawnSync(executable, argumentsToCommand, { encoding: 'utf8', timeout: 10000, ...options });
}

/** Publish only synthetic test credentials to this disposable container's token path. */
function publish(generation, expires = Date.now() + 3600000) {
    mkdirSync('/run/github-app-token', { recursive: true, mode: 0o700 });
    chmodSync('/run/github-app-token', 0o700);
    writeFileSync('/run/github-app-token/token.json', JSON.stringify({ ...identity, permissions,
        token: `ghs_SYNTHETIC_${generation}`, expires_at: new Date(expires).toISOString() }), { mode: 0o600 });
}

/** Exercise real Git's helper selection and auth-config precedence in an isolated HOME. */
test('Git uses current generation and never stale helpers, askpass, headers or netrc', () => {
    const directory = mkdtempSync(join(tmpdir(), 'github-app-command-'));
    const marker = join(directory, 'fallback-ran');
    const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory,
        GH_TOKEN: 'SYNTHETIC_OLD_PAT', GIT_ASKPASS: '/missing-askpass' };
    const input = `protocol=https\nhost=github.com\npath=${identity.repository}.git\n\n`;
    try {
        const helper = join(directory, 'old-helper');
        writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\necho password=SYNTHETIC_OLD_PAT\n`, { mode: 0o700 });
        for (const key of ['credential.helper', 'credential.https://github.com.helper']) {
            assert.equal(command('/usr/bin/git', ['config', '--global', '--add', key, helper], { env: environment }).status, 0);
        }
        for (const generation of ['FIRST', 'SECOND']) {
            publish(generation);
            const result = command('/usr/local/bin/git', ['credential', 'fill'], { env: environment, input });
            assert.equal(result.status, 0, 'Git credential selection must succeed');
            assert.equal(result.stdout.includes(`password=ghs_SYNTHETIC_${generation}`), true);
            assert.equal(result.stdout.includes('SYNTHETIC_OLD_PAT'), false);
            assert.equal(existsSync(marker), false);
        }
        publish('EXPIRED', Date.now() - 1000);
        const expired = command('/usr/local/bin/git', ['credential', 'fill'], { env: environment, input });
        assert.notEqual(expired.status, 0);
        assert.equal(existsSync(marker), false);
        assert.equal(expired.stdout.includes('password='), false);
        rmSync('/run/github-app-token/token.json');
        assert.notEqual(command('/usr/local/bin/git', ['credential', 'fill'], { env: environment, input }).status, 0);
        assert.equal(existsSync(marker), false);
        publish('VALID');
        const repository = join(directory, 'repository');
        assert.equal(command('/usr/bin/git', ['init', repository], { env: environment }).status, 0);
        assert.equal(command('/usr/bin/git', ['-C', repository, 'config', 'http.https://github.com/.extraHeader',
            'Authorization: Bearer SYNTHETIC_STALE_HEADER'], { env: environment }).status, 0);
        const blocked = command('/usr/local/bin/git', ['-C', repository, 'credential', 'fill'], { env: environment, input });
        assert.notEqual(blocked.status, 0);
        assert.equal(blocked.stderr.includes('SYNTHETIC_STALE_HEADER'), false);
        writeFileSync(join(directory, '.netrc'), 'machine github.com password SYNTHETIC_NETRC');
        assert.notEqual(command('/usr/local/bin/git', ['credential', 'fill'], { env: environment, input }).status, 0);
        rmSync(join(directory, '.netrc'));
        for (const target of ['other/repository', `${identity.repository}/other`]) {
            const denied = command('/usr/local/bin/git', ['credential', 'fill'], {
                env: environment, input: input.replace(`${identity.repository}.git`, target) });
            assert.notEqual(denied.status, 0);
            assert.equal(denied.stdout.includes('password='), false);
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

/** Read-only gh commands still require the App file, even with a saved or inherited PAT. */
test('gh refuses missing and expired files despite stored and inherited credentials', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-gh-'));
    try {
        mkdirSync(join(home, '.config/gh'), { recursive: true });
        writeFileSync(join(home, '.config/gh/hosts.yml'), 'github.com:\n    oauth_token: SYNTHETIC_SAVED_PAT\n');
        const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home,
            GH_TOKEN: 'SYNTHETIC_ENV_PAT', GITHUB_TOKEN: 'SYNTHETIC_ENV_PAT' };
        rmSync('/run/github-app-token/token.json', { force: true });
        assert.notEqual(command('/usr/local/bin/gh', ['--version'], { env }).status, 0);
        publish('EXPIRED', Date.now() - 1000);
        assert.notEqual(command('/usr/local/bin/gh', ['--version'], { env }).status, 0);
        publish('LIVE');
        assert.equal(command('/usr/local/bin/gh', ['--version'], { env }).status, 0);
        assert.equal(readFileSync(join(home, '.config/gh/hosts.yml'), 'utf8').includes('SYNTHETIC_SAVED_PAT'), true);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Check exactly what each wrapper invocation passes without printing token values. */
test('gh passes only the latest token to its child without changing saved credentials', () => {
    renameSync('/usr/bin/gh', '/usr/bin/gh.test-original');
    try {
        writeFileSync('/usr/bin/gh', `#!/usr/bin/env node\nimport {createHash} from 'node:crypto';\nconsole.log(JSON.stringify({digest:createHash('sha256').update(process.env.GH_TOKEN).digest('hex'),config:process.env.GH_CONFIG_DIR,legacy:!!process.env.GITHUB_TOKEN,debug:!!process.env.GH_DEBUG}));\n`, { mode: 0o755 });
        for (const generation of ['FIRST', 'SECOND']) {
            publish(generation);
            const result = command('/usr/local/bin/gh', ['api', 'repos/the9ball/DesktopCommanderContainer'], {
                env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root',
                    GH_TOKEN: 'SYNTHETIC_OLD_PAT', GITHUB_TOKEN: 'SYNTHETIC_OLD_PAT', GH_DEBUG: 'api' } });
            assert.equal(result.status, 0, 'Wrapper child must run');
            const details = JSON.parse(result.stdout);
            assert.equal(details.digest, createHash('sha256').update(`ghs_SYNTHETIC_${generation}`).digest('hex'));
            assert.equal(details.config, '/usr/local/share/github-app/gh-config');
            assert.equal(details.legacy, false);
            assert.equal(details.debug, false);
        }
    } finally {
        rmSync('/usr/bin/gh', { force: true });
        renameSync('/usr/bin/gh.test-original', '/usr/bin/gh');
    }
});
