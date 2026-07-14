/**
 * Test 57: FullMath Edge Coverage
 *
 * FullMath.mulDiv (internal library, exercised directly via FullMathMock):
 *   A1. Exact values on the fast path (prod1 == 0): truncation, zero operand,
 *       denominator 1, maxUint/2.
 *   A2. Exact values on the 512-bit path (prod1 > 0): 2^128 boundaries,
 *       maxUint identities, odd-denominator inverse, just-above-overflow boundary.
 *   A3. Division by zero → BARE revert (require without reason string) on both paths.
 *   A4. 512-bit overflow (denominator <= prod1, strict boundary) → BARE revert.
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

// ============================================================================
// Error-inspection helpers
// ============================================================================

function extractErrorText(e) {
    const parts = [];
    let cur = e;
    for (let depth = 0; cur && depth < 5; depth++) {
        if (cur.shortMessage) parts.push(cur.shortMessage);
        if (cur.message) parts.push(cur.message);
        if (typeof cur.data === 'string') parts.push(cur.data);
        if (cur.info) {
            try { parts.push(JSON.stringify(cur.info)); } catch { /* ignore */ }
        }
        cur = cur.error;
    }
    return parts.join(' | ');
}

/**
 * Asserts that `promise` reverts WITHOUT any reason string / custom error /
 * panic — i.e. a bare `require(cond);` (empty revert data), which is what
 * FullMath.mulDiv uses (`require(denominator > 0);` / `require(denominator > prod1);`).
 */
async function expectBareRevert(promise, label) {
    let result;
    try {
        result = await promise;
    } catch (e) {
        const text = extractErrorText(e);
        if (/reverted with reason string/i.test(text)) {
            throw new Error(`${label}: expected BARE revert, got reason string: ${text}`);
        }
        if (/custom error/i.test(text)) {
            throw new Error(`${label}: expected BARE revert, got custom error: ${text}`);
        }
        if (/panic/i.test(text)) {
            throw new Error(`${label}: expected BARE revert, got panic: ${text}`);
        }
        const emptyData = e.data === '0x' || e.data === null || e.data === undefined;
        const bareMessage = /without a reason|missing revert data/i.test(text);
        const looksLikeRevert = /revert/i.test(text) || e.code === 'CALL_EXCEPTION';
        if (!looksLikeRevert) {
            throw new Error(`${label}: unexpected non-revert error: ${text}`);
        }
        assert(
            emptyData || bareMessage,
            `${label}: revert should carry no data (bare require). Got: ${text}`
        );
        logSuccess(`${label}: bare revert (no reason string) as expected`);
        return;
    }
    throw new Error(`${label}: expected bare revert, but call succeeded (${result})`);
}

// ============================================================================
// Constants
// ============================================================================

const MAX = 2n ** 256n - 1n;
const Q128 = 2n ** 128n;

