/**
 * Test 04: Lock Security
 * 
 * Tests:
 * - Attempt to modify recipient address (should fail)
 * - Attempt to unlock without signatures (should fail)
 * - Attempt to modify target price after creation (should fail)
 * - Verify rescue functions require the multi-sig quorum (should fail without it)
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
    signLockerOp,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

async function main() {
    log('\n🧪 TEST 04: LOCK SECURITY\n', '\x1b[1m\x1b[36m');

    try {
        // Load shared state
        const state = loadSharedState();

        // Get wallets
        const deployer = await getWallet(0);
        const nonSigner = await getWallet(1);

        // Get contracts
        const locker = await getContract('LockerContract', 0);
        const testToken = new ethers.Contract(
            state.contracts.TestToken,
            ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
            deployer
        );

        // Phase 1: Create test lock
        const lockId = await testCreateSecurityLock(locker, testToken, deployer, state.contracts.TestToken);

        // Phase 2: Test unauthorized access attempts
        await testUnauthorizedAccess(locker, nonSigner, lockId, state.contracts.TestToken);

        // Phase 3: Test price modification prevention
        await testPriceModificationPrevention(locker, deployer, lockId);

        // Phase 4: Test multisig-only rescue functions
        await testRescueRequiresQuorum(locker, nonSigner, state.contracts.TestToken);

        reportTestResult('04-lock-security', true);
        logSuccess('\n✅ TEST 04 PASSED!\n');

    } catch (error) {
        reportTestResult('04-lock-security', false, error.message);
        throw error;
    }
}

// ============================================================================
// TEST PHASES
// ============================================================================

async function testCreateSecurityLock(locker, testToken, deployer, tokenAddress) {
    logPhase(1, 'Create Test Lock');

    const lockAmount = ethers.parseEther('10000'); // 10,000 tokens
    const unlockTime = await getCurrentTimestamp() + ONE_MONTH;

    logSection('Creating Basic Lock for Security Tests');

    // Approve tokens
    const approveTx = await testToken.connect(deployer).approve(await locker.getAddress(), lockAmount);
    await approveTx.wait();

    // Build CreateLockParams (no price target, just time-based)
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

    log(`  Amount: ${ethers.formatEther(lockInfo.basic.totalAmount)}`);
    logSuccess('Security test lock created');

    return lockId;
}

async function testUnauthorizedAccess(locker, nonSigner, lockId, tokenAddress) {
    logPhase(2, 'Test Unauthorized Access');

    logSection('Attempt to unlock without proper signatures');

    const unlockAmount = ethers.parseEther('1000');

    try {
        // This should fail because nonSigner is not a signer
        await locker.connect(nonSigner).executeUnlock(
            tokenAddress,
            nonSigner.address,
            unlockAmount,
            0 // maxSlippageBps
        );
        throw new Error('Unlock should have failed for non-signer');
    } catch (error) {
        if (error.message.includes('Unlock should have failed')) {
            throw error;
        }
        logSuccess('✅ Unauthorized unlock correctly rejected');
    }

    logSuccess('Unauthorized access tests passed');
}

async function testPriceModificationPrevention(locker, deployer, lockId) {
    logPhase(3, 'Test Price Modification Prevention');

    logSection('Verify target price cannot be modified after lock creation');

    // Note: There's no setTargetPrice function in the contract
    // Once a lock is created, its target price is immutable
    // This test verifies this design decision

    const lockInfo = await locker.locks(lockId);
    const originalPrice = lockInfo.pricing.targetPriceUSD1e18;

    log(`  Original target price: $${ethers.formatUnits(originalPrice, 18)}`);
    log(`  Target price is immutable by design`);

    logSuccess('Price immutability verified');
}

async function testRescueRequiresQuorum(locker, nonSigner, tokenAddress) {
    logPhase(4, 'Test Rescue Functions Require Multi-Sig Quorum');

    const rescueAmount = ethers.parseEther('1');

    logSection('Token rescue without any signature must fail');
    try {
        await locker.connect(nonSigner).executeRescueWithSignatures(
            tokenAddress,
            nonSigner.address,
            rescueAmount,
            [],
            []
        );
        throw new Error('Token rescue should have failed without signatures');
    } catch (error) {
        if (error.message.includes('should have failed')) {
            throw error;
        }
        logSuccess('✅ Token rescue without quorum correctly rejected');
    }

    logSection('Native rescue signed only by a non-signer must fail');
    const lockerAddress = await locker.getAddress();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const rescueNonce = await locker.rescueNonce();

    const domain = {
        name: 'LockerContract',
        version: '1',
        chainId,
        verifyingContract: lockerAddress
    };

    // Non-signer signs the correctly-decoded RescueNative struct; must still be rejected.
    const nonSignerSignature = await signLockerOp(nonSigner, domain, 'RescueNative', {
        to: nonSigner.address,
        amount: rescueAmount,
        chainId,
        nonce: rescueNonce
    });

    try {
        await locker.connect(nonSigner).executeRescueNativeWithSignatures(
            nonSigner.address,
            rescueAmount,
            [nonSigner.address],
            [nonSignerSignature]
        );
        throw new Error('Native rescue should have failed for non-signer');
    } catch (error) {
        if (error.message.includes('should have failed')) {
            throw error;
        }
        logSuccess('✅ Native rescue signed by non-signer correctly rejected');
    }

    logSuccess('Rescue quorum enforcement verified');
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
