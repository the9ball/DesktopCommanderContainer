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
        assert.equal(command('/usr/bin/git', ['config', '--global', 'core.askPass', helper], { env: environment }).status, 0);
        for (const generation of ['FIRST', 'SECOND']) {
            publish(generation);
            const result = command('/usr/local/bin/git', ['credential', 'fill'], { env: environment, input });
            assert.equal(result.status, 0, 'Git credential selection must succeed');
            assert.equal(result.stdout.includes(`password=ghs_SYNTHETIC_${generation}`), true);
            assert.equal(result.stdout.includes('SYNTHETIC_OLD_PAT'), false);
            assert.equal(existsSync(marker), false);
        }
        const controlled = command('/usr/local/bin/git', ['-c', `credential.helper=${helper}`,
            '-c', 'credential.https://github.com.helper=!"gh" auth git-credential',
            '--config-env=core.askPass=ISSUE10_ASKPASS', 'credential', 'fill'], {
            env: { ...environment, ISSUE10_ASKPASS: helper }, input });
        assert.equal(controlled.status, 0);
        assert.equal(controlled.stdout.includes('password=ghs_SYNTHETIC_SECOND'), true);
        assert.equal(existsSync(marker), false);
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

/** Credential-bearing URLs and rewrites must fail locally before Git can bypass its helper. */
test('Git rejects argument, remote, push URL credentials and split URL rewrites', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-url-'));
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home };
    const repository = join(home, 'repository');
    const credentialUrl = `https://x-access-token:SYNTHETIC_URL_PAT@github.com/${identity.repository}.git`;
    /** Assert a fixed local policy failure and no credential values in diagnostics. */
    function denied(argumentsToGit) {
        const result = command('/usr/local/bin/git', argumentsToGit, { env });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unsupported Git authentication configuration/);
        assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_URL_PAT'), false);
    }
    try {
        assert.equal(command('/usr/bin/git', ['init', repository], { env }).status, 0);
        for (const state of ['missing', 'expired', 'valid']) {
            if (state === 'missing') rmSync('/run/github-app-token/token.json', { force: true });
            else publish('URL_TEST', state === 'expired' ? Date.now() - 1000 : Date.now() + 3600000);
            denied(['clone', credentialUrl, join(home, 'clone')]);
            for (const key of ['remote.origin.url', 'remote.origin.pushurl']) {
                assert.equal(command('/usr/bin/git', ['-C', repository, 'config', key, credentialUrl], { env }).status, 0);
                denied(['-C', repository, 'push', 'origin', 'HEAD']);
                assert.equal(command('/usr/bin/git', ['-C', repository, 'config', '--unset', key], { env }).status, 0);
            }
            for (const kind of ['insteadOf', 'pushInsteadOf']) {
                const key = `url.https://x-access-token:.${kind}`;
                assert.equal(command('/usr/bin/git', ['-C', repository, 'config', key, 'issue10:'], { env }).status, 0);
                denied(['-C', repository, 'push', `issue10:SYNTHETIC_URL_PAT@github.com/${identity.repository}.git`]);
                assert.equal(command('/usr/bin/git', ['-C', repository, 'config', '--unset', key], { env }).status, 0);
            }
        }
    } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Compare supported global argument semantics with the actual Git binary, without network access. */
