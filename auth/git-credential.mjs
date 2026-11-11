#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { identity, readToken } from './token-file.mjs';

if (process.argv[2] === 'get') {
    try {
        const input = readFileSync(0, 'utf8');
        if (input.length > 16384) throw new Error();
        const fields = Object.fromEntries(input.trim().split('\n').map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)];
        }));
        if (fields.protocol !== 'https' || fields.host !== 'github.com'
            || ![identity.repository, `${identity.repository}.git`].includes(fields.path)
            || (fields.username && fields.username !== 'x-access-token')) throw new Error();
        process.stdout.write(`username=x-access-token\npassword=${readToken().token}\n\n`);
    } catch {
        process.stdout.write('quit=true\n\n');
        process.exitCode = 1;
    }
}
