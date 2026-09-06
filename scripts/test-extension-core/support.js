'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

function source(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

async function withTimeout(run, label, milliseconds = 30_000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(run),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { source, withTimeout };