test('Git global options preserve directory order and configuration precedence', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-context-'));
    const repository = join(home, 'repository');
    const bare = join(home, 'bare');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, ISSUE10_PROBE: 'environment-value' };
    try {
        assert.equal(command('/usr/bin/git', ['init', repository], { env }).status, 0);
        assert.equal(command('/usr/bin/git', ['init', '--bare', bare], { env }).status, 0);
        for (const location of [repository, bare]) {
            assert.equal(command('/usr/bin/git', ['-C', location, 'config', 'user.name', 'repository-value'], { env }).status, 0);
        }
        const contexts = [
            ['--no-optional-locks', '-C', repository],
            ['-C', home, '--no-optional-locks', '-C', 'repository'],
            ['-C', home, '-C', '', '--no-pager', '-C', 'repository'],
            ['-c', 'user.name=first', '-C', repository, '--no-advice', '-c', 'user.name=last'],
            ['--git-dir', join(repository, '.git'), '--work-tree', repository, '--no-optional-locks'],
            ['--git-dir=.git', '--work-tree=.', '--no-optional-locks', '-C', repository],
            ['--namespace', 'fixture', '--config-env', 'user.name=ISSUE10_PROBE', '-C', repository],
            ['-C', repository, '--config-env=user.name=ISSUE10_PROBE', '--namespace=fixture'],
            ['-C', repository, '--attr-source', 'HEAD'],
            ['--attr-source=HEAD', '-C', repository],
            ['-C', bare, '--bare', '--no-optional-locks'],
        ];
        for (const flag of ['-p', '--paginate', '-P', '--no-pager', '--no-replace-objects',
            '--no-lazy-fetch', '--no-advice', '--literal-pathspecs', '--no-literal-pathspecs',
            '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']) {
            contexts.push([flag, '-C', repository, '--no-optional-locks']);
        }
        for (const context of contexts) {
            const argumentsToGit = [...context, 'config', '--get', 'user.name'];
            const actual = command('/usr/bin/git', argumentsToGit, { env });
            const wrapped = command('/usr/local/bin/git', argumentsToGit, { env });
            assert.equal(actual.status, 0, 'Reference Git must accept the supported context');
            assert.equal(wrapped.status, actual.status);
            assert.equal(wrapped.stdout, actual.stdout);
        }
        // A subcommand's own -c is not a global -c; version/help are command aliases in Git.
        for (const argumentsToGit of [['-C', repository, 'status', '--short'], ['-C', repository, 'log', '-c', '--all'],
            ['--no-optional-locks', '--version'], ['-v']]) {
            const actual = command('/usr/bin/git', argumentsToGit, { env });
            const wrapped = command('/usr/local/bin/git', argumentsToGit, { env });
            assert.equal(actual.status, 0);
            assert.equal(wrapped.status, actual.status);
            assert.equal(wrapped.stdout, actual.stdout);
        }
    } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Detect credentials in the real option-selected repository for missing, expired and valid App files. */
test('global flag ordering cannot bypass repository and command-line credential checks', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-global-auth-'));
    const repository = join(home, 'repository');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home,
        ISSUE10_HEADER: 'Authorization: Bearer SYNTHETIC_OPTION_PAT' };
    const contexts = [
        ['--no-optional-locks', '-C', repository],
        ['-C', repository, '--no-optional-locks'],
        ['-c', 'user.name=first', '--no-optional-locks', '-C', repository, '-c', 'user.name=last'],
        ['-C', home, '--no-pager', '-C', '', '--no-optional-locks', '-C', 'repository'],
        ['--git-dir', join(repository, '.git'), '--no-optional-locks', '--work-tree', repository],
        ['--no-optional-locks', '--git-dir=.git', '--work-tree=.', '-C', repository],
    ];
    /** Require the credential policy's local refusal, never a timeout or unrelated Git failure. */
    function refused(context) {
        const result = command('/usr/local/bin/git', [...context, 'push', 'origin', 'HEAD'], { env });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Unsupported Git authentication configuration/);
        assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_OPTION_PAT'), false);
    }
    try {
        assert.equal(command('/usr/bin/git', ['init', repository], { env }).status, 0);
        for (const state of ['missing', 'expired', 'valid']) {
            if (state === 'missing') rmSync('/run/github-app-token/token.json', { force: true });
            else publish('GLOBAL_OPTIONS', state === 'expired' ? Date.now() - 1000 : Date.now() + 3600000);
            for (const [key, value] of [
                ['remote.origin.url', `https://x-access-token:SYNTHETIC_OPTION_PAT@github.com/${identity.repository}.git`],
                ['remote.origin.pushurl', `https://x-access-token:SYNTHETIC_OPTION_PAT@github.com/${identity.repository}.git`],
                ['http.https://github.com/.extraHeader', 'Authorization: Bearer SYNTHETIC_OPTION_PAT'],
            ]) {
                assert.equal(command('/usr/bin/git', ['-C', repository, 'config', key, value], { env }).status, 0);
                for (const context of contexts) refused(context);
                assert.equal(command('/usr/bin/git', ['-C', repository, 'config', '--unset', key], { env }).status, 0);
            }
            for (const context of [
                ['--no-optional-locks', '-c', `http.extraHeader=${env.ISSUE10_HEADER}`, '-C', repository],
                ['-C', repository, '--no-optional-locks', '-c', `http.extraHeader=${env.ISSUE10_HEADER}`],
                ['--config-env=http.extraHeader=ISSUE10_HEADER', '--no-optional-locks', '-C', repository],
                ['-C', repository, '--config-env', 'http.extraHeader=ISSUE10_HEADER', '--no-advice'],
            ]) refused(context);
        }
    } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Refuse unreviewed grammar and implicit alias expansion instead of guessing a command boundary. */