async function main() {
    log('\n🧪 TEST 57: FULLMATH EDGES\n', '\x1b[1m\x1b[36m');

    let passed = 0, failed = 0;

    try {
        // ====================================================================
        // FullMath.mulDiv via FullMathMock
        // ====================================================================
        logPhase('A', 'FullMath.mulDiv — exact values & revert paths');

        logSection('Deploying FullMathMock');
        const MockFactory = await ethers.getContractFactory('FullMathMock');
        const fullMath = await MockFactory.deploy();
        await fullMath.waitForDeployment();
        logSuccess(`FullMathMock: ${await fullMath.getAddress()}`);

        // A1 + A2 — exact value triples (expected computed with arbitrary-
        // precision BigInt: floor(a*b/den), all operands non-negative)
        try {
            logSection('A1/A2 — Exact value triples');
            const vectors = [
                // [a, b, denominator, description] — fast path (prod1 == 0)
                [7n, 3n, 2n, 'truncation: floor(21/2) = 10'],
                [10n, 10n, 3n, 'truncation: floor(100/3) = 33'],
                [0n, MAX, 5n, 'zero operand: 0'],
                [123456789n, 987654321n, 1n, 'denominator 1: exact product'],
                [MAX, 1n, 2n, 'maxUint/2: 2^255 - 1'],
                // 512-bit path (prod1 > 0)
                [Q128, Q128, Q128, '(2^128 * 2^128) / 2^128 = 2^128'],
                [Q128, Q128, 2n, '(2^256) / 2 = 2^255'],
                [MAX, MAX, MAX, 'max identity: max'],
                [MAX, MAX - 1n, MAX, 'max * (max-1) / max = max - 1'],
                [Q128 + 1n, Q128 + 1n, Q128 + 2n, '512-bit truncation'],
                [2n ** 200n, 2n ** 200n, 3n * 2n ** 150n, 'odd-factor denominator (inverse path)'],
                [2n ** 200n, 2n ** 200n, 2n ** 144n + 1n, 'just above overflow boundary (denominator = prod1 + 1)']
            ];

            for (const [a, b, den, desc] of vectors) {
                const expected = (a * b) / den; // BigInt floor division
                const got = await fullMath.mulDiv(a, b, den);
                assertEqual(got, expected, `mulDiv ${desc}`);
            }

            // Pin the headline boundary identities explicitly
            assertEqual(await fullMath.mulDiv(Q128, Q128, Q128), Q128, 'mulDiv(2^128, 2^128, 2^128) == 2^128');
            assertEqual(await fullMath.mulDiv(MAX, MAX, MAX), MAX, 'mulDiv(max, max, max) == max');
            assertEqual(await fullMath.mulDiv(MAX, 1n, 2n), 2n ** 255n - 1n, 'mulDiv(max, 1, 2) == 2^255 - 1');
            assertEqual(await fullMath.mulDiv(7n, 3n, 2n), 10n, 'mulDiv(7, 3, 2) == 10');
            passed++;
        } catch (e) { log(`  ❌ A1/A2 FAILED: ${e.message}`); failed++; }

        // A3 — division by zero: bare require (no reason string) on both paths
        try {
            logSection('A3 — Division by zero reverts (bare require)');
            // prod1 == 0 path: require(denominator > 0) — bare
            await expectBareRevert(fullMath.mulDiv(7n, 3n, 0n), 'mulDiv(7, 3, 0)');
            // prod1 > 0 path: require(denominator > prod1) with denominator 0 — bare
            await expectBareRevert(fullMath.mulDiv(Q128, Q128, 0n), 'mulDiv(2^128, 2^128, 0)');
            passed++;
        } catch (e) { log(`  ❌ A3 FAILED: ${e.message}`); failed++; }

        // A4 — 512-bit overflow: denominator <= prod1 → bare revert (strict >)
        try {
            logSection('A4 — 512-bit overflow reverts (denominator <= prod1)');
            // 2^128 * 2^128 = 2^256 → prod1 = 1; denominator 1 == prod1 → revert
            await expectBareRevert(fullMath.mulDiv(Q128, Q128, 1n), 'mulDiv(2^128, 2^128, 1)');
            // max * max → prod1 = max - 1; denominator max - 1 == prod1 → revert
            await expectBareRevert(fullMath.mulDiv(MAX, MAX, MAX - 1n), 'mulDiv(max, max, max-1)');
            // 2^200 * 2^200 = 2^400 → prod1 = 2^144; denominator == prod1 → revert
            await expectBareRevert(fullMath.mulDiv(2n ** 200n, 2n ** 200n, 2n ** 144n), 'mulDiv(2^200, 2^200, 2^144)');
            passed++;
        } catch (e) { log(`  ❌ A4 FAILED: ${e.message}`); failed++; }

        // ====================================================================
        // Summary
        // ====================================================================
        log(`\n${'='.repeat(80)}`, '\x1b[36m');
        log(`RESULTS: ${passed}/${passed + failed} scenarios PASSED`, '\x1b[1m\x1b[36m');
        log('='.repeat(80), '\x1b[36m');

        if (failed > 0) {
            reportTestResult('57-fullmath-edges', false, `${failed} scenario(s) failed`);
            throw new Error(`${failed} scenario(s) failed`);
        }
        reportTestResult('57-fullmath-edges', true);
        log('\n🎉 TEST 57 PASSED: FullMath edges fully covered!\n', '\x1b[1m\x1b[32m');

    } catch (error) {
        if (!error.message.includes('scenario(s) failed')) {
            reportTestResult('57-fullmath-edges', false, error.message);
        }
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error.message);
        process.exit(1);
    });
