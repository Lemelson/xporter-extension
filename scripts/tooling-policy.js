const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_RUNTIME_SUFFIX = path.join(
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'bin',
    'override',
    'soffice'
);

function isCodexSandbox(env = process.env) {
    return Boolean(env.CODEX_SANDBOX);
}

function assertBrowserSmokeCanLaunch(env = process.env) {
    if (!isCodexSandbox(env)) return;

    const error = new Error(
        'Refusing to launch Playwright Chromium inside CODEX_SANDBOX: macOS aborts ' +
        'the browser while registering it with LaunchServices. Run this command through ' +
        'an approved unsandboxed Codex exec (sandbox_permissions=require_escalated), ' +
        'or from a normal Terminal session.'
    );
    error.code = 'CODEX_SANDBOX_BROWSER_BLOCKED';
    throw error;
}

function resolveSofficeExecutable({
    env = process.env,
    homeDir = os.homedir(),
    existsSync = fs.existsSync
} = {}) {
    const runtimeSoffice = path.join(homeDir, CODEX_RUNTIME_SUFFIX);
    const pathCandidates = (env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .map(directory => path.join(directory, 'soffice'));
    const candidates = [
        env.XPORTER_SOFFICE_EXECUTABLE,
        runtimeSoffice,
        ...pathCandidates
    ].filter(candidate => candidate && existsSync(candidate));

    if (isCodexSandbox(env)) {
        return candidates.find(candidate => candidate.includes('/.cache/codex-runtimes/')) || null;
    }

    return candidates[0] || null;
}

module.exports = {
    assertBrowserSmokeCanLaunch,
    isCodexSandbox,
    resolveSofficeExecutable
};
