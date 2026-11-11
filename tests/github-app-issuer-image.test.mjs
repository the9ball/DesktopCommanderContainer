import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

/** Check removed payloads as well as executables, including dangling package-manager symlinks. */
test('issuer omits package managers and their dependency payloads', () => {
    for (const path of ['/usr/local/lib/node_modules', '/usr/local/bin/npm', '/usr/local/bin/npx',
        '/usr/local/bin/yarn', '/usr/local/bin/yarnpkg', '/usr/local/bin/corepack',
        '/root/.npm', '/root/.cache/node/corepack', '/usr/local/share/.cache/yarn']) {
        assert.throws(() => lstatSync(path), { code: 'ENOENT' });
    }
    const optionalPackages = existsSync('/opt') ? readdirSync('/opt') : [];
    assert.equal(optionalPackages.some((name) => name.startsWith('yarn')), false);
});

/** The dedicated issuer must not inherit command execution tooling from the commander build stage. */
test('issuer omits Git and GitHub CLI', () => {
    for (const path of ['/usr/bin/git', '/usr/local/bin/git', '/usr/bin/gh', '/usr/local/bin/gh']) {
        assert.throws(() => lstatSync(path), { code: 'ENOENT' });
    }
});
