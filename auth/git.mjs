#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commandEnvironment, readToken } from './token-file.mjs';

const environment = { ...commandEnvironment(), GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', PATH: `/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` };
const options = { env: environment, encoding: 'utf8' };
const argumentsToGit = process.argv.slice(2);
const context = [];
// Probe the same repository and command-line config, including commands launched with -C.
while (argumentsToGit.length) {
    const argument = argumentsToGit[0];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(argument)) {
        context.push(...argumentsToGit.splice(0, 2));
    } else if (/^(?:-C.|-c.|--(?:git-dir|work-tree|namespace|config-env)=|--(?:bare|no-pager|paginate|literal-pathspecs|no-literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs)$)/.test(argument)) {
        context.push(argumentsToGit.shift());
    } else break;
}
/** Detect URL userinfo without including credentials in diagnostics. */
function containsCredentials(value) {
    return /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value);
}

// URL rewrites can assemble credentials from individually harmless fragments; reject all rewrites.
const configuration = spawnSync('/usr/bin/git', [...context, 'config', '--null', '--list'], options);
const unsafeConfiguration = configuration.stdout?.split('\0').some((record) => {
    const key = record.split('\n', 1)[0].toLowerCase();
    return /^http\..*(extraheader|cookiefile)$/.test(key)
        || /^url\..*\.(insteadof|pushinsteadof)$/.test(key) || containsCredentials(record);
});
if (configuration.error || configuration.status !== 0 || unsafeConfiguration
    || [...context, ...argumentsToGit].some(containsCredentials)
    || existsSync(`${environment.HOME ?? '/root'}/.netrc`)) {
    console.error('Unsupported Git authentication configuration');
    process.exitCode = 1;
} else {
    try {
        if (['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(argumentsToGit[0])) readToken();
        const result = spawnSync('/usr/bin/git', [...context, '-c', 'credential.helper=', '-c',
            'credential.helper=/usr/local/bin/git-credential-github-app', '-c', 'credential.useHttpPath=true',
            '-c', 'core.askPass=', ...argumentsToGit], { stdio: 'inherit', env: environment });
        process.exitCode = result.status ?? 1;
    } catch {
        console.error('GitHub App credential unavailable');
        process.exitCode = 1;
    }
}
