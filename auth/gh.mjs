#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { commandEnvironment, readToken } from './token-file.mjs';

try {
    const document = readToken();
    const result = spawnSync('/usr/bin/gh', process.argv.slice(2), {
        stdio: 'inherit', env: { ...commandEnvironment(), GH_TOKEN: document.token,
            GH_HOST: 'github.com', GH_CONFIG_DIR: '/usr/local/share/github-app/gh-config',
            PATH: `/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` },
    });
    process.exitCode = result.status ?? 1;
} catch {
    console.error('GitHub App credential unavailable');
    process.exitCode = 1;
}
