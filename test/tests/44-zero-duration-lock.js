/**
 * Test 44: Zero-Duration Lock
 *
 * Verifies that a lockDuration of 0 is honored literally and produces a lock
 * that is immediately time-unlockable.
 *
 *   Z1. lockDuration = 0 → unlockTime == lockStartTime, getLockStatus().timeOk == true now
 *   Z2. lockDuration = 3600 → NOT immediately time-unlockable (control case)
 */

import {
    loadSharedState,
    getContract,
    getWallet,
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

function baseParams(tokenAddress, amount, lockDuration) {
    return {
        token: tokenAddress,
        amount,
        lockDuration,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 0,
        priceDirection: 0,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false
    };
}

async function main() {
    log('\n🧪 TEST 44: ZERO-DURATION LOCK\n', '\x1b[1m\x1b[36m');

    const state = loadSharedState();
    const deployer = await getWallet(0);
    const alice = await getWallet(1);

    const locker = await getContract('LockerContract', 0);
    const lockManager = await ethers.getContractAt('LockManager', await locker.lockManager());
    const testToken = new ethers.Contract(
        state.contracts.TestToken,
        ['function approve(address,uint256) returns (bool)'],
        deployer
    );

    let passed = 0, failed = 0;

    // Z1 — duration 0 is honored and the lock is immediately time-unlockable
    try {
        logPhase(1, 'Z1 — lockDuration = 0 is immediately time-unlockable');
        const amount = ethers.parseEther('1000');
        await (await testToken.connect(alice).approve(await locker.getAddress(), amount)).wait();

        const lockId = await lockManager.nextLockId();
        await (await locker.connect(alice).createLock(baseParams(state.contracts.TestToken, amount, 0))).wait();

        const lockInfo = await locker.locks(lockId);
        logSection('Lock timing');
        log(`  lockStartTime: ${lockInfo.basic.lockStartTime}`);
        log(`  unlockTime:    ${lockInfo.basic.unlockTime}`);

        // With duration 0, unlockTime must equal lockStartTime (no 1h default applied).
        assertEqual(
            lockInfo.basic.unlockTime,
            lockInfo.basic.lockStartTime,
            'unlockTime should equal lockStartTime for a 0-duration lock'
        );

        const status = await locker.getLockStatus(lockId);
        log(`  timeOk: ${status.timeOk} (should be true)`);
        assertEqual(status.timeOk, true, 'A 0-duration lock must be time-unlockable immediately');

        logSuccess('Z1 — zero-duration lock is immediately time-unlockable');
        passed++;
    } catch (e) { log(`  ❌ Z1 FAILED: ${e.message}`); failed++; }

    // Z2 — control: a 3600s lock is NOT immediately time-unlockable
    try {
        logPhase(2, 'Z2 — control: lockDuration = 3600 is NOT immediately unlockable');
        const amount = ethers.parseEther('1000');
        await (await testToken.connect(alice).approve(await locker.getAddress(), amount)).wait();

        const lockId = await lockManager.nextLockId();
        await (await locker.connect(alice).createLock(baseParams(state.contracts.TestToken, amount, 3600))).wait();

        const lockInfo = await locker.locks(lockId);
        assert(
            lockInfo.basic.unlockTime > lockInfo.basic.lockStartTime,
            'unlockTime should be in the future for a 3600s lock'
        );
        assertEqual(
            lockInfo.basic.unlockTime - lockInfo.basic.lockStartTime,
            3600n,
            'Duration should be exactly 3600s (passed value honored)'
        );

        const status = await locker.getLockStatus(lockId);
        log(`  timeOk: ${status.timeOk} (should be false)`);
        assertEqual(status.timeOk, false, 'A 3600s lock must NOT be time-unlockable immediately');

        logSuccess('Z2 — non-zero duration still enforced correctly');
        passed++;
    } catch (e) { log(`  ❌ Z2 FAILED: ${e.message}`); failed++; }

    log('\n' + '═'.repeat(70), '\x1b[1m\x1b[36m');
    log(`RESULTS: ${passed}/${passed + failed} scenarios PASSED`, '\x1b[1m\x1b[36m');
    log('═'.repeat(70), '\x1b[1m\x1b[36m');

    if (failed > 0) {
        reportTestResult('44-zero-duration-lock', false, `${failed} scenario(s) failed`);
        throw new Error(`${failed} scenario(s) failed`);
    }
    reportTestResult('44-zero-duration-lock', true);
    logSuccess('\n✅ TEST 44 PASSED — zero-duration lock verified!\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
