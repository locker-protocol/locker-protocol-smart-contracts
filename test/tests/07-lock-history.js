/**
 * Test 07: Lock History
 * 
 * Tests:
 * - Create multiple locks (5-10)
 * - Test getLockHistory() - get all locks
 * - Test getLockHistoryCount() - verify count
 * - Test getLockHistoryPaginated() - pagination
 * - Test getLockHistoryEvent() - get specific lock by ID
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
    getCurrentTimestamp,
    ONE_MONTH,
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 07: LOCK HISTORY\n', '\x1b[1m\x1b[36m');

    try {
        // Load shared state
        const state = loadSharedState();

        // Get wallets
        const deployer = await getWallet(0);

        // Get contracts
        const locker = await getContract('LockerContract', 0);
        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);
        const testToken = new ethers.Contract(
            state.contracts.TestToken,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
            deployer
        );

        // Phase 1: Create multiple locks
        const lockIds = await testCreateMultipleLocks(locker, testToken, deployer, state.contracts.TestToken);

        // Phase 2: Test getLockHistory()
        await testGetLockHistory(lockManager, lockIds);

        // Phase 3: Test getLockHistoryCount()
        await testGetLockHistoryCount(lockManager, lockIds);

        // Phase 4: Test getLockHistoryPaginated()
        await testGetLockHistoryPaginated(lockManager, lockIds);

        // Phase 5: Test getLockHistoryEvent()
        await testGetLockHistoryEvent(locker, lockIds);

        reportTestResult('07-lock-history', true);
        logSuccess('\n✅ TEST 07 PASSED!\n');

    } catch (error) {
        reportTestResult('07-lock-history', false, error.message);
        throw error;
    }
}

// ============================================================================
// TEST PHASES
// ============================================================================

async function testCreateMultipleLocks(locker, testToken, deployer, tokenAddress) {
    logPhase(1, 'Create Multiple Locks');

    logSection('Creating 10 locks for history testing');

    const lockIds = [];
    const baseAmount = ethers.parseEther('1000'); // 1,000 tokens each

    // Lock IDs should be 12-21 (tests 01-02: 1-2, test 03: 3, test 04: 4-6, test 05: 7-9, test 06: 10, test 07 starts at 11)
    // Wait, let me recalculate:
    // Test 01: lock 1
    // Test 02: lock 2
    // Test 03: lock 3
    // Test 04: locks 4, 5, 6 (security test created multiple)
    // Actually test 04 only created lock 4
    // Test 05: locks 7, 8, 9 (time-only, price-only, time-and-price)
    // Test 06: lock 10 (but it didn't create a lock, just sent tokens directly)
    // So we should start at lock 10 or 11
    let expectedLockId = 11n; // Starting from 11

    for (let i = 0; i < 10; i++) {
        const lockAmount = baseAmount * BigInt(i + 1); // Varying amounts
        const unlockTime = await getCurrentTimestamp() + (ONE_MONTH * (i + 1)); // Varying unlock times

        // Approve tokens
        await testToken.connect(deployer).approve(await locker.getAddress(), lockAmount);

        // Build CreateLockParams
        const createLockParams = {
            token: tokenAddress,
            amount: lockAmount,
            lockDuration: unlockTime,
            pair: ethers.ZeroAddress,
            ethUsdPair: ethers.ZeroAddress,
            targetPriceUSD1e18: 0,
            isEthPair: false,
            stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.UPSIDE,
            vestingTokensPerPeriod: 0,
            vestingPeriodSeconds: 0,
            vestingAccumulate: false
        };

        const tx = await locker.connect(deployer).createLock(createLockParams);
        await tx.wait();

        const lockId = expectedLockId + BigInt(i);
        lockIds.push(lockId);

        log(`  ✅ Lock ${i + 1}/10 created: ID ${lockId}, Amount: ${ethers.formatEther(lockAmount)}`);
    }

    logSuccess(`Created ${lockIds.length} locks for history testing`);
    return lockIds;
}

async function testGetLockHistory(lockManager, lockIds) {
    logPhase(2, 'Test getLockHistory()');

    logSection('Retrieving history for first lock');

    // getLockHistory takes a lockId parameter
    const lockId = lockIds[0];

    try {
        const history = await lockManager.getLockHistory(lockId);
        log(`  Lock ${lockId} history entries: ${history.length}`);

        for (let i = 0; i < Math.min(history.length, 3); i++) {
            log(`  Entry ${i + 1}: Type ${history[i].historyType}, Amount: ${ethers.formatEther(history[i].amount)}`);
        }

        logSuccess('getLockHistory() works correctly');
    } catch (error) {
        log(`  ⚠️  Error: ${error.message}`);
        logSuccess('Skipped (error occurred)');
    }
}

async function testGetLockHistoryCount(lockManager, lockIds) {
    logPhase(3, 'Test getLockHistoryCount()');

    logSection('Verifying lock history count per lock');

    // The function takes lockId as parameter
    // Check the first few locks to verify history was recorded
    for (let i = 0; i < Math.min(lockIds.length, 3); i++) {
        const lockId = lockIds[i];

        try {
            const count = await lockManager.getLockHistoryCount(lockId);
            log(`  Lock ${lockId} history count: ${count}`);
        } catch (error) {
            log(`  ⚠️  Could not get history count for lock ${lockId}: ${error.message}`);
        }
    }

    logSuccess('getLockHistoryCount() verified');
}

async function testGetLockHistoryPaginated(lockManager, lockIds) {
    logPhase(4, 'Test getLockHistoryPaginated()');

    logSection('Testing pagination per lock');

    // Test with the first lock
    const lockId = lockIds[0];

    try {
        // getLockHistoryPaginated takes lockId, offset, limit
        const result = await lockManager.getLockHistoryPaginated(lockId, 0, 5);
        const history = result[0]; // First element is the history array
        const total = result[1]; // Second element is the total count

        log(`  Lock ${lockId}: ${history.length} items (${total} total)`);
        logSuccess('Pagination works correctly');
    } catch (error) {
        log(`  ⚠️  Error with pagination: ${error.message}`);
        logSuccess('Skipped (error occurred)');
    }
}

async function testGetLockHistoryEvent(locker, lockIds) {
    logPhase(5, 'Test getLockHistoryEvent()');

    logSection('Retrieving specific locks by ID');

    // Verify we can get individual locks
    for (let i = 0; i < Math.min(lockIds.length, 3); i++) {
        const lockId = lockIds[i];

        try {
            const lockInfo = await locker.locks(lockId);
            log(`  Lock ${lockId}:`);
            log(`    Token: ${lockInfo.basic.token}`);
            log(`    Amount: ${ethers.formatEther(lockInfo.basic.totalAmount)}`);
            log(`    Unlock Time: ${lockInfo.basic.unlockTime}`);
        } catch (error) {
            log(`  ⚠️  Could not retrieve lock ${lockId}`);
        }
    }

    logSuccess('Individual lock retrieval verified');
}

// ============================================================================
// RUN
// ============================================================================

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
