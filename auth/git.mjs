#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commandEnvironment } from './token-file.mjs';

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
// Reject persisted HTTP credentials instead of sending them before helper negotiation.
const headers = spawnSync('/usr/bin/git', [...context, 'config', '--get-regexp', '^http\..*(extraheader|cookiefile)$'], options);
if (headers.error || (headers.status !== 0 && headers.status !== 1) || headers.stdout?.trim()
    || existsSync(`${environment.HOME ?? '/root'}/.netrc`)) {
    console.error('Unsupported Git HTTP authentication configuration');
    process.exitCode = 1;
} else {
    const result = spawnSync('/usr/bin/git', [...context, '-c', 'credential.helper=', '-c',
        'credential.helper=/usr/local/bin/git-credential-github-app', '-c', 'credential.useHttpPath=true',
        '-c', 'core.askPass=', ...argumentsToGit], { stdio: 'inherit', env: environment });
    process.exitCode = result.status ?? 1;
}
