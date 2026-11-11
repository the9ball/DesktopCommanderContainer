import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const identity = Object.freeze({
    app_id: 5706210,
    installation_id: 180730871,
    repository: 'the9ball/DesktopCommanderContainer',
});
export const tokenPath = '/run/github-app-token/token.json';
export const permissions = Object.freeze({ contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' });

/** Validate a regular root-owned secret with no group or other access. */
export function validateSecretFile(status) {
    if (!status.isFile() || status.uid !== 0 || status.gid !== 0 || (status.mode & 0o777) !== 0o600 || status.size > 16384) {
        throw new Error('Invalid secret file protection');
    }
}

/** Read one immutable generation, refusing unsafe paths, scope, format and near-expiry tokens. */
export function readToken(filePath = tokenPath, now = Date.now()) {
    let descriptor;
    try {
        const directory = lstatSync(dirname(filePath));
        if (!directory.isDirectory() || directory.uid !== 0 || directory.gid !== 0 || (directory.mode & 0o777) !== 0o700) throw new Error();
        descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        validateSecretFile(fstatSync(descriptor));
        const document = JSON.parse(readFileSync(descriptor, 'utf8'));
        if (Object.entries(identity).some(([key, value]) => document[key] !== value)
            || !/^ghs_[A-Za-z0-9_]+$/.test(document.token)
            || !Number.isFinite(Date.parse(document.expires_at))
            || Date.parse(document.expires_at) <= now + 60000
            || Date.parse(document.expires_at) > now + 3660000
            || Object.keys(document.permissions ?? {}).length !== Object.keys(permissions).length
            || Object.entries(permissions).some(([key, value]) => document.permissions?.[key] !== value)) throw new Error();
        return document;
    } catch {
        throw new Error('GitHub App credential unavailable');
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

/** Remove inherited credentials, tracing and configuration overrides from command environments. */
export function commandEnvironment(environment = process.env) {
    return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_DEBUG|GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG.*)$/.test(key)));
}
