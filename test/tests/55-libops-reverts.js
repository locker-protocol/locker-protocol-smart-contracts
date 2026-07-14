/**
 * TEST 55: Library operations revert coverage (LockerLockOperations,
 *          LockerSignerOperations, LockerInternal) via LockerContract entry points
 *
 * The three libraries are `internal` — every branch here is reached ONLY through
 * the public functions of LockerContract (addToLock, executeUnlockWithSignatures,
 * executeRescueWithSignatures, updateThresholdWithSignatures,
 * batchUpdateSignersWithSignatures).
 *
 * REACHABILITY NOTES (validated against the current code):
 *
 * - ValidationHandler has NO approveOperationFor / external approval surface:
 *   batchApproveWithSignatures is onlyLocker, so approvals can never be
 *   pre-registered organically — every entry point runs approve+validate+execute
 *   in one tx. The 'Op expired' / '(Op|Operation) already executed' branches of
 *   the three *_validateOp helpers are therefore ORGANICALLY unreachable
 *   (each success also bumps its nonce, so the next call derives a FRESH opKey).
 *   They are covered here by impersonating the LockerContract address
 *   (hardhat_impersonateAccount — same technique as test 52) to pre-populate
 *   ValidationHandler state, then hitting the real public entry points.
 *
 * - 'No approvals yet' (all three libs) is UNREACHABLE, even with impersonation:
 *   the check runs AFTER approvalsCount >= threshold (>= 3), and every approval
 *   registration writes lastApprovalTime = block.timestamp != 0 in the same
 *   storage update that increments the count. Epoch invalidation zeroes the
 *   effective count (caught by 'Insufficient approvals' first), never the
 *   timestamp. Dead defensive code — documented, not forced.
 *
 * - _executeUnlock's 'No lock found for this lockId' and 'Insufficient contract
 *   balance for unlock' are SHADOWED by LockerContract._validateUnlockRequest,
 *   which performs the same checks first (strings 'No lock found for this lockId'
 *   and 'Insufficient contract balance'). Nothing between the wrapper check and
 *   the lib check can delete a lock or move tokens, so the lib copies never fire.
 *
 * - ERR_008 (multi-lock => explicit amount) is partially covered by test 40
 *   (with surplus); here we complete it: it fires even with ZERO surplus,
 *   proving the single-lock check precedes all balance math.
 *
 * - 'No tokens received' requires a fee-on-transfer token: uses the new
 *   ERC20FeeMock (contracts/ERC20FeeMock.sol). Its sender-side burn mode also
 *   lets us drive the contract balance below/at odds with lock accounting to
 *   reach 'Contract balance less than lock amount' and
 *   'Contract has no balance for this token'.
 */

import {
    loadSharedState,
    log,
    logSuccess,
    logError,
    logWarning,
    logPhase,
    logSection,
    assert,
    assertEqual,
    advanceTime,
    reportTestResult,
    getEthers,
    signLockerOp,
    lockerOpKey
} from '../core/utils.js';

const ethers = getEthers();

// secp256k1 curve order (for the malleability negative)
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ============================================================================
// HELPERS
// ============================================================================

function revertText(error) {
    return [error.shortMessage, error.reason, error.message]
        .filter(Boolean)
        .join(' | ');
}

