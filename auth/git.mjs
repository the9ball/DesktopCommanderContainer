#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commandEnvironment, readToken } from './token-file.mjs';

const environment = { ...commandEnvironment(), GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', PATH: `/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` };
// Ambient Git control variables must not introduce another config, transport, template or helper path.
for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_') && !/^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$/.test(key)) delete environment[key];
}
environment.GIT_TERMINAL_PROMPT = '0';
environment.GIT_CONFIG_NOSYSTEM = '1';
const options = { env: environment, encoding: 'utf8' };

/** Split a supported Git global-option grammar without reordering or resolving its arguments. */
function splitArguments(argumentsToSplit) {
    // Match git.c handle_options: -C/-c take separate operands; long options may use '='.
    const separate = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'];
    const flags = ['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects',
        '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs',
        '--no-literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'];
    const commandFlags = ['-h', '--help', '-v', '--version'];
    const executionContext = [];
    let position = 0;
    while (position < argumentsToSplit.length) {
        const argument = argumentsToSplit[position];
        if (!argument.startsWith('-') || commandFlags.includes(argument)) break;
        if (separate.includes(argument)) {
            if (position + 1 >= argumentsToSplit.length) throw new Error('Unsupported Git global options');
            if (!['-c', '--config-env'].includes(argument)) executionContext.push(argument, argumentsToSplit[position + 1]);
            position += 2;
        } else if (flags.includes(argument)
            || /^--(?:git-dir|work-tree|namespace|config-env|attr-source)=/.test(argument)) {
            if (!argument.startsWith('--config-env=')) executionContext.push(argument);
            position++;
        } else {
            // Unknown options never become a command boundary: a future Git could consume them.
            throw new Error('Unsupported Git global options');
        }
    }
    return { context: argumentsToSplit.slice(0, position), executionContext, command: argumentsToSplit.slice(position) };
}
/** Detect URL userinfo without including credentials in diagnostics. */
function containsCredentials(value) {
    return /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value);
}

/** Canonicalize a closed clone grammar so config options cannot hide behind abbreviations or bundles. */
function prepareClone(argumentsToClone) {
    const flags = ['--quiet', '-q', '--verbose', '-v', '--progress', '--no-progress', '--no-checkout', '-n',
        '--bare', '--mirror', '--single-branch', '--no-single-branch', '--tags', '--no-tags', '--local', '-l',
        '--no-local', '--no-hardlinks', '--sparse'];
    const values = { '-b': '--branch', '--branch': '--branch', '-o': '--origin', '--origin': '--origin',
        '--depth': '--depth', '--filter': '--filter', '--revision': '--revision', '-c': '--config', '--config': '--config' };
    const normalized = ['clone', '--template='];
    const configuration = [];
    const operands = [];
    let literal = false;
    for (let position = 0; position < argumentsToClone.length; position++) {
        const argument = argumentsToClone[position];
        if (literal || !argument.startsWith('-')) { operands.push(argument); continue; }
        if (argument === '--') { literal = true; continue; }
        if (flags.includes(argument)) { normalized.push(argument); continue; }
        let option = argument;
        let value;
        if (/^--[^=]+=/.test(argument)) {
            const separator = argument.indexOf('=');
            option = argument.slice(0, separator);
            value = argument.slice(separator + 1);
        } else if (/^-[boc]./.test(argument)) {
            option = argument.slice(0, 2);
            value = argument.slice(2);
        }
        if (!Object.hasOwn(values, option)) throw new Error('Unsupported Git clone options');
        if (value === undefined) {
            if (++position >= argumentsToClone.length) throw new Error('Unsupported Git clone options');
            value = argumentsToClone[position];
        }
        normalized.push(`${values[option]}=${value}`);
        if (values[option] === '--config') configuration.push('-c', value);
    }
    if (operands.length < 1 || operands.length > 2) throw new Error('Unsupported Git clone options');
    return { command: [...normalized, '--', ...operands], configuration };
}

/** Permit command-supplied settings only from a small namespace that cannot configure authentication. */
function safeCommandSetting(key) {
    return ['user.name', 'user.email', 'core.autocrlf', 'core.eol', 'core.filemode', 'core.ignorecase',
        'core.quotepath', 'color.ui', 'init.defaultbranch', 'fetch.prune', 'push.default', 'pull.rebase'].includes(key);
}

/** Parse scoped Git settings, optionally discard caller auth controls, and return only benign overrides. */
function inspectConfiguration(context, commandName, projected = [], executionEnvironment = environment, neutralizeControls = false) {
    const result = spawnSync('/usr/bin/git', [...context, ...projected, 'config', '--null', '--show-scope', '--list'],
        { ...options, env: executionEnvironment });
    if (result.error || result.status !== 0) throw new Error('Unsupported Git authentication configuration');
    const fields = result.stdout.split('\0');
    const safeArguments = [];
    if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('Unsupported Git authentication configuration');
    for (let position = 0; position < fields.length; position += 2) {
        const scope = fields[position];
        const record = fields[position + 1];
        const key = record.split('\n', 1)[0].toLowerCase();
        const managedControl = key === 'core.askpass' || /^credential(?:\..*)?\.helper$/.test(key);
        if ((scope === 'command' && !safeCommandSetting(key) && !(neutralizeControls && managedControl))
            || /^http\..*(extraheader|cookiefile)$/.test(key) || /^url\..*\.(insteadof|pushinsteadof)$/.test(key)
            || key === `alias.${commandName?.toLowerCase()}` || containsCredentials(record)) {
            throw new Error('Unsupported Git authentication configuration');
        }
        if (scope === 'command' && safeCommandSetting(key)) {
            const separator = record.indexOf('\n');
            safeArguments.push('-c', separator < 0 ? key : `${key}=${record.slice(separator + 1)}`);
        }
    }
    return safeArguments;
}

try {
    const { context, executionContext, command } = splitArguments(process.argv.slice(2));
    const prepared = command[0] === 'clone' ? prepareClone(command.slice(1)) : { command, configuration: [] };
    // Parse with Git, discard all caller helper/askpass settings, and replay only benign canonical keys.
    const safeSettings = inspectConfiguration(context, command[0], [], environment, true);
    const normalizedContext = [...executionContext, ...safeSettings];
    if ([...context, ...command].some(containsCredentials)
        || existsSync(`${environment.HOME ?? '/root'}/.netrc`)) {
        throw new Error('Unsupported Git authentication configuration');
    }
    const executionEnvironment = command[0] === 'clone' ? { ...environment, GIT_CONFIG_GLOBAL: '/dev/null' } : environment;
    // Project clone-local settings only for validation; they keep their local scope during execution.
    inspectConfiguration(normalizedContext, command[0], prepared.configuration, executionEnvironment);
    if (['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(command[0])) readToken();
    const result = spawnSync('/usr/bin/git', [...normalizedContext, '-c', 'credential.helper=', '-c',
        'credential.helper=/usr/local/bin/git-credential-github-app', '-c', 'credential.useHttpPath=true',
        '-c', 'core.askPass=', ...prepared.command], { stdio: 'inherit', env: executionEnvironment });
    process.exitCode = result.status ?? 1;
} catch (failure) {
    const messages = ['Unsupported Git global options', 'Unsupported Git clone options', 'Unsupported Git authentication configuration'];
    console.error(messages.includes(failure.message) ? failure.message : 'GitHub App credential unavailable');
    process.exitCode = 1;
}
