/**
 * Test 43: Rescue with Active Lock Lifecycle
 *
 * Full lifecycle test for executeRescueWithSignatures interaction with locks.
 * Rescue requires the full M-of-N signer threshold (EIP-712):
 *   1. Create a time-based lock (1000 tokens)
 *   2. Send 500 extra tokens directly to the contract (same token)
 *   3. Multisig rescue attempt → must FAIL (lock exists for this token)
 *   4. Unlock and withdraw 50% (500 tokens)
 *   5. Multisig rescue attempt → must FAIL (lock still has remaining balance)
 *   6. Unlock and withdraw remaining 50% (500 tokens)
 *   7. Multisig rescue attempt → must SUCCEED (lock fully drained, removed
 *      from tokenLocks); verifies balance, ExecutedRescue event and rescueNonce
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
    advanceTime,
    PRICE_DIRECTION,
    getEthers,
    signLockerOp
} from '../core/utils.js';

const ethers = getEthers();

// ============================================================================
// HELPERS
// ============================================================================

async function buildDomain(lockerAddress) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return {
        name: "LockerContract",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };
}

async function collectSignatures(signerAddresses, count, domain, primaryType, message) {
    const signatures = [];
    const addresses = [];
    for (let i = 0; i < count && i < signerAddresses.length; i++) {
        const wallet = await ethers.getSigner(signerAddresses[i]);
        signatures.push(await signLockerOp(wallet, domain, primaryType, message));
        addresses.push(signerAddresses[i]);
    }
    return { addresses, signatures };
}

function findEvent(receipt, iface, eventName) {
    for (const entry of receipt.logs) {
        try {
            const parsed = iface.parseLog({ topics: [...entry.topics], data: entry.data });
            if (parsed && parsed.name === eventName) return parsed;
        } catch (_) { /* log from another contract */ }
    }
    return null;
}

function revertText(error) {
    return [error.shortMessage, error.reason, error.message]
        .filter(Boolean)
        .join(' | ');
}

/**
 * Attempts a fully-signed multisig token rescue and asserts it reverts
 * because a lock exists for the token.
 */