async function expectRevert(callFn, expectedSubstring, label) {
    try {
        const tx = await callFn();
        if (tx && tx.wait) await tx.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 160)}`);
        assert(
            text.includes(expectedSubstring),
            `${label}: expected revert containing "${expectedSubstring}", got: ${text.substring(0, 250)}`
        );
        logSuccess(`${label} → reverted with "${expectedSubstring}"`);
        return text;
    }
    throw new Error(`${label}: expected revert but call succeeded`);
}

async function buildDomain(lockerAddress) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return {
        name: 'LockerContract',
        version: '1',
        chainId: Number(chainId),
        verifyingContract: lockerAddress
    };
}

async function collectSigs(primaryType, message, signerWallets, domain) {
    const addresses = [];
    const signatures = [];
    for (const w of signerWallets) {
        addresses.push(w.address);
        signatures.push(await signLockerOp(w, domain, primaryType, message));
    }
    return { addresses, signatures };
}

function lockParams(token, amount, duration) {
    return {
        token,
        amount,
        lockDuration: duration,
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

function thresholdOpKey(newThreshold, nonce) {
    return lockerOpKey('UpdateThreshold', { newThreshold, nonce });
}

function batchUpdateOpKey(toRemove, toAdd, nonce) {
    return lockerOpKey('BatchUpdateSigners', { signersToRemove: toRemove, signersToAdd: toAdd, nonce });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 55: LIB OPS REVERT COVERAGE (LockerLockOperations / LockerSignerOperations / LockerInternal)\n', '\x1b[1m\x1b[36m');

    loadSharedState(); // sanity: suite is set up (isolated contracts deployed below)

    const wallets = await ethers.getSigners();
    const deployer = wallets[0];
    const s1 = wallets[1];
    const s2 = wallets[2];
    const s3 = wallets[3];
    const recipient = wallets[5];
    const nonSigner = wallets[7];
    const newSigner = wallets[8];   // added by the successful batch update
    const spare9 = wallets[9];      // param for impersonated 'Op already executed'
    const spare10 = wallets[10];    // param for impersonated 'Op expired'
    const signerWallets = [s1, s2, s3];
    const signerAddresses = signerWallets.map(w => w.address);

    // ========================================================================
    // PHASE 0: isolated deployment (own multisig 3-of-3, own tokens)
    // ========================================================================
    logPhase(0, 'Deploy isolated contract stack (3 signers, threshold 3)');

    const VH = await ethers.getContractFactory('ValidationHandler');
    const vh = await VH.deploy(3);
    await vh.waitForDeployment();

    const PC = await ethers.getContractFactory('PriceCalculator');
    const pc = await PC.deploy(ethers.ZeroAddress, []);
    await pc.waitForDeployment();

    const LM = await ethers.getContractFactory('LockManager');
    const lm = await LM.deploy(await pc.getAddress());
    await lm.waitForDeployment();

    const VM = await ethers.getContractFactory('VestingManager');
    const vm = await VM.deploy(await lm.getAddress());
    await vm.waitForDeployment();

    const SM = await ethers.getContractFactory('SignerManager');
    const sm = await SM.deploy(await vh.getAddress(), signerAddresses, 3);
    await sm.waitForDeployment();

    const LC = await ethers.getContractFactory('LockerContract');
    const locker = await LC.deploy(
        await vh.getAddress(),
        await lm.getAddress(),
        await sm.getAddress(),
        await vm.getAddress(),
        signerAddresses,
        3
    );
    await locker.waitForDeployment();
    const lockerAddr = await locker.getAddress();
    const domain = await buildDomain(lockerAddr);
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
    const tokenA = await ERC20Mock.deploy('LibOps A', 'LOA', deployer.address, ethers.parseEther('100000'), 18);
    await tokenA.waitForDeployment();
    const tokenAAddr = await tokenA.getAddress();

    const FeeMock = await ethers.getContractFactory('ERC20FeeMock');
    const feeToken = await FeeMock.deploy('LibOps Fee', 'LOF', deployer.address, ethers.parseEther('100000'));
    await feeToken.waitForDeployment();
    const feeTokenAddr = await feeToken.getAddress();

    await (await tokenA.transfer(s1.address, ethers.parseEther('2000'))).wait();
    await (await tokenA.connect(s1).approve(lockerAddr, ethers.parseEther('2000'))).wait();
    await (await feeToken.transfer(s1.address, ethers.parseEther('300'))).wait();
    await (await feeToken.connect(s1).approve(lockerAddr, ethers.parseEther('300'))).wait();

    logSuccess('Isolated stack + tokens deployed');

    // ========================================================================
    // PHASE 1: LockerLockOperations top-up reverts via addToLock (auto-detect)
    // ========================================================================
    logPhase(1, 'addToLock — LockerLockOperations._calculateAmount* reverts');

    logSection("1.1 amount=0 on non-existent lock → 'No lock exists for this lock ID'");
    // getLock() returns an empty struct for a missing id (no revert upstream),
    // so the library's own token != 0 check is the one that fires.
    await expectRevert(
        () => locker.connect(s1).addToLock(9999, 0, ethers.ZeroHash),
        'No lock exists for this lock ID',
        'addToLock(9999, 0)'
    );

    logSection('1.2 single lock, balance == availableAmount → \'No additional amount to add\'');
    const lockA1 = await lm.nextLockId();
    await (await locker.connect(s1).createLock(lockParams(tokenAAddr, ethers.parseEther('1000'), 0))).wait();
    logSuccess(`Lock A1 #${lockA1} created (1000 LOA, duration 0 → immediately unlockable)`);
    await expectRevert(
        () => locker.connect(s1).addToLock(lockA1, 0, ethers.ZeroHash),
        'No additional amount to add',
        'addToLock(lockA1, 0) with zero surplus'
    );

    logSection("1.3 two locks of the same token, ZERO surplus → 'ERR_008' (completes test 40)");
    // Test 40 covers ERR_008 WITH a surplus; here we show the single-lock guard
    // fires before any balance/surplus math — even when there is nothing to add.
    const lockA2 = await lm.nextLockId();
    await (await locker.connect(s1).createLock(lockParams(tokenAAddr, ethers.parseEther('500'), 3600))).wait();
    logSuccess(`Lock A2 #${lockA2} created (500 LOA) — token now has 2 locks`);
    await expectRevert(
        () => locker.connect(s1).addToLock(lockA1, 0, ethers.ZeroHash),
        'ERR_008',
        'addToLock(lockA1, 0) with 2 locks and no surplus'
    );

    logSection("1.4 fee-on-transfer (100% transit fee) → 'No tokens received'");
    const lockC = await lm.nextLockId();
    await (await locker.connect(s1).createLock(lockParams(feeTokenAddr, ethers.parseEther('100'), 0))).wait();
    logSuccess(`Lock C #${lockC} created (100 LOF, fees off)`);
    await (await feeToken.setReceiveFeeBps(10000)).wait(); // 100% burned in transit
    await expectRevert(
        () => locker.connect(s1).addToLock(lockC, ethers.parseEther('50'), ethers.ZeroHash),
        'No tokens received',
        'addToLock(lockC, 50) with 100% fee-on-transfer'
    );
    await (await feeToken.setReceiveFeeBps(0)).wait();

    logSection("1.5 drain real balance below accounting → 'Contract balance less than lock amount'");
    // senderBurnBps=10000: every outgoing transfer burns amount extra from the
    // Locker, so its real balance falls below the lock's availableAmount.
    await (await feeToken.setSenderBurnBps(10000)).wait();

    const unlock1Amount = ethers.parseEther('10');
    const unlock1Nonce = await locker.unlockNonce(lockC);
    const unlock1Sigs = await collectSigs('Unlock', { lockId: lockC, to: recipient.address, amount: unlock1Amount, nonce: unlock1Nonce }, signerWallets, domain);
    await (await locker.connect(s1).executeUnlockWithSignatures(
        lockC, recipient.address, unlock1Amount, unlock1Sigs.addresses, unlock1Sigs.signatures
    )).wait();
    assertEqual(await feeToken.balanceOf(lockerAddr), ethers.parseEther('80'), 'Locker LOF balance after burn-unlock (100-10-10)');
    assertEqual((await locker.locks(lockC)).basic.availableAmount, ethers.parseEther('90'), 'Lock C availableAmount');

    // Organic replay of the executed unlock NEVER reaches 'Operation already
    // executed': unlockNonce moved, so the entry point derives a FRESH opKey.
    // Stale signatures recover a non-signer over the new key → ERR_005; and with
    // no signatures at all the fresh key simply has no approvals.
    await expectRevert(
        () => locker.connect(s1).executeUnlockWithSignatures(
            lockC, recipient.address, unlock1Amount, unlock1Sigs.addresses, unlock1Sigs.signatures
        ),
        'ERR_005: Invalid signature',
        'Organic replay with stale signatures (fresh opKey — shadows \'Operation already executed\')'
    );
    await expectRevert(
        () => locker.connect(s1).executeUnlockWithSignatures(
            lockC, recipient.address, unlock1Amount, [], []
        ),
        'Insufficient approvals',
        'Organic replay with no signatures (fresh opKey → 0 approvals)'
    );

    await expectRevert(
        () => locker.connect(s1).addToLock(lockC, 0, ethers.ZeroHash),
        'Contract balance less than lock amount',
        'addToLock(lockC, 0) with balance 80 < availableAmount 90'
    );

    logSection("1.6 drain balance to exactly 0 → 'Contract has no balance for this token'");
    const unlock2Amount = ethers.parseEther('40');
    const unlock2Nonce = await locker.unlockNonce(lockC);
    const unlock2Sigs = await collectSigs('Unlock', { lockId: lockC, to: recipient.address, amount: unlock2Amount, nonce: unlock2Nonce }, signerWallets, domain);
    await (await locker.connect(s1).executeUnlockWithSignatures(
        lockC, recipient.address, unlock2Amount, unlock2Sigs.addresses, unlock2Sigs.signatures
    )).wait();
    assertEqual(await feeToken.balanceOf(lockerAddr), 0n, 'Locker LOF balance drained to 0 (80-40-40)');
    assertEqual((await locker.locks(lockC)).basic.availableAmount, ethers.parseEther('50'), 'Lock C still holds 50 in accounting');
    await expectRevert(
        () => locker.connect(s1).addToLock(lockC, 0, ethers.ZeroHash),
        'Contract has no balance for this token',
        'addToLock(lockC, 0) with zero contract balance'
    );

    // ========================================================================
    // PHASE 2: _executeUnlock lib checks are SHADOWED by _validateUnlockRequest
    // ========================================================================
    logPhase(2, '_executeUnlock shadowing by LockerContract._validateUnlockRequest');

    logSection('2.1 non-existent lock: the WRAPPER fires first (same string as the lib)');
    // Both wrapper and lib use 'No lock found for this lockId'. The wrapper runs
    // before batchApprove — which cannot delete locks — so the lib's copy is
    // unreachable. Empty signature arrays prove the revert precedes approvals.
    await expectRevert(
        () => locker.connect(deployer).executeUnlockWithSignatures(9999, recipient.address, 1, [], []),
        'No lock found for this lockId',
        'executeUnlockWithSignatures on missing lock (wrapper check, lib copy shadowed)'
    );

    logSection("2.2 drained balance: wrapper 'Insufficient contract balance' shadows lib's '... for unlock'");
    const text22 = await expectRevert(
        () => locker.connect(deployer).executeUnlockWithSignatures(
            lockC, recipient.address, ethers.parseEther('10'), [], []
        ),
        'Insufficient contract balance',
        'executeUnlockWithSignatures with balance 0 < amount <= availableAmount'
    );
    assert(
        !text22.includes('Insufficient contract balance for unlock'),
        "Expected the WRAPPER message — lib's 'Insufficient contract balance for unlock' must be shadowed"
    );
    logSuccess("Confirmed: revert came from _validateUnlockRequest, lib's 'for unlock' variant is dead code");

    logSection("2.3 LockerLockOperations._validateOp: 2-of-3 signatures → 'Insufficient approvals'");
    const underNonce = await locker.unlockNonce(lockA1);
    const underSigs = await collectSigs('Unlock', { lockId: lockA1, to: recipient.address, amount: ethers.parseEther('6'), nonce: underNonce }, [s1, s2], domain);
    await expectRevert(
        () => locker.connect(s1).executeUnlockWithSignatures(
            lockA1, recipient.address, ethers.parseEther('6'), underSigs.addresses, underSigs.signatures
        ),
        'Insufficient approvals',
        'executeUnlockWithSignatures with 2 of 3 required signatures'
    );

    // ========================================================================
    // PHASE 3: LockerSignerOperations via updateThresholdWithSignatures
    // ========================================================================
    logPhase(3, 'LockerSignerOperations — threshold bounds + _batchApprove negatives');

    logSection('3.1 bounds (checked before any signature work — empty arrays suffice)');
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(2, [], []),
        'Threshold too low (minimum is 3)',
        'updateThresholdWithSignatures(2)'
    );
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(4, [], []),
        'Threshold too high (max is signer count)',
        'updateThresholdWithSignatures(4) with 3 signers'
    );

    logSection("3.2 _validateOp: 1-of-3 signatures → 'Insufficient approvals'");
    const thNonce = await locker.thresholdNonce();
    const thMsg = { newThreshold: 3, nonce: thNonce };
    const sigT1 = await signLockerOp(s1, domain, 'UpdateThreshold', thMsg);
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(3, [s1.address], [sigT1]),
        'Insufficient approvals',
        'updateThresholdWithSignatures(3) with a single signature'
    );

    logSection('3.3 _batchApprove negatives (through ValidationHandler.batchApproveWithSignatures)');
    // Non-signer in the array
    const sigT_nonSigner = await signLockerOp(nonSigner, domain, 'UpdateThreshold', thMsg);
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(3, [nonSigner.address], [sigT_nonSigner]),
        'ERR_001: Not authorized signer',
        'Non-signer address in the signers array'
    );

    // Malleable signature: flip s into the upper half of the curve order
    const sigObj = ethers.Signature.from(sigT1);
    const malleable = ethers.concat([
        sigObj.r,
        ethers.toBeHex(SECP256K1_N - BigInt(sigObj.s), 32),
        ethers.toBeHex(sigObj.v === 27 ? 28 : 27, 1)
    ]);
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(3, [s1.address], [malleable]),
        "ERR_006: Invalid signature 's' value",
        'Malleable (high-s) signature'
    );

    // Malformed length (64 bytes)
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(3, [s1.address], [ethers.dataSlice(sigT1, 0, 64)]),
        'ERR_006B: Invalid signature length',
        '64-byte signature'
    );

    // Valid signer, but signature produced by someone else
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(3, [s2.address], [sigT1]),
        'ERR_005: Invalid signature',
        "s1's signature attributed to s2"
    );

    // signers/signatures length mismatch
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(3, [s1.address, s2.address], [sigT1]),
        'Array length mismatch',
        'signers/signatures arrays of different lengths'
    );

    // ========================================================================
    // PHASE 4: LockerInternal.validateOp via batchUpdateSignersWithSignatures
    // ========================================================================
    logPhase(4, 'LockerInternal.validateOp via batchUpdateSignersWithSignatures');

    logSection("4.1 2-of-3 signatures → 'Insufficient approvals'");
    const buNonce0 = await locker.batchUpdateSignersNonce();
    const opKeyB0 = batchUpdateOpKey([], [newSigner.address], buNonce0);
    const bMsg0 = { signersToRemove: [], signersToAdd: [newSigner.address], nonce: buNonce0 };
    const sigsB0_partial = await collectSigs('BatchUpdateSigners', bMsg0, [s1, s2], domain);
    await expectRevert(
        () => locker.connect(s1).batchUpdateSignersWithSignatures(
            [], [newSigner.address], sigsB0_partial.addresses, sigsB0_partial.signatures
        ),
        'Insufficient approvals',
        'batchUpdateSignersWithSignatures with 2 of 3 signatures'
    );

    logSection('4.2 successful add (nonce & epoch bump), then organic replay demos');
    const sigsB0_full = await collectSigs('BatchUpdateSigners', bMsg0, signerWallets, domain);
    await (await locker.connect(s1).batchUpdateSignersWithSignatures(
        [], [newSigner.address], sigsB0_full.addresses, sigsB0_full.signatures
    )).wait();
    assert(await locker.isSigner(newSigner.address), 'newSigner added');
    assert(await vh.hasExecuted(opKeyB0), 'executed opKey is permanently recorded');
    assertEqual(await locker.batchUpdateSignersNonce(), buNonce0 + 1n, 'batchUpdateSignersNonce bumped');
    assertEqual(await vh.configEpoch(), 1n, 'configEpoch bumped by governance change');
    logSuccess('Signer set is now 4 (threshold still 3)');

    // Organic replay of the EXECUTED batch op never reaches validateOp's
    // 'Op already executed': the parameter guard fires first (the signer now
    // exists), and even with fresh params the nonce moved → fresh opKey.
    await expectRevert(
        () => locker.connect(s1).batchUpdateSignersWithSignatures(
            [], [newSigner.address], sigsB0_full.addresses, sigsB0_full.signatures
        ),
        'Signer already exists',
        "Organic replay of executed batch update (param guard precedes 'Op already executed')"
    );
    await expectRevert(
        () => locker.connect(s1).batchUpdateSignersWithSignatures(
            [], [spare9.address], [], []
        ),
        'Insufficient approvals',
        'Fresh params + no signatures (fresh opKey at bumped nonce → 0 approvals)'
    );

    // ========================================================================
    // PHASE 5: LockerLockOperations.executeRescue — token with an active lock
    // ========================================================================
    logPhase(5, "executeRescue on a LOCKED token → 'Lock exists for this token - use unlock instead'");

    const rescueNonceBefore = await locker.rescueNonce();
    const rescueAmount = ethers.parseEther('1');
    const rescueSigs = await collectSigs('RescueToken', { token: tokenAAddr, to: recipient.address, amount: rescueAmount, chainId, nonce: rescueNonceBefore }, signerWallets, domain);
    // Full threshold is provided: batchApprove, validateOp and markAsExecuted all
    // succeed — the revert comes from the library's lock-existence guard, and the
    // whole tx (nonce bump included) rolls back.
    await expectRevert(
        () => locker.connect(s1).executeRescueWithSignatures(
            tokenAAddr, recipient.address, rescueAmount, rescueSigs.addresses, rescueSigs.signatures
        ),
        'Lock exists for this token - use unlock instead',
        'executeRescueWithSignatures on a token that has locks'
    );
    assertEqual(await locker.rescueNonce(), rescueNonceBefore, 'rescueNonce rolled back with the revert');

    // ========================================================================
    // PHASE 6: expired / already-executed *_validateOp branches
    // ========================================================================
    logPhase(6, "Expired & already-executed branches (impersonated Locker pre-populates approvals)");

    logSection('6.0 organic pre-approval surface is CLOSED (documents unreachability)');
    const approveLikeFns = vh.interface.fragments
        .filter(f => f.type === 'function'
            && /approve/i.test(f.name)
            && f.stateMutability !== 'view'
            && f.stateMutability !== 'pure')
        .map(f => f.name);
    assertEqual(approveLikeFns.sort().join(','), 'batchApproveWithSignatures', 'Only state-changing approval entry in the VH ABI');
    log('  → no approveOperationFor / single-approve surface exists on ValidationHandler');
    await expectRevert(
        () => vh.connect(deployer).batchApproveWithSignatures(ethers.ZeroHash, [], []),
        'Only locker allowed',
        'Direct EOA call to batchApproveWithSignatures (onlyLocker)'
    );
    logWarning("'Op expired' / '(Op|Operation) already executed' are therefore organically unreachable:");
    log('  every public flow runs approve+validate+execute atomically and bumps its nonce,');
    log('  so approvals can never persist un-executed and executed opKeys are never re-derived.');
    log('  Covered below by impersonating the LockerContract address (test-52 technique).');

    await ethers.provider.send('hardhat_impersonateAccount', [lockerAddr]);
    await ethers.provider.send('hardhat_setBalance', [lockerAddr, '0x' + (10n ** 20n).toString(16)]);
    const lockerSigner = await ethers.getSigner(lockerAddr);

    // -- pre-register approvals for the EXPIRY branches (no markAsExecuted) --
    const expUnlockNonce = await locker.unlockNonce(lockA1);
    const expUnlockKey = await locker.getUnlockOpKey(lockA1, recipient.address, ethers.parseEther('5'));
    const expUnlockSigs = await collectSigs('Unlock', { lockId: lockA1, to: recipient.address, amount: ethers.parseEther('5'), nonce: expUnlockNonce }, signerWallets, domain);
    await (await vh.connect(lockerSigner).batchApproveWithSignatures(
        expUnlockKey, expUnlockSigs.addresses, expUnlockSigs.signatures
    )).wait();

    const buNonce1 = await locker.batchUpdateSignersNonce();
    const expBatchKey = batchUpdateOpKey([], [spare10.address], buNonce1);
    const expBatchSigs = await collectSigs('BatchUpdateSigners', { signersToRemove: [], signersToAdd: [spare10.address], nonce: buNonce1 }, signerWallets, domain);
    await (await vh.connect(lockerSigner).batchApproveWithSignatures(
        expBatchKey, expBatchSigs.addresses, expBatchSigs.signatures
    )).wait();

    const thNonceNow = await locker.thresholdNonce();
    const expThreshKey = thresholdOpKey(4, thNonceNow); // 4 is valid now: 4 signers
    const expThreshSigs = await collectSigs('UpdateThreshold', { newThreshold: 4, nonce: thNonceNow }, signerWallets, domain);
    await (await vh.connect(lockerSigner).batchApproveWithSignatures(
        expThreshKey, expThreshSigs.addresses, expThreshSigs.signatures
    )).wait();

    // -- pre-register + markAsExecuted for the ALREADY-EXECUTED branches --
    const execUnlockNonce = await locker.unlockNonce(lockA1);
    const execUnlockKey = await locker.getUnlockOpKey(lockA1, recipient.address, ethers.parseEther('7'));
    const execUnlockSigs = await collectSigs('Unlock', { lockId: lockA1, to: recipient.address, amount: ethers.parseEther('7'), nonce: execUnlockNonce }, signerWallets, domain);
    await (await vh.connect(lockerSigner).batchApproveWithSignatures(
        execUnlockKey, execUnlockSigs.addresses, execUnlockSigs.signatures
    )).wait();
    await (await vh.connect(lockerSigner).markAsExecuted(execUnlockKey)).wait();

    const execBatchKey = batchUpdateOpKey([], [spare9.address], buNonce1);
    const execBatchSigs = await collectSigs('BatchUpdateSigners', { signersToRemove: [], signersToAdd: [spare9.address], nonce: buNonce1 }, signerWallets, domain);
    await (await vh.connect(lockerSigner).batchApproveWithSignatures(
        execBatchKey, execBatchSigs.addresses, execBatchSigs.signatures
    )).wait();
    await (await vh.connect(lockerSigner).markAsExecuted(execBatchKey)).wait();

    const execThreshKey = thresholdOpKey(3, thNonceNow);
    const execThreshSigs = await collectSigs('UpdateThreshold', { newThreshold: 3, nonce: thNonceNow }, signerWallets, domain);
    await (await vh.connect(lockerSigner).batchApproveWithSignatures(
        execThreshKey, execThreshSigs.addresses, execThreshSigs.signatures
    )).wait();
    await (await vh.connect(lockerSigner).markAsExecuted(execThreshKey)).wait();

    await ethers.provider.send('hardhat_stopImpersonatingAccount', [lockerAddr]);
    logSuccess('Approvals pre-registered (3 expiry keys, 3 executed keys); impersonation stopped');

    logSection('6.1 already-executed branches (check order: batchApprove ERR_002 precedes _validateOp)');
    // With a non-empty signers array, ValidationHandler's per-signature guard
    // fires FIRST (ERR_002) — the lib string is only reachable with empty arrays.
    await expectRevert(
        () => locker.connect(s1).executeUnlockWithSignatures(
            lockA1, recipient.address, ethers.parseEther('7'), execUnlockSigs.addresses, execUnlockSigs.signatures
        ),
        'ERR_002: Operation already executed',
        'Executed opKey + signatures → ValidationHandler guard first'
    );
    await expectRevert(
        () => locker.connect(s1).executeUnlockWithSignatures(
            lockA1, recipient.address, ethers.parseEther('7'), [], []
        ),
        'Operation already executed',
        "LockerLockOperations._validateOp → 'Operation already executed'"
    );
    await expectRevert(
        () => locker.connect(s1).batchUpdateSignersWithSignatures(
            [], [spare9.address], [], []
        ),
        'Op already executed',
        "LockerInternal.validateOp → 'Op already executed'"
    );
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(3, [], []),
        'Operation already executed',
        "LockerSignerOperations._validateOp → 'Operation already executed'"
    );

    logSection('6.2 advance +24h+1s, then hit the expiry branch of each lib');
    await advanceTime(86401);

    await expectRevert(
        () => locker.connect(s1).executeUnlockWithSignatures(
            lockA1, recipient.address, ethers.parseEther('5'), [], []
        ),
        'Op expired',
        "LockerLockOperations._validateOp → 'Op expired'"
    );
    await expectRevert(
        () => locker.connect(s1).batchUpdateSignersWithSignatures(
            [], [spare10.address], [], []
        ),
        'Op expired',
        "LockerInternal.validateOp → 'Op expired'"
    );
    await expectRevert(
        () => locker.connect(s1).updateThresholdWithSignatures(4, [], []),
        'Op expired',
        "LockerSignerOperations._validateOp → 'Op expired'"
    );

    logSection("6.3 'No approvals yet' — UNREACHABLE in all three libs (documented)");
    log("  Check order is: hasExecuted → approvalsCount >= threshold → last != 0 → expiry.");
    log('  approvalsCount >= threshold (>= 3) requires registered approvals, and every');
    log('  registration writes lastApprovalTime = block.timestamp != 0 in the same update.');
    log('  Epoch invalidation zeroes the EFFECTIVE count (caught by \'Insufficient');
    log("  approvals' first), never the timestamp — 'No approvals yet' is dead defensive code.");
    logSuccess("'No approvals yet' documented as unreachable (not forced)");

    logSuccess('\n🎉 TEST 55 PASSED: library revert surfaces verified!\n');
    reportTestResult('55-libops-reverts', true);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        logError(`\n❌ TEST FAILED: 55-libops-reverts - ${error.message}\n`);
        reportTestResult('55-libops-reverts', false, error.message);
        console.error(error);
        process.exit(1);
    });