test('unsupported global grammar, missing operands and configured aliases fail closed', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-unsupported-'));
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home };
    try {
        assert.equal(command('/usr/bin/git', ['init', home], { env }).status, 0);
        for (const prefix of [
            ['--future-option'], ['--exec-path=/tmp/SYNTHETIC_OPTION_PAT'], ['--shallow-file', '/tmp/unused'],
            ['--'], ['-Cattached'], ['-cuser.name=attached'],
        ]) {
            const result = command('/usr/local/bin/git', [...prefix, '--no-optional-locks', '-C', home, 'push'], { env });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /Unsupported Git global options/);
            assert.equal(result.stderr.includes('SYNTHETIC_OPTION_PAT'), false);
        }
        for (const option of ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']) {
            const result = command('/usr/local/bin/git', ['--no-optional-locks', option], { env });
            assert.equal(result.status, 1);
            assert.match(result.stderr, /Unsupported Git global options/);
        }
        assert.equal(command('/usr/bin/git', ['-C', home, 'config', 'alias.hidden-push',
            '-c http.extraHeader=SYNTHETIC_OPTION_PAT push'], { env }).status, 0);
        const alias = command('/usr/local/bin/git', ['--no-optional-locks', '-C', home, 'hidden-push'], { env });
        assert.equal(alias.status, 1);
        assert.match(alias.stderr, /Unsupported Git authentication configuration/);
        assert.equal(alias.stderr.includes('SYNTHETIC_OPTION_PAT'), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Exercise global versus clone-local config forms; only benign command-supplied namespaces are allowed. */
test('global and clone settings reject authentication and indirect configuration injection', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-clone-policy-'));
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home,
        ISSUE10_CONFIG: 'SYNTHETIC_CLONE_SETTING' };
    const source = `https://github.com/${identity.repository}.git`;
    const target = join(home, 'clone');
    const keys = ['http.extraHeader', 'http.https://github.com/.extraHeader', 'credential.helper',
        'credential.https://github.com.helper', 'core.askPass', 'core.sshCommand', 'include.path',
        'includeIf.gitdir:/tmp/.path', 'init.templateDir', 'remote.origin.url',
        'url.https://example.com/.insteadOf', 'http.sslCert', 'protocol.ext.allow'];
    /** Require policy refusal before creating the target or starting any transport. */
    function refused(argumentsToGit, expected = /Unsupported Git authentication configuration/) {
        const result = command('/usr/local/bin/git', argumentsToGit, { env });
        assert.equal(result.status, 1);
        assert.match(result.stderr, expected);
        assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_CLONE_SETTING'), false);
        assert.equal(existsSync(target), false);
    }
    try {
        for (const state of ['missing', 'expired', 'valid']) {
            if (state === 'missing') rmSync('/run/github-app-token/token.json', { force: true });
            else publish('CLONE_POLICY', state === 'expired' ? Date.now() - 1000 : Date.now() + 3600000);
            for (const key of keys) {
                const setting = `${key}=SYNTHETIC_CLONE_SETTING`;
                const managed = key === 'core.askPass' || key.startsWith('credential.');
                if (!managed) refused(['-c', setting, 'clone', source, target]);
                refused(['clone', '-c', setting, source, target]);
                refused(['clone', `-c${setting}`, source, target]);
                refused(['clone', '--config', setting, source, target]);
                refused(['clone', source, `--config=${setting}`, target]);
                if (!managed) refused([`--config-env=${key}=ISSUE10_CONFIG`, 'clone', source, target]);
            }
        }
        for (const argumentsToGit of [
            ['--config', 'user.name=synthetic', 'clone', source, target],
            ['clone', '--conf=http.extraHeader=SYNTHETIC_CLONE_SETTING', source, target],
            ['clone', '-qc', 'http.extraHeader=SYNTHETIC_CLONE_SETTING', source, target],
            ['clone', '--config-env=http.extraHeader=ISSUE10_CONFIG', source, target],
            ['clone', '--template=/tmp/unreviewed', source, target],
            ['clone', '--separate-git-dir=/tmp/unreviewed', source, target],
            ['clone', '--recurse-submodules', source, target],
            ['clone', source, target, '--config'],
        ]) refused(argumentsToGit, /Unsupported Git (global|clone) options/);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Check actual object transfer and benign config persistence against local disposable repositories. */
test('normal clone fetch and push work with safe config and renewed synthetic App files', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-roundtrip-'));
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home,
        GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const origin = join(home, 'origin.git');
    const seed = join(home, 'seed');
    const clone = join(home, 'clone');
    const helperMarker = join(home, 'caller-helper-ran');
    /** Require a successful local Git operation without including captured output in assertion failures. */
    function run(executable, argumentsToGit) {
        const result = command(executable, argumentsToGit, { env });
        assert.equal(result.status, 0, 'Local Git fixture operation must succeed');
        return result.stdout.trim();
    }
    try {
        run('/usr/bin/git', ['init', '--bare', origin]);
        run('/usr/bin/git', ['init', '--initial-branch=main', seed]);
        writeFileSync(join(seed, 'marker.txt'), 'first\n');
        run('/usr/bin/git', ['-C', seed, 'add', 'marker.txt']);
        run('/usr/bin/git', ['-C', seed, 'commit', '-m', 'Synthetic initial fixture']);
        run('/usr/bin/git', ['-C', seed, 'push', origin, 'main']);
        run('/usr/bin/git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
        publish('ROUNDTRIP_FIRST');
        run('/usr/local/bin/git', ['--no-optional-locks', '-c', `credential.helper=!touch '${helperMarker}'`,
            '-c', 'credential.https://github.com.helper=!"gh" auth git-credential',
            '-c', 'user.name=command-name', 'clone',
            '-cuser.name=local-name', '--config', 'core.eol=lf', '--branch=main', origin, clone]);
        assert.equal(run('/usr/bin/git', ['-C', clone, 'config', '--local', '--get', 'user.name']), 'local-name');
        assert.equal(readFileSync(join(clone, 'marker.txt'), 'utf8'), 'first\n');
        assert.equal(existsSync(helperMarker), false);
        writeFileSync(join(seed, 'marker.txt'), 'second\n');
        run('/usr/bin/git', ['-C', seed, 'commit', '-am', 'Synthetic upstream fixture']);
        run('/usr/bin/git', ['-C', seed, 'push', origin, 'main']);
        publish('ROUNDTRIP_SECOND');
        run('/usr/local/bin/git', ['--no-optional-locks', '-C', clone, 'fetch', 'origin', 'main']);
        assert.equal(run('/usr/bin/git', ['-C', clone, 'rev-parse', 'FETCH_HEAD']),
            run('/usr/bin/git', ['-C', origin, 'rev-parse', 'refs/heads/main']));
        writeFileSync(join(clone, 'push-marker.txt'), 'local push\n');
        run('/usr/local/bin/git', ['-C', clone, 'add', 'push-marker.txt']);
        run('/usr/local/bin/git', ['-C', clone, 'commit', '-m', 'Synthetic outgoing fixture']);
        run('/usr/local/bin/git', ['-C', clone, 'push', 'origin', 'HEAD:refs/heads/fixture']);
        assert.equal(run('/usr/bin/git', ['-C', origin, 'rev-parse', 'refs/heads/fixture']),
            run('/usr/bin/git', ['-C', clone, 'rev-parse', 'HEAD']));
        const shallow = join(home, 'shallow');
        run('/usr/local/bin/git', ['clone', `file://${origin}`, '--depth', '1', '--single-branch', shallow]);
        assert.equal(run('/usr/bin/git', ['-C', shallow, 'rev-parse', '--is-shallow-repository']), 'true');
        for (const state of ['missing', 'expired']) {
            if (state === 'missing') rmSync('/run/github-app-token/token.json');
            else publish('EXPIRED_ROUNDTRIP', Date.now() - 1000);
            for (const argumentsToGit of [['clone', origin, join(home, state)],
                ['-C', clone, 'fetch', 'origin'], ['-C', clone, 'push', 'origin', 'HEAD:refs/heads/never-written']]) {
                const result = command('/usr/local/bin/git', argumentsToGit, { env });
                assert.equal(result.status, 1);
                assert.match(result.stderr, /GitHub App credential unavailable/);
            }
        }
    } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Isolate future clone config from conditional global includes, templates and ambient Git control variables. */
test('clone cannot activate unseen global includes or template and environment authentication', () => {
    const home = mkdtempSync(join(tmpdir(), 'github-app-hidden-config-'));
    const source = join(home, 'source.git');
    const target = join(home, 'clone');
    const template = join(home, 'template');
    const injected = join(home, 'injected.config');
    const marker = join(home, 'helper-ran');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home };
    try {
        assert.equal(command('/usr/bin/git', ['init', '--bare', source], { env }).status, 0);
        mkdirSync(template);
        writeFileSync(injected, '[http]\n    extraHeader = Authorization: Basic SYNTHETIC_HIDDEN_CONFIG\n');
        writeFileSync(join(template, 'config'), readFileSync(injected));
        writeFileSync(join(home, '.gitconfig'), `[includeIf "gitdir:${target}/"]\n    path = ${injected}\n[init]\n    templateDir = ${template}\n`);
        const helper = join(home, 'helper');
        writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
        publish('HIDDEN_CONFIG');
        const result = command('/usr/local/bin/git', ['clone', source, target], { env: { ...env,
            GIT_CONFIG_GLOBAL: injected, GIT_CONFIG_SYSTEM: injected, GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'SYNTHETIC_HIDDEN_CONFIG',
            GIT_TEMPLATE_DIR: template, GIT_EXEC_PATH: '/nonexistent', GIT_ASKPASS: helper,
            GIT_PROXY_COMMAND: helper, GIT_SSH_COMMAND: helper } });
        assert.equal(result.status, 0, 'Clone must use its isolated settings');
        const local = command('/usr/bin/git', ['-C', target, 'config', '--local', '--get', 'http.extraHeader'], { env });
        assert.equal(local.status, 1);
        assert.equal(existsSync(marker), false);
        assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_HIDDEN_CONFIG'), false);
        // A dash-leading destination after -- remains a literal path, not a forbidden config option.
        const literal = command('/usr/local/bin/git', ['clone', '--', source, '--config=http.extraHeader=literal'], { env, cwd: home });
        assert.equal(literal.status, 0);
        assert.equal(existsSync(join(home, '--config=http.extraHeader=literal/.git')), true);
    } finally { rmSync(home, { recursive: true, force: true }); }
});
