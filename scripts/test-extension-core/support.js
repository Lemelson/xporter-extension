'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

function source(file) {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

module.exports = { source };
