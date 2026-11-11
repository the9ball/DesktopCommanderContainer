import { format } from 'node:util';
import { cleanLine } from '/usr/src/app/dist/remote-device/diagnostics/device-log.js';

// Apply the upstream private-log policy before console messages reach Docker.
for (const method of ['log', 'info', 'warn', 'error']) {
    const writeMessage = console[method].bind(console);

    /** Mask all accepted App-token generations before applying upstream private-log filtering. */
    console[method] = function logProtectedMessage(...argumentsToLog) {
        const message = format(...argumentsToLog);
        const token = process.env.GH_TOKEN;
        const environmentMasked = token ? message.split(token).join('<redacted>') : message;
        // Consumers accept only ghs_ tokens, so missed rotations and prior processes are covered.
        const maskedMessage = environmentMasked.replace(/(?:ghs_|ghp_|github_pat_)[A-Za-z0-9_]+/g, '<redacted>');
        // A completion message places the private result after its first newline.
        const firstLine = maskedMessage.trimStart().split(/\r?\n/, 1)[0];
        const line = cleanLine(firstLine);
        if (line) writeMessage(line);
    };
}

/** Suppress debug payloads even when DEBUG_MODE is enabled. */
console.debug = function discardDebugMessage() {};
