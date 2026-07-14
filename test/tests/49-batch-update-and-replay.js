/**
 * Test 49: Batch Signer Update Guards + On-Chain Replay Protection
 *
 * Covers the remaining guard branches of LockerContract and asserts the REAL
 * on-chain replay behaviour of every *WithSignatures entry point.
 *
 * Phases:
 *   1. _validateBatchUpdate guards (all fire BEFORE any signature is inspected,
 *      so they are exercised with empty signature arrays):
 *        - "Final count below minimum"
 *        - "Signer not found"            (removing a non-signer)
 *        - "Cannot add zero address"
 *        - "Duplicate signer detected"
 *        - "Signer already exists"
 *      ("Count below threshold" needs threshold > 3, see phase 4)
 *   2. _validateUnlockRequest guards (also fire before signature checks):
 *        - "No lock found for this lockId"
 *        - "Insufficient available amount in lock"
 *        - "Insufficient contract balance" — the balance >= availableAmount
 *          invariant cannot be broken through the contract API (rescue is
 *          blocked for locked tokens, createLock/addToLock credit the received
 *          amount), so the drained-balance state this guard defends against
 *          (deflationary / rebasing tokens) is engineered with
 *          hardhat_setStorageAt on a fresh mock token, verified and restored.
 *   3. "Insufficient approvals" through the three multi-sig entry points
 *      (executeUnlockWithSignatures, updateThresholdWithSignatures,
 *      batchUpdateSignersWithSignatures) by supplying threshold-1 valid sigs.
 *   4. Threshold raise/restore via multisig + configEpoch semantics:
 *        - raise T0 -> T0+1, replay the exact same call+signatures -> reverts
 *        - "Count below threshold" (reachable only while threshold > 3)
 *        - a T0-signature unlock bundle pre-signed under the old config now
 *          fails "Insufficient approvals" (bumpConfigEpoch: nothing stays
 *          pre-registered; the live threshold applies to re-submission)
 *        - restore threshold, replay the restore call -> reverts
 *   5. executeUnlockWithSignatures: execute the pre-signed bundle (offline
 *      signatures survive epoch bumps — only REGISTERED approvals are
 *      invalidated, and none can be pre-registered since
 *      batchApproveWithSignatures is onlyLocker), then replay it -> reverts.
 *   6. batchUpdateSignersWithSignatures: execute a remove+re-add "swap" of the
 *      last signer (signer list stays byte-identical, order included), then
 *      replay the same call+signatures -> reverts.
 *   7. createLockWithSignatures: execute, then replay the same params+signature
 *      -> reverts ("INV_SIG").
 *
 * NOTE on 'Operation already executed' / 'Op already executed': these branches
 * are UNREACHABLE from the entry points in the current code. Every execute path
 * bumps the nonce embedded in its opKey within the same transaction
 * (unlockNonce[lockId]++, thresholdNonce++, batchUpdateSignersNonce++,
 * createLockNonce++, rescueNonce++), so an executed opKey can never be
 * re-derived; the everExecuted mapping (and the hasExecuted checks in
 * LockerInternal/LockerSignerOperations/LockerLockOperations, plus ERR_002 in
 * ValidationHandler which would fire first during batchApprove) is pure
 * defense-in-depth. The observable replay behaviour — asserted here — is
 * "ERR_005: Invalid signature" (stale signatures against the new-nonce opKey)
 * and "INV_SIG" for the single-signer createLockWithSignatures path.
 *
 * Isolation: the signer set and the approvals threshold are restored (and
 * asserted identical) at the end; the drained token balance is restored; only
 * monotonic nonces/epochs and two fresh-token locks remain, which no other
 * test depends on.
 */

import {
    getContract,
    getWallet,
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    PRICE_DIRECTION,
    signLockerOp,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

// ============================================================================
// HELPERS
// ============================================================================

let passed = 0;
let failed = 0;

function pass(label) {
    passed++;
    logSuccess(`[CHECK ${passed}] ${label}`);
}

async function buildDomain(lockerAddress) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return {
        name: "LockerContract",
        version: "1",
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };
}