async function expectRescueBlockedByLock(locker, executor, signers, threshold, domain, token, to, amount, label) {
    // Fresh message each attempt: rescueNonce is read live
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const nonce = await locker.rescueNonce();
    const message = { token, to, amount, chainId, nonce };
    const { addresses, signatures } = await collectSignatures(signers, threshold, domain, 'RescueToken', message);

    try {
        const tx = await locker.connect(executor).executeRescueWithSignatures(
            token, to, amount, addresses, signatures
        );
        await tx.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 140)}`);
        assert(
            text.includes('Lock exists for this token'),
            `${label}: expected "Lock exists for this token" revert, got: ${text.substring(0, 200)}`
        );
        logSuccess(`${label} correctly rejected — lock exists for this token`);
        return;
    }
    throw new Error(`${label}: rescue should have failed but succeeded!`);
}

/**
 * Executes a threshold-signed unlock of `amount` from `lockId` to `to`.
 */
async function executeMultisigUnlock(locker, executor, signers, threshold, domain, lockId, to, amount) {
    const nonce = await locker.unlockNonce(lockId);
    const message = { lockId, to, amount, nonce };
    const { addresses, signatures } = await collectSignatures(signers, threshold, domain, 'Unlock', message);

    const tx = await locker.connect(executor).executeUnlockWithSignatures(
        lockId, to, amount, addresses, signatures
    );
    await tx.wait();
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 43: RESCUE WITH ACTIVE LOCK LIFECYCLE (MULTISIG)\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();

        const deployer = await getWallet(0);
        const recipient = await getWallet(2);

        const locker = await getContract('LockerContract', 0);
        const lockerAddress = await locker.getAddress();
        const domain = await buildDomain(lockerAddress);

        // Live multisig configuration (earlier tests may have changed it)
        const signers = await locker.getSigners();
        const threshold = Number(await locker.approvalsThreshold());
        const executor = await ethers.getSigner(signers[0]);
        log(`  Signers: ${signers.length}, threshold: ${threshold}`);

        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);

        // Use TestToken3 to avoid conflicts with other tests
        const testToken = new ethers.Contract(
            state.contracts.TestToken3,
            [
                'function balanceOf(address) view returns (uint256)',
                'function transfer(address,uint256) returns (bool)',
                'function approve(address,uint256) returns (bool)',
                'function symbol() view returns (string)'
            ],
            deployer
        );
        const tokenAddress = state.contracts.TestToken3;
        const tokenSymbol = await testToken.symbol();
        log(`  Using token: ${tokenSymbol} (${tokenAddress.substring(0, 10)}...)`);

        // ════════════════════════════════════════════════════════════════
        // PHASE 1: Create a time-based lock with short unlock time
        // ════════════════════════════════════════════════════════════════
        logPhase(1, 'Create time-based lock (1000 tokens, unlocks in ~60s)');

        const lockAmount = ethers.parseEther('1000');
        const LOCK_DURATION = 60; // seconds — we'll advance time past this

        await testToken.connect(deployer).approve(lockerAddress, lockAmount);
        logSuccess('Tokens approved');

        const createLockParams = {
            token: tokenAddress,
            amount: lockAmount,
            lockDuration: LOCK_DURATION,
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
        const txCreate = await locker.connect(deployer).createLock(createLockParams);
        await txCreate.wait();
        const lockId = nextId;

        log(`  Lock ID: ${lockId}`);
        log(`  Locked: ${ethers.formatEther(lockAmount)} ${tokenSymbol}`);
        logSuccess('Lock created');

        // ════════════════════════════════════════════════════════════════
        // PHASE 2: Send extra tokens directly to contract (accidental transfer)
        // ════════════════════════════════════════════════════════════════
        logPhase(2, 'Send 500 extra tokens directly to contract');

        const extraAmount = ethers.parseEther('500');
        await testToken.connect(deployer).transfer(lockerAddress, extraAmount);

        const contractBalance = await testToken.balanceOf(lockerAddress);
        log(`  Contract balance: ${ethers.formatEther(contractBalance)} ${tokenSymbol}`);
        log(`  (1000 locked + 500 extra)`);
        logSuccess('Extra tokens sent to contract');

        // ════════════════════════════════════════════════════════════════
        // PHASE 3: Multisig rescue attempt → must FAIL (lock exists)
        // ════════════════════════════════════════════════════════════════
        logPhase(3, 'Multisig rescue attempt #1 → must FAIL (lock exists)');

        await expectRescueBlockedByLock(
            locker, executor, signers, threshold, domain,
            tokenAddress, recipient.address, extraAmount,
            'Rescue attempt #1'
        );

        // Advance blockchain time past unlock time
        log('  Advancing blockchain time past unlock...');
        await advanceTime(LOCK_DURATION + 5);

        // ════════════════════════════════════════════════════════════════
        // PHASE 4: Unlock and withdraw 50% (500 tokens)
        // ════════════════════════════════════════════════════════════════
        logPhase(4, 'Unlock and withdraw 50% (500 tokens)');

        const halfAmount = ethers.parseEther('500');
        await executeMultisigUnlock(
            locker, executor, signers, threshold, domain,
            lockId, deployer.address, halfAmount
        );

        const lockAfter1 = await locker.locks(lockId);
        // availableAmount = remaining balance; totalAmount = lifetime deposited (never decremented)
        log(`  Remaining in lock: ${ethers.formatEther(lockAfter1.basic.availableAmount)} ${tokenSymbol}`);
        assertEqual(lockAfter1.basic.availableAmount, halfAmount, 'Should have 500 remaining');
        assertEqual(lockAfter1.basic.totalAmount, lockAmount, 'totalAmount should keep the lifetime deposited total');
        logSuccess('50% withdrawn successfully');

        // ════════════════════════════════════════════════════════════════
        // PHASE 5: Multisig rescue attempt → must FAIL (lock still has balance)
        // ════════════════════════════════════════════════════════════════
        logPhase(5, 'Multisig rescue attempt #2 → must FAIL (lock still has balance)');

        await expectRescueBlockedByLock(
            locker, executor, signers, threshold, domain,
            tokenAddress, recipient.address, extraAmount,
            'Rescue attempt #2'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 6: Unlock and withdraw remaining 50% (500 tokens)
        // ════════════════════════════════════════════════════════════════
        logPhase(6, 'Unlock and withdraw remaining 50% (500 tokens)');

        await executeMultisigUnlock(
            locker, executor, signers, threshold, domain,
            lockId, deployer.address, halfAmount
        );

        const lockAfter2 = await locker.locks(lockId);
        log(`  Remaining in lock: ${ethers.formatEther(lockAfter2.basic.availableAmount)} ${tokenSymbol}`);
        assertEqual(lockAfter2.basic.availableAmount, 0n, 'Should be fully drained');
        logSuccess('Remaining 50% withdrawn — lock fully drained');

        // ════════════════════════════════════════════════════════════════
        // PHASE 7: Multisig rescue attempt → must SUCCEED (no more locks)
        // ════════════════════════════════════════════════════════════════
        logPhase(7, 'Multisig rescue attempt #3 → must SUCCEED (lock fully drained)');

        // Verify tokenLocks is now empty for this token
        const tokenLocks = await lockManager.getTokenLocks(tokenAddress);
        log(`  Active locks for token: ${tokenLocks.length}`);
        assertEqual(BigInt(tokenLocks.length), 0n, 'Token should have no active locks');

        const recipientBefore = await testToken.balanceOf(recipient.address);
        const contractBalanceBefore = await testToken.balanceOf(lockerAddress);
        log(`  Contract balance before rescue: ${ethers.formatEther(contractBalanceBefore)} ${tokenSymbol}`);

        // Rescue the actual balance (may differ from extraAmount if other tests affected state)
        const rescueAmount = contractBalanceBefore > 0n ? contractBalanceBefore : extraAmount;
        assert(rescueAmount > 0n, 'Contract should have tokens to rescue');

        const nonceBefore = await locker.rescueNonce();
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        const rescueMessage = {
            token: tokenAddress,
            to: recipient.address,
            amount: rescueAmount,
            chainId,
            nonce: nonceBefore
        };
        const { addresses, signatures } =
            await collectSignatures(signers, threshold, domain, 'RescueToken', rescueMessage);

        const txRescue = await locker.connect(executor).executeRescueWithSignatures(
            tokenAddress, recipient.address, rescueAmount, addresses, signatures
        );
        const receipt = await txRescue.wait();

        const recipientAfter = await testToken.balanceOf(recipient.address);
        const rescued = recipientAfter - recipientBefore;

        log(`  Rescued: ${ethers.formatEther(rescued)} ${tokenSymbol}`);
        assertEqual(rescued, rescueAmount, 'Rescued amount should match');

        const rescueEvent = findEvent(receipt, locker.interface, 'ExecutedRescue');
        assert(rescueEvent !== null, 'ExecutedRescue event must be emitted');
        assertEqual(rescueEvent.args.token, tokenAddress, 'Event token');
        assertEqual(rescueEvent.args.to, recipient.address, 'Event recipient');
        assertEqual(rescueEvent.args.amount, rescueAmount, 'Event amount');

        const nonceAfter = await locker.rescueNonce();
        assertEqual(nonceAfter, nonceBefore + 1n, 'rescueNonce incremented');
        logSuccess('Rescue succeeded — extra tokens recovered!');

        // ════════════════════════════════════════════════════════════════

        reportTestResult('43-rescue-lock-lifecycle', true);
        logSuccess('\n🎉 TEST 43 PASSED: Full rescue lifecycle verified!\n');

    } catch (error) {
        reportTestResult('43-rescue-lock-lifecycle', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
