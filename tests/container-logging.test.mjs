import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/** Check the real preload against the pinned upstream filter without contacting services. */
test('console logs hide tokens and tool payloads while retaining connection guidance', () => {
    const result = spawnSync(process.execPath, [
        '--import', '/usr/local/lib/container-logging.mjs', '--input-type=module', '-e', `
        console.log('startup ready');
        console.log('PAT %s', process.env.GH_TOKEN);
        console.warn({ token: process.env.GH_TOKEN });
        console.error(new Error(process.env.GH_TOKEN));
        console.log('old generation ghs_OLD_SYNTHETIC_GENERATION');
        console.warn('new generation ghs_NEW_SYNTHETIC_GENERATION');
        console.log('prefixghs_PREFIX_SYNTHETIC_GENERATION');
        console.debug('debug-canary');
        console.log('🔧 Received tool call call-1: start_process {"command":"argument-canary"} metadata: {"private":"metadata-canary"}');
        console.log('✅ Tool call start_process completed:\\r\\n {"text":"result-canary"}');
        console.error('❌ Tool call start_process failed:', 'error-canary');
        console.log('   1. Verify this device in your browser:');
        console.log('      https://example.com/verify?code=ABCD-EFGH');
        console.log('      ABCD-EFGH');
        `,
    ], {
        env: { ...process.env, GH_TOKEN: 'synthetic-pat-canary', DEBUG_MODE: 'true' },
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.equal(result.status, 0);
    const output = result.stdout + result.stderr;
    for (const hidden of ['synthetic-pat-canary', 'argument-canary', 'metadata-canary',
        'result-canary', 'error-canary', 'debug-canary', 'ghs_OLD_SYNTHETIC_GENERATION',
        'ghs_NEW_SYNTHETIC_GENERATION', 'ghs_PREFIX_SYNTHETIC_GENERATION']) {
        assert.equal(output.includes(hidden), false, `${hidden} must be omitted`);
    }
    assert.match(output, /startup ready/);
    assert.match(output, /start_process completed/);
    assert.match(output, /start_process failed/);
    assert.match(output, /https:\/\/example.com\/verify\?code=ABCD-EFGH/);
    assert.match(output, /<redacted>/);
});
