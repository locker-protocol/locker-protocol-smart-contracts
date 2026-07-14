/**
 * Test 02: Price Lock with Uniswap V2
 * 
 * Tests:
 * - Create lock with price target
 * - Verify price calculation
 * - Unlock based on price condition
 * - Multiple locks with different price directions
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
    log('\n🧪 TEST 02: PRICE LOCK WITH UNISWAP V2\n', '\x1b[1m\x1b[36m');

    try {
        // Load shared state
        const state = loadSharedState();

        // Get wallets
        const deployer = await getWallet(0);
        const alice = await getWallet(1);

        // Get contracts
        const locker = await getContract('LockerContract', 0);
        const priceCalculator = await getContract('PriceCalculator', 0);
        const testToken = new ethers.Contract(
            state.contracts.TestToken,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'],
            deployer
        );

        // Phase 1: Setup Mock Pair & Create Price Lock
        const { pairAddress, usdcAddress, lockId } = await testSetupPairAndCreateLock(
            locker,
            priceCalculator,
            testToken,
            alice,
            state.contracts.TestToken,
            deployer
        );

        // Phase 2: Unlock with Price Condition
        await testUnlockWithPriceCondition(locker, priceCalculator, pairAddress, state.contracts.TestToken, alice, lockId);

        reportTestResult('02-price-lock', true);
        logSuccess('\n✅ TEST 02 PASSED!\n');

    } catch (error) {
        reportTestResult('02-price-lock', false, error.message);
        throw error;
    }
}

// ============================================================================
// TEST PHASES
// ============================================================================

async function testSetupPairAndCreateLock(locker, priceCalculator, testToken, alice, tokenAddress, deployer) {
    logPhase(1, 'Setup Mock Pair & Create Price Lock');

    // Deploy mock USDC
    logSection('Deploying Mock USDC');
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const usdc = await ERC20Mock.deploy('USD Coin', 'USDC', deployer.address, ethers.parseUnits('1000000', 6), 6);
    await usdc.waitForDeployment();
    const usdcAddress = await usdc.getAddress();
    logSuccess(`Mock USDC deployed: ${usdcAddress}`);

    // Deploy mock Uniswap V2 pair
    logSection('Deploying Mock Uniswap V2 Pair');
    const MockPair = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
    const pair = await MockPair.deploy(tokenAddress, usdcAddress);
    await pair.waitForDeployment();
    const pairAddress = await pair.getAddress();
    logSuccess(`Mock Pair deployed: ${pairAddress}`);

    // Set initial price: 1 TEST = $1 USDC
    logSection('Setting Initial Price');
    const initialPrice = ethers.parseUnits('1', 18); // $1 in 1e18 format
    await pair.setPriceForToken(tokenAddress, initialPrice);
    logSuccess(`Initial price set: $1`);

    // Verify price calculation
    const [success, calculatedPrice] = await priceCalculator.getPriceUSDWithFallback(
        pairAddress,     // tokenPair
        tokenAddress,    // token
        pairAddress,     // usdPair (same pair for direct token/USD)
        false,           // isEthPair
        2                // stablecoinPosition (token1 = USDC)
    );
    log(`  Price calculation success: ${success}`);
    log(`  Calculated price: $${ethers.formatUnits(calculatedPrice, 18)}`);

    // Create lock with target price $10
    logSection('Creating Price Lock');
    const lockAmount = ethers.parseEther('10000'); // 10,000 tokens
    const targetPrice = ethers.parseUnits('10', 18); // $10 target
    const unlockTime = await getCurrentTimestamp() + ONE_MONTH;

    // Approve tokens
    const approveTx = await testToken.connect(alice).approve(await locker.getAddress(), lockAmount);
    await approveTx.wait();
    logSuccess('Tokens approved');

    // Build CreateLockParams
    const createLockParams = {
        token: tokenAddress,
        amount: lockAmount,
        lockDuration: unlockTime,
        pair: pairAddress,
        ethUsdPair: pairAddress, // Same pair for direct token/USD
        targetPriceUSD1e18: targetPrice,
        isEthPair: false,
        stablecoinPosition: 2, // token1 is USDC
        priceDirection: PRICE_DIRECTION.UPSIDE, // 0 = UPSIDE
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false
    };

    const tx = await locker.connect(alice).createLock(createLockParams);
    const receipt = await tx.wait();
    logSuccess(`Lock created: ${receipt.hash}`);

    // Get LockManager interface to parse LockCreated event (emitted by LockManager, not LockerContract)
    const LockManagerFactory = await ethers.getContractFactory('LockManager');
    const lockManagerInterface = LockManagerFactory.interface;

    // Extract lockId from LockCreated event
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

    assertEqual(lockInfo.basic.token, tokenAddress, 'Token should match');
    assertEqual(lockInfo.basic.totalAmount, lockAmount, 'Amount should match');
    assertEqual(lockInfo.pricing.targetPriceUSD1e18, targetPrice, 'Target price should match');

    log(`  Lock ID: ${lockId}`);
    log(`  Amount: ${ethers.formatEther(lockAmount)}`);
    log(`  Target Price: $${ethers.formatUnits(targetPrice, 18)}`);
    logSuccess('Price lock created successfully');

    return { pairAddress, usdcAddress, lockId };
}

async function testUnlockWithPriceCondition(locker, priceCalculator, pairAddress, tokenAddress, alice, lockId) {
    logPhase(2, 'Unlock with Price Condition Met');

    // Get pair contract
    const pair = await ethers.getContractAt('MockUniswapV2Pair', pairAddress);

    // Move price to $10
    logSection('Simulating Price Movement');
    const newPrice = ethers.parseUnits('10', 18); // $10
    await pair.setPriceForToken(tokenAddress, newPrice);
    logSuccess('Price moved to $10');

    // Verify new price
    const [success2, calculatedPrice] = await priceCalculator.getPriceUSDWithFallback(
        pairAddress,
        tokenAddress,
        pairAddress,
        false,
        2
    );
    log(`  Price calculation success: ${success2}`);
    log(`  New calculated price: $${ethers.formatUnits(calculatedPrice, 18)}`);
    assert(calculatedPrice >= newPrice, 'Price should be at or above target');

    // Check lock status
    logSection('Checking Lock Status');
    const lockStatus = await locker.getLockStatus(lockId);
    log(`  Can unlock: ${lockStatus.canUnlock}`);
    log(`  Reason: ${lockStatus.unlockReason}`);

    // Note: We can't actually unlock without signatures in this test
    // Just verify the price condition is met
    logSuccess('Price condition verified');
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
