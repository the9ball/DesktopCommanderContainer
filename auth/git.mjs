#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commandEnvironment, readToken } from './token-file.mjs';

const environment = { ...commandEnvironment(), GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', PATH: `/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` };
const options = { env: environment, encoding: 'utf8' };

/** Split a supported Git global-option grammar without reordering or resolving its arguments. */
function splitArguments(argumentsToSplit) {
    // Match git.c handle_options: -C/-c take separate operands; long options may use '='.
    const separate = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'];
    const flags = ['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects',
        '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs',
        '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'];
    const commandFlags = ['-h', '--help', '-v', '--version'];
    let position = 0;
    while (position < argumentsToSplit.length) {
        const argument = argumentsToSplit[position];
        if (!argument.startsWith('-') || commandFlags.includes(argument)) break;
        if (separate.includes(argument)) {
            if (position + 1 >= argumentsToSplit.length) throw new Error('Unsupported Git global options');
            position += 2;
        } else if (flags.includes(argument)
            || /^--(?:git-dir|work-tree|namespace|config-env|attr-source)=/.test(argument)) {
            position++;
        } else {
            // Unknown options never become a command boundary: a future Git could consume them.
            throw new Error('Unsupported Git global options');
        }
    }
    return { context: argumentsToSplit.slice(0, position), command: argumentsToSplit.slice(position) };
}
/** Detect URL userinfo without including credentials in diagnostics. */
function containsCredentials(value) {
    return /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value);
}

try {
    const { context, command } = splitArguments(process.argv.slice(2));
    // Git itself evaluates relative/empty/repeated -C and config precedence identically in both runs.
    const configuration = spawnSync('/usr/bin/git', [...context, 'config', '--null', '--list'], options);
    const unsafeConfiguration = configuration.stdout?.split('\0').some((record) => {
        const key = record.split('\n', 1)[0].toLowerCase();
        // An invoked alias could add options after this probe; implicit alias expansion is unsupported.
        return /^http\..*(extraheader|cookiefile)$/.test(key)
            || /^url\..*\.(insteadof|pushinsteadof)$/.test(key)
            || key === `alias.${command[0]?.toLowerCase()}` || containsCredentials(record);
    });
    if (configuration.error || configuration.status !== 0 || unsafeConfiguration
        || [...context, ...command].some(containsCredentials)
        || existsSync(`${environment.HOME ?? '/root'}/.netrc`)) {
        throw new Error('Unsupported Git authentication configuration');
    }
    if (['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(command[0])) readToken();
    const result = spawnSync('/usr/bin/git', [...context, '-c', 'credential.helper=', '-c',
        'credential.helper=/usr/local/bin/git-credential-github-app', '-c', 'credential.useHttpPath=true',
        '-c', 'core.askPass=', ...command], { stdio: 'inherit', env: environment });
    process.exitCode = result.status ?? 1;
} catch (failure) {
    const messages = ['Unsupported Git global options', 'Unsupported Git authentication configuration'];
    console.error(messages.includes(failure.message) ? failure.message : 'GitHub App credential unavailable');
    process.exitCode = 1;
}
