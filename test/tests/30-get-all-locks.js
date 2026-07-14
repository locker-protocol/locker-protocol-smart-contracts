/**
 * Test 30: getAllLocks() Stress Test
 * 
 * Creates 100 tokens with 10 locks each (1000 total locks)
 * and verifies getAllLocks() returns all 1000 lock IDs
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
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 30: GET ALL LOCKS STRESS TEST\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();
        const deployer = await getWallet(0);

        const locker = await getContract('LockerContract', 0);
        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);

        // Phase 1: Deploy 100 test tokens
        const tokens = await testDeployTokens(deployer, 100);

        // Phase 2: Create 10 locks per token (1000 total)
        const lockIds = await testCreateMassiveLocks(locker, lockManager, tokens, deployer);

        // Phase 3: Verify getAllLocks returns all 1000 locks
        await testGetAllLocks(lockManager, lockIds);

        reportTestResult('30-get-all-locks', true);
        logSuccess('\n✅ TEST 30 PASSED!\n');

    } catch (error) {
        reportTestResult('30-get-all-locks', false, error.message);
        throw error;
    }
}

async function testDeployTokens(deployer, count) {
    logPhase(1, `Deploy ${count} Test Tokens`);
    logSection(`Deploying ${count} ERC20 tokens for stress testing`);

    const tokens = [];

    log(`  Deploying tokens...`);
    const startTime = Date.now();

    // Get the ERC20Mock contract factory from Hardhat
    const TokenFactory = await ethers.getContractFactory('ERC20Mock', deployer);

    for (let i = 0; i < count; i++) {
        const token = await TokenFactory.deploy(
            `TestToken${i}`,
            `TT${i}`,
            deployer.address,
            ethers.parseEther('1000000'),
            18
        );
        await token.waitForDeployment();
        const tokenAddress = await token.getAddress();

        tokens.push({ contract: token, address: tokenAddress, index: i });

        if ((i + 1) % 10 === 0) {
            log(`    ✅ Deployed ${i + 1}/${count} tokens...`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logSuccess(`Deployed ${count} tokens in ${elapsed}s`);

    return tokens;
}

async function testCreateMassiveLocks(locker, lockManager, tokens, deployer) {
    logPhase(2, 'Create 10 Locks per Token (1000 total)');
    logSection('Creating massive number of locks for stress testing');

    const lockerAddress = await locker.getAddress();
    const lockIds = [];
    const startTime = Date.now();

    for (const tokenData of tokens) {
        const { contract: token, address: tokenAddress, index: tokenIndex } = tokenData;

        // Approve locker to spend tokens
        const totalAmount = ethers.parseEther('100'); // 10 locks × 10 tokens each
        await token.approve(lockerAddress, totalAmount);

        // Create 10 locks for this token
        for (let lockNum = 0; lockNum < 10; lockNum++) {
            const createLockParams = {
                token: tokenAddress,
                amount: ethers.parseEther('10'),
                lockDuration: 86400, // 1 day
                pair: ethers.ZeroAddress,
                ethUsdPair: ethers.ZeroAddress,
                targetPriceUSD1e18: 0,
                isEthPair: false,
                stablecoinPosition: 0,
                priceDirection: PRICE_DIRECTION.UPSIDE,
                vestingTokensPerPeriod: 0,
                vestingPeriodSeconds: 0,
                vestingAccumulate: false
            };

            const nextId = await lockManager.nextLockId();
            await locker.connect(deployer).createLock(createLockParams);
            lockIds.push(nextId);
        }

        if ((tokenIndex + 1) % 10 === 0) {
            const created = (tokenIndex + 1) * 10;
            log(`    ✅ Created ${created}/1000 locks...`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logSuccess(`Created 1000 locks in ${elapsed}s`);

    return lockIds;
}

async function testGetAllLocks(lockManager, expectedLockIds) {
    logPhase(3, 'Verify getAllLocks() Returns All 1000 Locks');
    logSection('Calling getAllLocks() and verifying result');

    log(`  Expected locks: ${expectedLockIds.length}`);
    log(`  Calling getAllLocks()...`);

    const startTime = Date.now();
    const allLockIds = await lockManager.getAllLocks();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(3);

    log(`  ⏱️  getAllLocks() took ${elapsed}s`);
    log(`  Returned locks: ${allLockIds.length}`);

    // Convert BigInt array to Number array for comparison
    const returnedIds = allLockIds.map(id => Number(id));
    const expectedIds = expectedLockIds.map(id => Number(id));

    // Verify getAllLocks returns at least the expected locks (may include setup locks)
    if (returnedIds.length < expectedIds.length) {
        throw new Error(`Should return at least ${expectedIds.length} locks, got ${returnedIds.length}`);
    }

    // Verify all expected IDs are present
    const returnedSet = new Set(returnedIds);
    const missingIds = expectedIds.filter(id => !returnedSet.has(id));

    if (missingIds.length > 0) {
        throw new Error(`Missing lock IDs: ${missingIds.slice(0, 10).join(', ')}${missingIds.length > 10 ? '...' : ''}`);
    }

    logSuccess(`✅ getAllLocks() correctly returned all ${expectedIds.length} test locks (${returnedIds.length} total including setup)`);
    log(`  Performance: ${elapsed}s for ${returnedIds.length} locks`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
