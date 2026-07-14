/**
 * Test 01: Basic Lock Creation
 * 
 * Extracted from deploy-remix-price-lock-test.js Phase 1
 * Tests:
 * - Create lock with time-based unlock
 * - Create lock with price target
 * - Add tokens to existing lock
 * - Verify lock information
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
    assertBalance,
    reportTestResult,
    getCurrentTimestamp,
    ONE_MONTH,
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 01: BASIC LOCK CREATION\n', '\x1b[1m\x1b[36m');

    try {
        // Load shared state
        const state = loadSharedState();

        // Get wallets
        const deployer = await getWallet(0);
        const alice = await getWallet(1);

        // Get contracts
        const locker = await getContract('LockerContract', 0);
        const testToken = new ethers.Contract(
            state.contracts.TestToken,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function symbol() view returns (string)'],
            deployer
        );

        // Phase 1: Create First Lock
        const lockId = await testCreateLock(locker, testToken, alice, state.contracts.TestToken);

        // Phase 2: Add to Lock
        await testAddToLock(locker, testToken, alice, state.contracts.TestToken, lockId);

        // Phase 3: Verify Lock
        await testVerifyLock(locker, state.contracts.TestToken, lockId);

        reportTestResult('01-basic-lock', true);
        logSuccess('\n✅ TEST 01 PASSED!\n');

    } catch (error) {
        reportTestResult('01-basic-lock', false, error.message);
        throw error;
    }
}

// ============================================================================
// TEST PHASES
// ============================================================================

async function testCreateLock(locker, testToken, alice, tokenAddress) {
    logPhase(1, 'Create Lock with Time-based Unlock');

    const lockAmount = ethers.parseEther('10000'); // 10,000 tokens
    const unlockTime = await getCurrentTimestamp() + ONE_MONTH;

    logSection('Preparing Lock');
    log(`  Amount: ${ethers.formatEther(lockAmount)} tokens`);
    log(`  Unlock in: ${ONE_MONTH / 86400} days`);

    // Approve tokens
    const approveTx = await testToken.connect(alice).approve(await locker.getAddress(), lockAmount);
    await approveTx.wait();
    logSuccess('Tokens approved');

    // Create lock
    logSection('Creating Lock');

    // Build CreateLockParams struct
    const createLockParams = {
        token: tokenAddress,
        amount: lockAmount,
        lockDuration: unlockTime,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 0,
        priceDirection: 0,  // UPSIDE
        vestingTokensPerPeriod: 0,  // Vesting disabled
        vestingPeriodSeconds: 0,
        vestingAccumulate: false
    };

    const tx = await locker.connect(alice).createLock(createLockParams);

    const receipt = await tx.wait();
    logSuccess(`Lock created: ${receipt.hash}`);

    // Get LockManager interface to parse LockCreated event (emitted by LockManager, not LockerContract)
    const LockManagerFactory = await ethers.getContractFactory('LockManager');
    const lockManagerInterface = LockManagerFactory.interface;

    // Get lockId from LockCreated event
    const lockCreatedEvent = receipt.logs.find(log => {
        try {
            const parsed = lockManagerInterface.parseLog(log);
            return parsed && parsed.name === 'LockCreated';
        } catch (e) {
            return false;
        }
    });

    if (!lockCreatedEvent) {
        throw new Error('LockCreated event not found');
    }

    const parsedEvent = lockManagerInterface.parseLog(lockCreatedEvent);
    const lockId = parsedEvent.args[1]; // lockId is second arg
    log(`  Lock ID: ${lockId}`);

    const lockInfo = await locker.locks(lockId);

    // TokenLockBasic has: token, totalAmount, availableAmount, unlockTime, lockStartTime, withdrawn
    assertEqual(lockInfo.basic.token, tokenAddress, 'Token should match');
    assertEqual(lockInfo.basic.totalAmount, lockAmount, 'Total amount should match');
    assertEqual(lockInfo.basic.availableAmount, lockAmount, 'Available amount should match total');
    assert(lockInfo.basic.unlockTime > 0n, 'Unlock time should be set');

    logSuccess(`Lock #${lockId} created successfully`);

    return lockId; // Return for use in other tests
}

async function testAddToLock(locker, testToken, alice, tokenAddress, lockId) {
    logPhase(2, 'Add Tokens to Existing Lock');

    const addAmount = ethers.parseEther('20000'); // Add 20,000 more

    logSection('Getting Lock Info Before');
    const lockBefore = await locker.locks(lockId);
    log(`  Current amount: ${ethers.formatEther(lockBefore.basic.totalAmount)}`);
    log(`  Adding: ${ethers.formatEther(addAmount)}`);

    // Approve tokens
    const approveTx = await testToken.connect(alice).approve(await locker.getAddress(), addAmount);
    await approveTx.wait();
    logSuccess('Tokens approved');

    // Add to lock
    logSection('Adding to Lock');
    const tx = await locker.connect(alice).addToLock(lockId, addAmount, ethers.ZeroHash);
    await tx.wait();
    logSuccess(`Added ${ethers.formatEther(addAmount)} tokens`);

    // Verify
    const lockAfter = await locker.locks(lockId);
    const expectedAmount = lockBefore.basic.totalAmount + addAmount;

    assertEqual(lockAfter.basic.totalAmount, expectedAmount, 'Lock amount should increase');
    log(`  New total: ${ethers.formatEther(lockAfter.basic.totalAmount)}`);
}

async function testVerifyLock(locker, tokenAddress, lockId) {
    logPhase(3, 'Verify Lock Information');
    // First lock ID is 1

    // Get lock info
    const lockInfo = await locker.locks(lockId);

    logSection('Lock Details');
    log(`  Lock ID: ${lockId}`);
    log(`  Token: ${lockInfo.basic.token}`);
    log(`  Total Amount: ${ethers.formatEther(lockInfo.basic.totalAmount)}`);
    log(`  Available Amount: ${ethers.formatEther(lockInfo.basic.availableAmount)}`);
    log(`  Unlock Time: ${new Date(Number(lockInfo.basic.unlockTime) * 1000).toISOString()}`);
    log(`  Withdrawn: ${lockInfo.basic.withdrawn}`);

    // Verify totalAmount matches
    assert(lockInfo.basic.totalAmount > 0n, 'Total amount should be greater than 0');
    assert(lockInfo.basic.unlockTime > 0n, 'Unlock time should be set');
    assertEqual(lockInfo.basic.withdrawn, false, 'Should not be withdrawn yet');

    logSuccess('Lock information verified');
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
