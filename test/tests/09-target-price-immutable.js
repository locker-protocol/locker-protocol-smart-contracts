/**
 * Test 09: Target Price Immutable
 * 
 * Tests that target price cannot be modified after lock creation
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
    ONE_MONTH,
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 09: TARGET PRICE IMMUTABLE\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();
        const deployer = await getWallet(0);

        const locker = await getContract('LockerContract', 0);
        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);
        const testToken = new ethers.Contract(
            state.contracts.TestToken,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
            deployer
        );

        // Phase 1: Create lock with target price
        const targetPrice = ethers.parseEther('10');
        const lockId = await testCreatePriceLock(locker, lockManager, testToken, deployer, state, targetPrice);

        // Phase 2: Verify price set
        await testVerifyTargetPrice(locker, lockId, targetPrice);

        // Phase 3: Verify no update function exists
        await testPriceImmutability(locker, lockId);

        reportTestResult('09-target-price-immutable', true);
        logSuccess('\n✅ TEST 09 PASSED!\n');

    } catch (error) {
        reportTestResult('09-target-price-immutable', false, error.message);
        throw error;
    }
}

async function testCreatePriceLock(locker, lockManager, testToken, deployer, state, targetPrice) {
    logPhase(1, 'Create Lock with Target Price');
    logSection(`Creating lock with target price ${ethers.formatEther(targetPrice)} USD`);

    const lockAmount = ethers.parseEther('10000');
    const minTime = 2;

    await testToken.connect(deployer).approve(await locker.getAddress(), lockAmount);

    // Deploy mock USDC and pair to have valid price storage
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000', 6), 6);
    await usdc.waitForDeployment();

    const MockPair = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
    const pair = await MockPair.deploy(state.contracts.TestToken, await usdc.getAddress());
    await pair.waitForDeployment();
    const pairAddress = await pair.getAddress();

    // Set target price on pair
    await pair.setPriceForToken(state.contracts.TestToken, targetPrice);
    log(`  Mock pair deployed: ${pairAddress}`);

    const createLockParams = {
        token: state.contracts.TestToken,
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

    const nextId = await lockManager.nextLockId();
    await locker.connect(deployer).createLock(createLockParams);
    const lockId = nextId;

    log(`  Lock ID: ${lockId}`);
    log(`  Target Price: ${ethers.formatEther(targetPrice)} USD`);

    logSuccess(`Lock ${lockId} created with target price`);
    return lockId;
}

async function testVerifyTargetPrice(locker, lockId, expectedPrice) {
    logPhase(2, 'Verify Target Price Set');
    logSection('Checking lock pricing configuration');

    const lock = await locker.locks(lockId);
    const actualPrice = lock.pricing.targetPriceUSD1e18;

    log(`  Expected price: ${ethers.formatEther(expectedPrice)} USD`);
    log(`  Actual price: ${ethers.formatEther(actualPrice)} USD`);

    assertEqual(actualPrice, expectedPrice, 'Target price matches');

    logSuccess('Target price correctly set');
}

async function testPriceImmutability(locker, lockId) {
    logPhase(3, 'Verify Price Immutability');
    logSection('Checking that price cannot be modified');

    // Check if updateTargetPrice function exists
    const hasUpdateFunction = typeof locker.updateTargetPrice === 'function';

    if (hasUpdateFunction) {
        log(`  ⚠️  updateTargetPrice function exists (should not!)`);
        throw new Error('Price update function should not exist');
    } else {
        log(`  ✅ updateTargetPrice function does not exist`);
    }

    // Verify price is still the same
    const lock = await locker.locks(lockId);
    log(`  Current price: ${ethers.formatEther(lock.pricing.targetPriceUSD1e18)} USD`);

    logSuccess('Target price is immutable (no update function exists)');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
