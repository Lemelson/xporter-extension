'use strict';

// Test-only helpers: read a generated XLSX (ZIP) and check that each XML part
// is well-formed XML 1.0. Deliberately strict and dependency-free.
const zlib = require('node:zlib');

function readZipEntries(bytes) {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (endOffset < 0) throw new Error('ZIP end-of-central-directory record is missing');
    const entryCount = buffer.readUInt16LE(endOffset + 10);
    let offset = buffer.readUInt32LE(endOffset + 16);
    const entries = new Map();
    for (let index = 0; index < entryCount; index++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory header');
        const method = buffer.readUInt16LE(offset + 10);
        const crc = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
        if (buffer.readUInt16LE(localOffset + 8) !== method) throw new Error(`method mismatch for ${name}`);
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) +
            buffer.readUInt16LE(localOffset + 28);
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error(`unsupported ZIP method ${method} for ${name}`);
        if (data.length !== size) throw new Error(`size mismatch for ${name}`);
        if ((zlib.crc32 ? zlib.crc32(data) : crc) >>> 0 !== crc) throw new Error(`CRC mismatch for ${name}`);
        entries.set(name, { method, compressedSize, size, data });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

// XML 1.0 Char production, applied to the decoded text.
const INVALID_XML_CHAR = /[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/u;
const NAME = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?$/;

/**
 * Throw unless `bytes` is a well-formed standalone XML document: valid UTF-8,
 * only XML Chars, balanced/nested elements, quoted unique attributes, and
 * only predefined or numeric character references.
 */
function assertWellFormedXml(bytes, label = 'XML part') {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
        throw new Error(`${label}: invalid UTF-8`);
    }
    const bad = text.match(INVALID_XML_CHAR);
    if (bad) {
        throw new Error(`${label}: invalid XML character U+${bad[0].codePointAt(0).toString(16).toUpperCase()}`);
    }
    const checkText = (value, where) => {
        if (value.includes('<')) throw new Error(`${label}: raw "<" in ${where}`);
        for (const match of value.matchAll(/&([^;]*);?/g)) {
            const ref = match[0];
            if (!/^&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);$/.test(ref)) {
                throw new Error(`${label}: bad reference ${JSON.stringify(ref)} in ${where}`);
            }
            if (ref.startsWith('&#')) {
                const code = ref[2] === 'x' ? parseInt(ref.slice(3, -1), 16) : parseInt(ref.slice(2, -1), 10);
                if (INVALID_XML_CHAR.test(String.fromCodePoint(code))) {
                    throw new Error(`${label}: reference to invalid character ${ref}`);
                }
            }
        }
    };

    let position = 0;
    if (text.startsWith('<?xml')) {
        const end = text.indexOf('?>');
        if (end < 0) throw new Error(`${label}: unterminated XML declaration`);
        position = end + 2;
    }
    const stack = [];
    let rootSeen = false;
    while (position < text.length) {
        const open = text.indexOf('<', position);
        const chunk = text.slice(position, open < 0 ? text.length : open);
        if (stack.length === 0 && chunk.trim()) throw new Error(`${label}: text outside the root element`);
        checkText(chunk, 'text');
        if (open < 0) break;
        const close = text.indexOf('>', open);
        if (close < 0) throw new Error(`${label}: unterminated tag`);
        const tag = text.slice(open + 1, close);
        position = close + 1;
        if (tag.startsWith('/')) {
            const name = tag.slice(1).trim();
            if (stack.pop() !== name) throw new Error(`${label}: mismatched </${name}>`);
            continue;
        }
        if (tag.startsWith('?') || tag.startsWith('!')) throw new Error(`${label}: unexpected <${tag.slice(0, 10)}`);
        const selfClosing = tag.endsWith('/');
        const body = selfClosing ? tag.slice(0, -1) : tag;
        const name = body.match(/^[^\s]+/)?.[0] || '';
        if (!NAME.test(name)) throw new Error(`${label}: bad element name ${JSON.stringify(name)}`);
        let rest = body.slice(name.length);
        const attributes = new Set();
        const attributePattern = /^\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/;
        while (rest.trim()) {
            const match = rest.match(attributePattern);
            if (!match) throw new Error(`${label}: malformed attributes on <${name}>`);
            if (!NAME.test(match[1])) throw new Error(`${label}: bad attribute name ${match[1]}`);
            if (attributes.has(match[1])) throw new Error(`${label}: duplicate attribute ${match[1]}`);
            attributes.add(match[1]);
            checkText(match[3] ?? match[4], `attribute ${match[1]}`);
            rest = rest.slice(match[0].length);
        }
        if (stack.length === 0) {
            if (rootSeen) throw new Error(`${label}: more than one root element`);
            rootSeen = true;
        }
        if (!selfClosing) stack.push(name);
    }
    if (!rootSeen) throw new Error(`${label}: no root element`);
    if (stack.length) throw new Error(`${label}: unclosed <${stack.pop()}>`);
}

function assertXlsxPartsWellFormed(bytes) {
    const entries = readZipEntries(bytes);
    for (const [name, entry] of entries) {
        if (/\.(xml|rels)$/.test(name)) assertWellFormedXml(entry.data, name);
    }
    return entries;
}

module.exports = { readZipEntries, assertWellFormedXml, assertXlsxPartsWellFormed };
