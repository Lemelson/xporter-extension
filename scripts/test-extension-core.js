#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const suiteManifest = require('./test-extension-core/suite-manifest.js');

function validateManifest(manifest) {
    assert(Array.isArray(manifest) && manifest.length > 0,
        'core test suite manifest must be a non-empty array');
    const ids = new Set();
    const modules = new Set();
    for (const entry of manifest) {
        assert(entry && typeof entry === 'object' && !Array.isArray(entry),
            'each core test suite manifest entry must be an object');
        assert.equal(typeof entry.id, 'string', 'suite manifest id must be a string');
        assert(entry.id.trim(), 'suite manifest id must not be empty');
        assert.equal(typeof entry.module, 'string', `${entry.id} module must be a string`);
        assert(entry.module.trim(), `${entry.id} module must not be empty`);
        assert(!ids.has(entry.id), `duplicate core test suite id: ${entry.id}`);
        assert(!modules.has(entry.module), `duplicate core test suite module: ${entry.module}`);
        ids.add(entry.id);
        modules.add(entry.module);
    }
}

function declaredTestNames(modulePath) {
    const suiteSource = fs.readFileSync(modulePath, 'utf8');
    return [...suiteSource.matchAll(/^(?:async\s+)?function\s+(test\w+)\s*\(/gm)]
        .map(match => match[1]);
}

function validateSuiteExport(entry, suiteExport, declaredNames) {
    assert(suiteExport && typeof suiteExport === 'object' && !Array.isArray(suiteExport),
        `${entry.id} must export an object`);
    assert.equal(suiteExport.id, entry.id,
        `${entry.id} suite export id must match the manifest`);
    assert(Array.isArray(suiteExport.tests) && suiteExport.tests.length > 0,
        `${entry.id} must export a non-empty tests array`);

    const exportedFunctionNames = [];
    for (const test of suiteExport.tests) {
        assert(test && typeof test === 'object' && !Array.isArray(test),
            `${entry.id} test exports must be objects`);
        assert.equal(typeof test.name, 'string', `${entry.id} test name must be a string`);
        assert(test.name.trim(), `${entry.id} test name must not be empty`);
        assert.equal(typeof test.run, 'function', `${entry.id} ${test.name} must export a run function`);
        assert(Number.isInteger(test.order) && test.order >= 0,
            `${entry.id} ${test.name} must export a non-negative integer order`);
        exportedFunctionNames.push(test.run.name);
    }

    assert.deepEqual(
        [...exportedFunctionNames].sort(),
        [...declaredNames].sort(),
        `${entry.id} must export every declared top-level test function exactly once`
    );
    return suiteExport.tests;
}

function assertUniqueTests(tests) {
    const names = new Set();
    const functions = new Set();
    const orders = new Set();
    for (const test of tests) {
        assert(!names.has(test.name), `duplicate core test name: ${test.name}`);
        assert(!functions.has(test.run), `core test function exported more than once: ${test.run.name}`);
        assert(!orders.has(test.order), `duplicate core test order: ${test.order}`);
        names.add(test.name);
        functions.add(test.run);
        orders.add(test.order);
    }
    const expectedOrders = Array.from({ length: tests.length }, (_, index) => index);
    assert.deepEqual([...orders].sort((left, right) => left - right), expectedOrders,
        'core test orders must form one contiguous zero-based sequence');
}

function runGuardSelfChecks() {
    function testOne() {}
    function testTwo() {}
    const entry = { id: 'guard-fixture', module: './guard-fixture.js' };
    const validOne = { name: 'one', run: testOne, order: 0 };

    assert.throws(
        () => validateManifest([entry, { ...entry }]),
        /duplicate core test suite id/
    );
    assert.throws(
        () => validateSuiteExport(entry, null, []),
        /must export an object/
    );
    assert.throws(
        () => validateSuiteExport(entry, { id: entry.id, tests: [validOne] }, ['testOne', 'testTwo']),
        /must export every declared top-level test function exactly once/
    );
    assert.throws(
        () => assertUniqueTests([validOne, { name: 'one', run: testTwo, order: 1 }]),
        /duplicate core test name/
    );
    assert.throws(
        () => assertUniqueTests([validOne, { name: 'two', run: testOne, order: 1 }]),
        /core test function exported more than once/
    );
    assert.throws(
        () => assertUniqueTests([validOne, { name: 'two', run: testTwo, order: 0 }]),
        /duplicate core test order/
    );
}

function loadTests(manifest) {
    validateManifest(manifest);
    const tests = [];
    for (const entry of manifest) {
        const modulePath = require.resolve(entry.module);
        const suiteExport = require(entry.module);
        tests.push(...validateSuiteExport(entry, suiteExport, declaredTestNames(modulePath)));
    }
    assertUniqueTests(tests);
    return tests.sort((left, right) => left.order - right.order);
}

(async () => {
    runGuardSelfChecks();
    const tests = loadTests(suiteManifest);
    const failures = [];
    let executed = 0;
    for (const test of tests) {
        try {
            await test.run();
            console.log(`PASS ${test.name}`);
        } catch (error) {
            failures.push({ name: test.name, error });
            console.error(`FAIL ${test.name}: ${error.message}`);
        } finally {
            executed += 1;
        }
    }
    assert.equal(executed, tests.length, 'core runner must execute every aggregated test');
    if (failures.length > 0) {
        console.error(`Extension core tests failed (${executed} tests executed, ${failures.length} failed)`);
        process.exitCode = 1;
    } else {
        console.log(`Extension core tests passed (${executed} tests)`);
    }
})();