// Collect `count` threshold signatures over the typed operation struct (M-1).
async function collectSignatures(primaryType, message, signerAddresses, count, domain) {
    const signatures = [];
    const addresses = [];
    for (let i = 0; i < count && i < signerAddresses.length; i++) {
        const wallet = await ethers.getSigner(signerAddresses[i]);
        signatures.push(await signLockerOp(wallet, domain, primaryType, message));
        addresses.push(signerAddresses[i]);
    }
    return { addresses, signatures };
}

function revertText(error) {
    return [error.shortMessage, error.reason, error.message]
        .filter(Boolean)
        .join(' | ');
}

async function expectRevert(callFn, label, expectedSubstring) {
    try {
        const tx = await callFn();
        if (tx && tx.wait) await tx.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 140)}`);
        assert(
            text.includes(expectedSubstring),
            `${label}: expected revert containing "${expectedSubstring}", got: ${text.substring(0, 200)}`
        );
        pass(`${label} reverted with "${expectedSubstring}"`);
        return;
    }
    throw new Error(`${label}: expected revert "${expectedSubstring}" but call succeeded`);
}

function makeLockParams(tokenAddress, amount) {
    return {
        token: tokenAddress,
        amount: amount,
        lockDuration: 0, // 0-duration lock: immediately time-unlockable
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
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 49: BATCH UPDATE GUARDS + ON-CHAIN REPLAY PROTECTION\n', '\x1b[1m\x1b[36m');

    try {
        const recipient = await getWallet(7);

        const locker = await getContract('LockerContract', 0);
        const lockerAddress = await locker.getAddress();
        const validationHandler = await getContract('ValidationHandler', 0);
        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);
        const domain = await buildDomain(lockerAddress);

        // Live multisig configuration (earlier tests may have changed it).
        // Array.from: ethers v6 returns a frozen Result, unusable as calldata input.
        const initialSigners = Array.from(await locker.getSigners());
        const C = initialSigners.length;
        const T0 = Number(await locker.approvalsThreshold());
        log(`  Signers: ${C}, threshold: ${T0}`);
        assert(C > T0, `Test needs signers count (${C}) > threshold (${T0}) to raise the threshold temporarily`);

        // Executor: any current signer (needed for createLock's onlySigner)
        const executor = await ethers.getSigner(initialSigners[0]);

        // Fresh tokens so no other test's locks/balances interfere
        logSection('Setup: deploy fresh mock tokens');
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const tokenA = await ERC20Mock.deploy(
            'Replay Coverage Token', 'RPC49', executor.address, ethers.parseEther('1000000'), 18
        );
        await tokenA.waitForDeployment();
        const tokenAAddress = await tokenA.getAddress();

        const ERC20USDTMock = await ethers.getContractFactory('ERC20USDTMock');
        const tokenU = await ERC20USDTMock.deploy(
            'Drainable Mock', 'DRN49', executor.address, ethers.parseEther('1000000')
        );
        await tokenU.waitForDeployment();
        const tokenUAddress = await tokenU.getAddress();
        logSuccess(`tokenA (ERC20Mock): ${tokenAAddress}`);
        logSuccess(`tokenU (ERC20USDTMock): ${tokenUAddress}`);

        // ════════════════════════════════════════════════════════════════
        // PHASE 1: _validateBatchUpdate guards (fire before signature checks)
        // ════════════════════════════════════════════════════════════════
        logPhase(1, '_validateBatchUpdate guards (no signatures needed)');

        const randomA = ethers.Wallet.createRandom().address;
        const randomB = ethers.Wallet.createRandom().address;

        // newCount = C - (C-2) + 0 = 2 < 3
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                initialSigners.slice(0, C - 2), [], [], []
            ),
            'Batch update dropping signer count to 2',
            'Final count below minimum'
        );

        // Removing a non-signer (fresh address added to keep newCount == C)
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                [randomA], [randomB], [], []
            ),
            'Batch update removing a non-signer',
            'Signer not found'
        );

        // Adding address(0)
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                [], [ethers.ZeroAddress], [], []
            ),
            'Batch update adding the zero address',
            'Cannot add zero address'
        );

        // Same address twice in toAdd
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                [], [randomA, randomA], [], []
            ),
            'Batch update adding a duplicated address',
            'Duplicate signer detected'
        );

        // Adding an existing signer that is not being removed
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                [], [initialSigners[0]], [], []
            ),
            'Batch update re-adding an existing signer',
            'Signer already exists'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 2: _validateUnlockRequest guards (fire before signature checks)
        // ════════════════════════════════════════════════════════════════
        logPhase(2, '_validateUnlockRequest guards');

        // Create lockA on tokenA (10 000 tokens, 0-duration => immediately unlockable)
        logSection('Create lockA on fresh tokenA');
        const lockAAmount = ethers.parseEther('10000');
        await (await tokenA.connect(executor).approve(lockerAddress, lockAAmount)).wait();
        const lockIdA = await lockManager.nextLockId();
        await (await locker.connect(executor).createLock(makeLockParams(tokenAAddress, lockAAmount))).wait();
        assertEqual(
            (await lockManager.getLock(lockIdA)).basic.availableAmount,
            lockAAmount,
            `lockA (${lockIdA}) created with 10000 tokens`
        );

        // Nonexistent lockId
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                999999999, recipient.address, 1, [], []
            ),
            'Unlock of a nonexistent lockId',
            'No lock found for this lockId'
        );

        // Withdrawal above the lock's availableAmount
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdA, recipient.address, lockAAmount + 1n, [], []
            ),
            'Unlock above the lock available amount',
            'Insufficient available amount in lock'
        );

        // "Insufficient contract balance": availableAmount >= amount but the
        // contract's token balance is below amount. That state is unreachable
        // through the contract API, so it is engineered by rewriting the
        // locker's balance slot of a fresh mock token (what a deflationary /
        // rebasing token would cause), then restored.
        logSection('Create lockU on tokenU, then drain the locker balance via hardhat_setStorageAt');
        const lockUAmount = ethers.parseEther('1000');
        await (await tokenU.connect(executor).approve(lockerAddress, lockUAmount)).wait();
        const lockIdU = await lockManager.nextLockId();
        await (await locker.connect(executor).createLock(makeLockParams(tokenUAddress, lockUAmount))).wait();
        assertEqual(await tokenU.balanceOf(lockerAddress), lockUAmount, 'Locker holds 1000 DRN49');

        // ERC20USDTMock storage layout: name(0), symbol(1), decimals(2),
        // totalSupply(3), balanceOf(4) => slot = keccak256(abi.encode(holder, 4))
        const balanceSlot = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [lockerAddress, 4n])
        );
        await ethers.provider.send('hardhat_setStorageAt', [
            tokenUAddress, balanceSlot, ethers.toBeHex(1n, 32)
        ]);
        assertEqual(await tokenU.balanceOf(lockerAddress), 1n, 'Locker balance drained to 1 wei (slot verified)');

        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdU, recipient.address, ethers.parseEther('500'), [], []
            ),
            'Unlock while contract balance is below the requested amount',
            'Insufficient contract balance'
        );

        // Restore the drained balance to keep accounting consistent
        await ethers.provider.send('hardhat_setStorageAt', [
            tokenUAddress, balanceSlot, ethers.toBeHex(lockUAmount, 32)
        ]);
        assertEqual(await tokenU.balanceOf(lockerAddress), lockUAmount, 'Locker balance restored');
        pass('Drained balance engineered, asserted and restored');

        // ════════════════════════════════════════════════════════════════
        // PHASE 3: "Insufficient approvals" via the three multi-sig entry points
        // ════════════════════════════════════════════════════════════════
        logPhase(3, `"Insufficient approvals" with ${T0 - 1} of ${T0} required signatures`);

        // Pre-sign the unlock bundle U (also reused in phases 4/5)
        const unlockAmount = ethers.parseEther('1000');
        const unlockNonceU = await locker.unlockNonce(lockIdA);
        const sigsU = await collectSignatures(
            'Unlock',
            { lockId: lockIdA, to: recipient.address, amount: unlockAmount, nonce: unlockNonceU },
            initialSigners, T0, domain
        );

        // Unlock entry point, one signature short
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdA, recipient.address, unlockAmount,
                sigsU.addresses.slice(0, T0 - 1), sigsU.signatures.slice(0, T0 - 1)
            ),
            `Unlock with ${T0 - 1} signatures`,
            'Insufficient approvals'
        );

        // Threshold entry point, a single signature (newThreshold == current, harmless if it executed)
        const tnProbe = await locker.thresholdNonce();
        const sigsTProbe = await collectSignatures(
            'UpdateThreshold', { newThreshold: T0, nonce: tnProbe }, initialSigners, 1, domain
        );
        await expectRevert(
            () => locker.connect(executor).updateThresholdWithSignatures(
                T0, sigsTProbe.addresses, sigsTProbe.signatures
            ),
            'Threshold update with 1 signature',
            'Insufficient approvals'
        );

        // Batch entry point: remove+re-add swap of the last signer, one signature short
        const swapSigner = initialSigners[C - 1];
        const bnProbe = await locker.batchUpdateSignersNonce();
        const sigsBProbe = await collectSignatures(
            'BatchUpdateSigners',
            { signersToRemove: [swapSigner], signersToAdd: [swapSigner], nonce: bnProbe },
            initialSigners, T0 - 1, domain
        );
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                [swapSigner], [swapSigner], sigsBProbe.addresses, sigsBProbe.signatures
            ),
            `Batch signers update with ${T0 - 1} signatures`,
            'Insufficient approvals'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 4: Threshold raise/restore, replay, and configEpoch semantics
        // ════════════════════════════════════════════════════════════════
        logPhase(4, 'updateThresholdWithSignatures: execute, replay, epoch semantics');

        const epoch0 = await validationHandler.configEpoch();
        const tn0 = await locker.thresholdNonce();

        // Raise T0 -> T0+1 with T0 signatures
        const sigsRaise = await collectSignatures(
            'UpdateThreshold', { newThreshold: T0 + 1, nonce: tn0 }, initialSigners, T0, domain
        );
        await (await locker.connect(executor).updateThresholdWithSignatures(
            T0 + 1, sigsRaise.addresses, sigsRaise.signatures
        )).wait();
        assertEqual(await locker.approvalsThreshold(), T0 + 1, `Threshold raised to ${T0 + 1}`);
        assertEqual(await locker.thresholdNonce(), tn0 + 1n, 'thresholdNonce incremented');
        assertEqual(await validationHandler.configEpoch(), epoch0 + 1n, 'configEpoch bumped by threshold update');
        pass('Threshold raised via multisig (nonce + epoch moved)');

        // REPLAY: exact same call with the SAME signatures. thresholdNonce moved,
        // so the contract derives a different opKey and the stale signatures
        // cannot verify against it. ('Operation already executed' is unreachable:
        // the executed opKey can never be re-derived, see header note.)
        await expectRevert(
            () => locker.connect(executor).updateThresholdWithSignatures(
                T0 + 1, sigsRaise.addresses, sigsRaise.signatures
            ),
            'Replay of the executed threshold update',
            'ERR_005: Invalid signature'
        );
        assertEqual(await locker.approvalsThreshold(), T0 + 1, 'Threshold unchanged by rejected replay');

        // "Count below threshold": only reachable while threshold > 3.
        // newCount = C - (C - T0) = T0 >= 3 but < T0+1.
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                initialSigners.slice(0, C - T0), [], [], []
            ),
            `Batch update dropping signer count to ${T0} while threshold is ${T0 + 1}`,
            'Count below threshold'
        );

        // Governance-change invalidation: the unlock bundle was signed when the
        // threshold was T0. bumpConfigEpoch guarantees nothing stayed registered;
        // re-submission re-registers the T0 approvals under the new config, where
        // T0 < T0+1 no longer meets quorum.
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdA, recipient.address, unlockAmount, sigsU.addresses, sigsU.signatures
            ),
            `Pre-signed ${T0}-signature unlock bundle after the threshold raise`,
            'Insufficient approvals'
        );

        // Restore the original threshold (needs T0+1 signatures now)
        const tn1 = await locker.thresholdNonce();
        const sigsRestore = await collectSignatures(
            'UpdateThreshold', { newThreshold: T0, nonce: tn1 }, initialSigners, T0 + 1, domain
        );
        await (await locker.connect(executor).updateThresholdWithSignatures(
            T0, sigsRestore.addresses, sigsRestore.signatures
        )).wait();
        assertEqual(await locker.approvalsThreshold(), T0, `Threshold restored to ${T0}`);
        assertEqual(await validationHandler.configEpoch(), epoch0 + 2n, 'configEpoch bumped again by the restore');
        pass('Threshold restored via multisig');

        // Replay of the restore call must fail the same way
        await expectRevert(
            () => locker.connect(executor).updateThresholdWithSignatures(
                T0, sigsRestore.addresses, sigsRestore.signatures
            ),
            'Replay of the executed threshold restore',
            'ERR_005: Invalid signature'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 5: executeUnlockWithSignatures: execute, then replay
        // ════════════════════════════════════════════════════════════════
        logPhase(5, 'executeUnlockWithSignatures: execute the pre-signed bundle, then replay it');

        // unlockNonce[lockIdA] never moved, so the bundle U is still bound to the
        // current opKey. Two configEpoch bumps happened since it was signed:
        // offline signatures survive them by design (only registered approvals
        // are invalidated, and none can be pre-registered — batchApprove is onlyLocker).
        assertEqual(await locker.unlockNonce(lockIdA), 0n, 'unlockNonce still at 0 before execution');
        const recipientBefore = await tokenA.balanceOf(recipient.address);

        await (await locker.connect(executor).executeUnlockWithSignatures(
            lockIdA, recipient.address, unlockAmount, sigsU.addresses, sigsU.signatures
        )).wait();
        assertEqual(
            (await tokenA.balanceOf(recipient.address)) - recipientBefore,
            unlockAmount,
            'Unlock delivered 1000 tokens (bundle valid across epoch bumps)'
        );
        assertEqual(await locker.unlockNonce(lockIdA), 1n, 'unlockNonce incremented by execution');
        pass('Pre-signed unlock bundle executed after governance round-trip');

        // REPLAY: identical params + identical signatures. The lock still holds
        // 9000 tokens so _validateUnlockRequest passes; the replay must die on
        // the nonce-derived opKey, not on a balance check.
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdA, recipient.address, unlockAmount, sigsU.addresses, sigsU.signatures
            ),
            'Replay of the executed unlock (same params + same signatures)',
            'ERR_005: Invalid signature'
        );
        assertEqual(await locker.unlockNonce(lockIdA), 1n, 'unlockNonce unchanged by rejected replay');
        assertEqual(
            (await tokenA.balanceOf(recipient.address)) - recipientBefore,
            unlockAmount,
            'No extra tokens delivered by the replay attempt'
        );
        assertEqual(
            (await lockManager.getLock(lockIdA)).basic.availableAmount,
            lockAAmount - unlockAmount,
            'lockA still holds the remaining 9000 tokens'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 6: batchUpdateSignersWithSignatures: execute a swap, then replay
        // ════════════════════════════════════════════════════════════════
        logPhase(6, 'batchUpdateSignersWithSignatures: execute remove+re-add swap, then replay');

        // Removing and re-adding the LAST signer executes a real batch update
        // (events, nonce++, epoch bump) while leaving the signer list
        // byte-identical, order included (swap-and-pop touches the last slot only).
        const bn0 = await locker.batchUpdateSignersNonce();
        const epochBeforeBatch = await validationHandler.configEpoch();
        // C > T0, so the first T0 signers never include the swapped last signer
        const sigsB = await collectSignatures(
            'BatchUpdateSigners',
            { signersToRemove: [swapSigner], signersToAdd: [swapSigner], nonce: bn0 },
            initialSigners, T0, domain
        );

        await (await locker.connect(executor).batchUpdateSignersWithSignatures(
            [swapSigner], [swapSigner], sigsB.addresses, sigsB.signatures
        )).wait();
        assertEqual(await locker.batchUpdateSignersNonce(), bn0 + 1n, 'batchUpdateSignersNonce incremented');
        assertEqual(
            await validationHandler.configEpoch(),
            epochBeforeBatch + 1n,
            'configEpoch bumped by the batch update'
        );
        assertEqual(
            (await locker.getSigners()).join(','),
            initialSigners.join(','),
            'Signer list unchanged by the swap (same members, same order)'
        );
        pass('Batch signers update executed (remove+re-add swap)');

        // REPLAY: same call + same signatures. _validateBatchUpdate passes again
        // (the swap is idempotent), so the replay must die on the nonce-derived opKey.
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                [swapSigner], [swapSigner], sigsB.addresses, sigsB.signatures
            ),
            'Replay of the executed batch signers update',
            'ERR_005: Invalid signature'
        );
        assertEqual(await locker.batchUpdateSignersNonce(), bn0 + 1n, 'Nonce unchanged by rejected replay');
        assertEqual(
            (await locker.getSigners()).join(','),
            initialSigners.join(','),
            'Signer list unchanged by rejected replay'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 7: createLockWithSignatures: execute, then replay
        // ════════════════════════════════════════════════════════════════
        logPhase(7, 'createLockWithSignatures: execute, then replay the same params+signature');

        const cn0 = await locker.createLockNonce();
        const lockCParams = makeLockParams(tokenAAddress, ethers.parseEther('500'));
        const executorWallet = await ethers.getSigner(executor.address);
        const sigC = await signLockerOp(executorWallet, domain, 'CreateLock', {
            token: lockCParams.token,
            amount: lockCParams.amount,
            lockDuration: lockCParams.lockDuration,
            pair: lockCParams.pair,
            ethUsdPair: lockCParams.ethUsdPair,
            targetPriceUSD1e18: lockCParams.targetPriceUSD1e18,
            isEthPair: lockCParams.isEthPair,
            stablecoinPosition: lockCParams.stablecoinPosition,
            priceDirection: lockCParams.priceDirection,
            vestingTokensPerPeriod: lockCParams.vestingTokensPerPeriod,
            vestingPeriodSeconds: lockCParams.vestingPeriodSeconds,
            vestingAccumulate: lockCParams.vestingAccumulate,
            nonce: cn0,
            signer: executor.address
        });

        await (await tokenA.connect(executor).approve(lockerAddress, lockCParams.amount)).wait();
        const lockIdC = await lockManager.nextLockId();
        await (await locker.connect(executor).createLockWithSignatures(
            lockCParams, { signer: executor.address, signature: sigC }
        )).wait();
        assertEqual(
            (await lockManager.getLock(lockIdC)).basic.totalAmount,
            lockCParams.amount,
            `lockC (${lockIdC}) created via signature`
        );
        assertEqual(await locker.createLockNonce(), cn0 + 1n, 'createLockNonce incremented');
        pass('createLockWithSignatures executed');

        // REPLAY: identical params + same signature. createLockNonce moved, the
        // opKey embeds it, and verifySignatureOnly (which runs BEFORE any token
        // transfer) rejects the stale signature with INV_SIG.
        await expectRevert(
            () => locker.connect(executor).createLockWithSignatures(
                lockCParams, { signer: executor.address, signature: sigC }
            ),
            'Replay of the executed createLockWithSignatures',
            'INV_SIG'
        );
        assertEqual(await locker.createLockNonce(), cn0 + 1n, 'createLockNonce unchanged by rejected replay');
        assertEqual(await lockManager.nextLockId(), lockIdC + 1n, 'No extra lock created by the replay attempt');

        // ════════════════════════════════════════════════════════════════
        // FINAL: isolation — multisig configuration is exactly as we found it
        // ════════════════════════════════════════════════════════════════
        logPhase(8, 'Isolation: signer set and threshold restored');
        assertEqual(
            (await locker.getSigners()).join(','),
            initialSigners.join(','),
            'Signer set identical to the initial one'
        );
        assertEqual(await locker.approvalsThreshold(), BigInt(T0), 'Threshold identical to the initial one');
        assertEqual(await tokenU.balanceOf(lockerAddress), lockUAmount, 'tokenU backing balance intact');
        pass('State isolation preserved');

        log(`\n📊 Checks passed: ${passed}, failed: ${failed}\n`, '\x1b[1m\x1b[32m');
        reportTestResult('49-batch-update-and-replay', true);
        logSuccess('\n✅ TEST 49 PASSED!\n');

    } catch (error) {
        failed++;
        log(`\n📊 Checks passed: ${passed}, failed: ${failed}\n`, '\x1b[1m\x1b[31m');
        reportTestResult('49-batch-update-and-replay', false, error.message);
        throw error;
    }
}

// ============================================================================
// RUN
// ============================================================================

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
