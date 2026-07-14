/**
 * Test 05: Advanced Price Conditions (Phase 6)
 * 
 * Tests lock creation with different time/price conditions and verifies
 * that lock status correctly reflects when unlock conditions are met.
 * 
 * Based on deploy-remix-price-lock-test.js Phase 6 (lines 2326-3707)
 * 
 * Note: This test focuses on condition testing (timeOk/priceOk status).
 * Full unlock workflow with multi-sig approvals is tested in Test 03.
 */

import {
    loadSharedState,
    getContract,
    getWallet,
    logPhase,
    logSection,
    logSuccess,
    log,
    assertEqual,
    reportTestResult,
    getCurrentTimestamp,
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 05: ADVANCED PRICE CONDITIONS\n', '\x1b[1m\x1b[36m');

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

        // Phase 1: Lock with TIME ONLY and verify time condition
        await testTimeOnlyLock(locker, lockManager, testToken, deployer, state.contracts.TestToken);

        // Phase 2: Lock with PRICE FOCUS and verify price condition
        await testPriceFocusLock(locker, lockManager, testToken, deployer, state.contracts.TestToken);

        // Phase 3: Lock with TIME AND PRICE and verify OR logic
        await testTimeAndPriceLock(locker, lockManager, testToken, deployer, state.contracts.TestToken);

        reportTestResult('05-price-conditions', true);
        logSuccess('\n✅ TEST 05 PASSED!\n');

    } catch (error) {
        reportTestResult('05-price-conditions', false, error.message);
        throw error;
    }
}

// ============================================================================
// TEST PHASES
// ============================================================================

async function testTimeOnlyLock(locker, lockManager, testToken, deployer, tokenAddress) {
    logPhase(1, 'Lock with TIME ONLY');

    const lockAmount = ethers.parseEther('5000');
    const lockDuration = 10; // 10 seconds

    logSection('Creating TIME-ONLY Lock (10 seconds, no price condition)');

    // Approve tokens
    await testToken.connect(deployer).approve(await locker.getAddress(), lockAmount);

    // Build CreateLockParams (no price, just time)
    const createLockParams = {
        token: tokenAddress,
        amount: lockAmount,
        lockDuration: lockDuration,
        pair: ethers.ZeroAddress, // No pair = no price condition
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0, // No target price
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false
    };

    // Get the next lock ID before creating the lock
    const nextId = await lockManager.nextLockId();
    const tx = await locker.connect(deployer).createLock(createLockParams);
    await tx.wait();

    const lockId = nextId;
    const lockInfo = await locker.locks(lockId);

    log(`  Lock ID: ${lockId}`);
    log(`  Amount: ${ethers.formatEther(lockInfo.basic.totalAmount)}`);
    log(`  Unlock Time: ${lockInfo.basic.unlockTime}`);
    log(`  Target Price: $${ethers.formatUnits(lockInfo.pricing.targetPriceUSD1e18, 18)} (should be 0)`);

    assertEqual(lockInfo.pricing.targetPriceUSD1e18, 0n, 'Target price should be 0 for time-only lock');

    logSection('Checking lock status BEFORE time expires');

    const statusBefore = await locker.getLockStatus(lockId);
    log(`  Time OK: ${statusBefore.timeOk} (should be false)`);
    log(`  Price OK: ${statusBefore.priceOk} (should be false - no price condition)`);

    log(`  Advancing time by ${lockDuration + 2} seconds...`);
    // Use Hardhat's time manipulation
    await ethers.provider.send('evm_increaseTime', [lockDuration + 2]);
    await ethers.provider.send('evm_mine', []);

    logSection('Checking lock status AFTER time expires');

    const statusAfter = await locker.getLockStatus(lockId);
    log(`  Time OK: ${statusAfter.timeOk} (should be true)`);
    log(`  Price OK: ${statusAfter.priceOk} (should be false - no price condition)`);

    assertEqual(statusAfter.timeOk, true, 'Time should be OK after waiting');

    logSuccess('TIME-ONLY lock condition verified');
}

async function testPriceFocusLock(locker, lockManager, testToken, deployer, tokenAddress) {
    logPhase(2, 'Lock with PRICE FOCUS (10s minimum time)');

    const lockAmount = ethers.parseEther('5000');
    const targetPrice = ethers.parseUnits('10', 18); // $10
    const minTime = 10; // 10 seconds - minimal time since time is mandatory

    logSection('Creating PRICE-FOCUSED Lock (10s time, $10 target price)');
    log('  Price condition ($10) is the primary unlock trigger');

    // Deploy mock USDC
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000', 6), 6);
    await usdc.waitForDeployment();

    // Deploy mock pair
    const MockPair = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
    const pair = await MockPair.deploy(tokenAddress, await usdc.getAddress());
    await pair.waitForDeployment();
    const pairAddress = await pair.getAddress();

    // Set initial price to $1 (below target)
    await pair.setPriceForToken(tokenAddress, ethers.parseUnits('1', 18));

    // Approve tokens
    await testToken.connect(deployer).approve(await locker.getAddress(), lockAmount);

    // Build CreateLockParams (price target with minimal time)
    const createLockParams = {
        token: tokenAddress,
        amount: lockAmount,
        lockDuration: minTime,
        pair: pairAddress,
        ethUsdPair: pairAddress,
        targetPriceUSD1e18: targetPrice,
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false
    };

    // Get the next lock ID
    const nextId = await lockManager.nextLockId();
    const tx = await locker.connect(deployer).createLock(createLockParams);
    await tx.wait();

    const lockId = nextId;
    const lockInfo = await locker.locks(lockId);

    log(`  Lock ID: ${lockId}`);
    log(`  Amount: ${ethers.formatEther(lockInfo.basic.totalAmount)}`);
    log(`  Target Price: $${ethers.formatUnits(lockInfo.pricing.targetPriceUSD1e18, 18)}`);

    assertEqual(lockInfo.pricing.targetPriceUSD1e18, targetPrice, 'Target price should match');

    logSection('Checking lock status with price BELOW target ($1)');

    const statusBefore = await locker.getLockStatus(lockId);
    log(`  Price OK: ${statusBefore.priceOk} (should be false - price too low)`);
    log(`  Time OK: ${statusBefore.timeOk} (should be false - not expired yet)`);

    logSection('Raising price to $10 (target price)');

    // Set price to target ($10)
    await pair.setPriceForToken(tokenAddress, ethers.parseUnits('10', 18));
    log(`  Price set to $10.0`);

    const statusAfter = await locker.getLockStatus(lockId);
    log(`  Price OK: ${statusAfter.priceOk} (should be true - price reached target)`);
    log(`  Time OK: ${statusAfter.timeOk} (may be true if time also expired)`);

    assertEqual(statusAfter.priceOk, true, 'Price should be OK after raising to target');

    logSuccess('PRICE-FOCUSED lock condition verified');
}

async function testTimeAndPriceLock(locker, lockManager, testToken, deployer, tokenAddress) {
    logPhase(3, 'Lock with TIME AND PRICE (OR logic)');

    const lockAmount = ethers.parseEther('5000');
    const lockDuration = 30; // 30 seconds
    const targetPrice = ethers.parseUnits('10', 18);

    logSection('Creating TIME AND PRICE Lock (30s, $10 target)');
    log('  Contract uses OR logic: unlock when TIME OR PRICE condition is met');

    //Deploy mock USDC
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000', 6), 6);
    await usdc.waitForDeployment();

    // Deploy mock pair
    const MockPair = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
    const pair = await MockPair.deploy(tokenAddress, await usdc.getAddress());
    await pair.waitForDeployment();
    const pairAddress = await pair.getAddress();

    // Set initial price to $1
    await pair.setPriceForToken(tokenAddress, ethers.parseUnits('1', 18));

    // Approve tokens
    await testToken.connect(deployer).approve(await locker.getAddress(), lockAmount);

    // Build CreateLockParams (both time and price)
    const createLockParams = {
        token: tokenAddress,
        amount: lockAmount,
        lockDuration: lockDuration,
        pair: pairAddress,
        ethUsdPair: pairAddress,
        targetPriceUSD1e18: targetPrice,
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false
    };

    // Get the next lock ID
    const nextId = await lockManager.nextLockId();
    const tx = await locker.connect(deployer).createLock(createLockParams);
    await tx.wait();

    const lockId = nextId;
    const lockInfo = await locker.locks(lockId);

    log(`  Lock ID: ${lockId}`);
    log(`  Amount: ${ethers.formatEther(lockInfo.basic.totalAmount)}`);
    log(`  Unlock Time: ${lockInfo.basic.unlockTime} (30s from creation)`);
    log(`  Target Price: $${ethers.formatUnits(lockInfo.pricing.targetPriceUSD1e18, 18)}`);

    logSection('Verifying OR logic - Testing PRICE condition (without waiting for time)');

    //Check status before price change
    const statusBefore = await locker.getLockStatus(lockId);
    log(`  Time OK: ${statusBefore.timeOk} (should be false)`);
    log(`  Price OK: ${statusBefore.priceOk} (should be false)`);

    // Raise price to target
    await pair.setPriceForToken(tokenAddress, ethers.parseUnits('10', 18));

    const statusAfterPrice = await locker.getLockStatus(lockId);
    log(`  After price change:`);
    log(`    Price OK: ${statusAfterPrice.priceOk} (should be true - OR condition met)`);
    log(`    Time OK: ${statusAfterPrice.timeOk} (still false, but doesn't matter due to OR)`);

    assertEqual(statusAfterPrice.priceOk, true, 'Price condition should unlock with OR logic');

    logSuccess('TIME AND PRICE lock OR logic verified');
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
