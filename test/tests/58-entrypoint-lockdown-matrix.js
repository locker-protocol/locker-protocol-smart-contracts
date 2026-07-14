/**
 * Test 58: Entry-Point Lockdown Matrix
 *
 * Exhaustive access-control matrix: EVERY mutating external/public entry point of
 * every protocol contract is exercised by an unauthorized caller (attacker EOA, and
 * an authorized signer EOA where the distinction matters) and must reject.
 * Positive controls at the end prove the signature harness is well-formed, so the
 * rejections above are genuinely the guards firing — not malformed-input artifacts.
 *
 * Matrix (mutating entry points → guard):
 *
 *   Module wiring (tx.origin == deployer, one-shot):
 *     W1. LockManager.setLocker        fresh: attacker → "Only deployer" / re-init → "Z"
 *     W2. ValidationHandler.setLocker  fresh: attacker → "Only deployer" / re-init → "Already initialized"
 *     W3. SignerManager.setLocker      fresh: attacker → "Only deployer" / re-init → "Already initialized"
 *     W4. VestingManager.setLocker     fresh: attacker → "Only deployer" / re-init → "Already set or zero"
 *
 *   LockManager (onlyLocker — "NA"), from attacker AND from an authorized signer EOA:
 *     M1. createLock          M2. addToLock          M3. validateAndUnlock
 *     M4. unlockVestedAmount
 *
 *   SignerManager (onlyLocker — "Only locker allowed"), attacker AND signer EOA:
 *     G1. addSignerDirect     G2. removeSignerDirect
 *
 *   ValidationHandler (onlyLocker — "Only locker allowed"), attacker AND signer EOA:
 *     V1. setThreshold        V2. bumpConfigEpoch     V3. markAsExecuted
 *     V4. batchApproveWithSignatures with VALID full-quorum signatures, called by
 *         attacker → "Only locker allowed" (outsiders cannot pre-register approvals
 *         even with genuine signatures)
 *
 *   VestingManager (onlyLocker — "Not authorized"), attacker AND signer EOA:
 *     T1. initializeVesting   T2. unlockVested
 *
 *   LockerContract M-of-N quorum gates (threshold = 3):
 *     Q1. executeUnlockWithSignatures      0 sigs               → "Insufficient approvals"
 *     Q2. executeUnlockWithSignatures      2 sigs (threshold-1 boundary) → "Insufficient approvals"
 *     Q3. executeUnlockWithSignatures      same signer ×3        → "Insufficient approvals" (idempotent, counted once)
 *     Q4. executeUnlockWithSignatures      3 non-signer sigs     → "ERR_001"
 *     Q5. executeUnlockWithSignatures      3 valid sigs, tampered amount    → ERR_004/ERR_005 (param binding)
 *     Q6. executeUnlockWithSignatures      3 valid sigs, swapped recipient  → ERR_004/ERR_005 (param binding)
 *     Q7. updateThresholdWithSignatures    2 sigs → "Insufficient approvals"
 *     Q8. batchUpdateSignersWithSignatures 2 sigs → "Insufficient approvals"
 *     Q9. executeRescueWithSignatures      2 sigs → "Insufficient approvals"
 *     Q10. executeRescueNativeWithSignatures 2 sigs → "Insufficient approvals"
 *     Q11. unlockVestedWithSignatures      2 sigs → "Insufficient approvals"
 *
 *   LockerContract signer gates:
 *     S1. createLock by non-signer (funded + approved)     → NotSigner
 *     S2. createLockWithSignatures, non-signer as signer   → NotSigner
 *     S3. createLockWithSignatures, forged signature       → "INV_SIG"
 *     S4. addToLock (permissionless by design) can only pull the CALLER's funds:
 *         attacker without allowance → ERC20 revert, lock state unchanged
 *
 *   Positive controls:
 *     P1. full 3-of-N quorum unlock of a zero-duration lock succeeds (harness sanity)
 *     P2. every sub-threshold opKey exercised above remains hasExecuted == false
 *     P3. time-locked lock balance untouched after all attempts
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    reportTestResult,
    getEthers,
    assert,
    assertEqual,
    signLockerOp,
    lockerOpKey
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

/** Signs the typed op struct with each wallet, returns { addresses, signatures }. */
async function collectSignatures(primaryType, message, wallets, domain) {
    const signatures = [];
    const addresses = [];
    for (const w of wallets) {
        signatures.push(await signLockerOp(w, domain, primaryType, message));
        addresses.push(w.address);
    }
    return { addresses, signatures };
}

/**
 * Collects every raw revert-data hex string nested in the error object.
 * Hardhat sometimes fails to infer the reason itself ("couldn't infer the
 * reason") while still shipping the raw Error(string) payload in error.data.data.
 */
function extractRevertData(error, depth = 0) {
    if (!error || depth > 4) return [];
    const found = [];
    for (const v of [error.data, error.error, error.info, error.info && error.info.error]) {
        if (typeof v === 'string' && v.startsWith('0x')) found.push(v);
        else if (v && typeof v === 'object') found.push(...extractRevertData(v, depth + 1));
    }
    return found;
}

function revertText(error) {
    const parts = [error.shortMessage, error.reason, error.message];
    if (error.info && error.info.error && error.info.error.message) parts.push(error.info.error.message);
    if (error.error && error.error.message) parts.push(error.error.message);
    for (const hex of extractRevertData(error)) {
        parts.push(hex); // raw hex — keeps 4-byte custom-error selector matching working
        if (hex.startsWith('0x08c379a0')) { // Error(string)
            try {
                parts.push(ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10))[0]);
            } catch { /* malformed payload — raw hex already pushed */ }
        }
    }
    return parts.filter(Boolean).join(' | ');
}

/**
 * Expects the call to revert. `expected` is a string or array of strings —
 * the revert text must contain at least one (contract strings, custom error
 * names, or 4-byte selectors).
 */
async function expectRevert(callFn, label, expected) {
    const expectedList = Array.isArray(expected) ? expected : [expected];
    try {
        const result = await callFn();
        if (result && result.wait) await result.wait();
    } catch (error) {
        const text = revertText(error);
        assert(
            expectedList.some((s) => text.includes(s)),
            `${label}: expected revert containing one of [${expectedList.join(', ')}], got: ${text.substring(0, 250)}`
        );
        logSuccess(`${label} → rejected ("${expectedList.find((s) => text.includes(s))}")`);
        return;
    }
    throw new Error(`${label}: expected revert but call succeeded — ENTRY POINT NOT LOCKED`);
}

function baseLockParams(tokenAddress, amount, lockDuration = 3600) {
    return {
        token: tokenAddress,
        amount,
        lockDuration,
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

const sel = (sig) => ethers.id(sig).slice(0, 10);

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 58: ENTRY-POINT LOCKDOWN MATRIX\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer, s1, s2, s3, s4, attacker, recipient] = await ethers.getSigners();
        const signerWallets = [s1, s2, s3, s4];
        const signerAddresses = signerWallets.map((w) => w.address);
        const THRESHOLD = 3;

        // ====================================================================
        // PHASE 1: Deploy full suite + fixtures
        // ====================================================================
        logPhase(1, 'Deploy suite + fixtures');

        const PC = await ethers.getContractFactory('PriceCalculator');
        const pc = await PC.deploy(ethers.ZeroAddress, []);
        await pc.waitForDeployment();

        const VH = await ethers.getContractFactory('ValidationHandler');
        const vh = await VH.deploy(THRESHOLD);
        await vh.waitForDeployment();
        const vhAddr = await vh.getAddress();

        const LM = await ethers.getContractFactory('LockManager');
        const lm = await LM.deploy(await pc.getAddress());
        await lm.waitForDeployment();
        const lmAddr = await lm.getAddress();

        const VMgr = await ethers.getContractFactory('VestingManager');
        const vmgr = await VMgr.deploy(lmAddr);
        await vmgr.waitForDeployment();

        const SM = await ethers.getContractFactory('SignerManager');
        const sm = await SM.deploy(vhAddr, signerAddresses, THRESHOLD);
        await sm.waitForDeployment();
        const smAddr = await sm.getAddress();

        const LC = await ethers.getContractFactory('LockerContract');
        const locker = await LC.deploy(
            vhAddr, lmAddr, smAddr, await vmgr.getAddress(),
            signerAddresses, THRESHOLD
        );
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();
        const domain = await buildDomain(lockerAddress);
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        logSuccess(`Suite deployed — LockerContract at ${lockerAddress}`);

        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const token = await ERC20Mock.deploy('Test', 'TST', deployer.address, ethers.parseEther('1000000'), 18);
        await token.waitForDeployment();
        const tokenAddr = await token.getAddress();

        // Lock #1: time-locked 1h — the target of every unauthorized attempt.
        const lock1Amount = ethers.parseEther('100');
        await (await token.transfer(s1.address, lock1Amount)).wait();
        await (await token.connect(s1).approve(lockerAddress, lock1Amount)).wait();
        await (await locker.connect(s1).createLock(baseLockParams(tokenAddr, lock1Amount, 3600))).wait();
        const LOCK1 = 1n;

        // Lock #2: zero-duration — used for the positive-control quorum unlock.
        const lock2Amount = ethers.parseEther('50');
        await (await token.transfer(s1.address, lock2Amount)).wait();
        await (await token.connect(s1).approve(lockerAddress, lock2Amount)).wait();
        await (await locker.connect(s1).createLock(baseLockParams(tokenAddr, lock2Amount, 0))).wait();
        const LOCK2 = 2n;
        logSuccess('Fixtures: lock #1 (100 TST, 1h) + lock #2 (50 TST, 0s)');

        // Every sub-threshold opKey exercised below is recorded here and re-checked
        // at the end: none of them may ever reach hasExecuted == true.
        const attemptedOpKeys = [];

        // ====================================================================
        // PHASE 2: Module wiring — setLocker (fresh front-run + re-init)
        // ====================================================================
        logPhase(2, 'Module wiring lockdown (setLocker ×4, both branches)');

        // Fresh, un-wired modules deployed by `deployer`: attacker (different
        // tx.origin) must not be able to hijack the one-time wiring.
        const freshVh = await VH.deploy(THRESHOLD);
        await freshVh.waitForDeployment();
        const freshLm = await LM.deploy(await pc.getAddress());
        await freshLm.waitForDeployment();
        const freshSm = await SM.deploy(await freshVh.getAddress(), signerAddresses, THRESHOLD);
        await freshSm.waitForDeployment();
        const freshVm = await VMgr.deploy(await freshLm.getAddress());
        await freshVm.waitForDeployment();

        await expectRevert(() => freshLm.connect(attacker).setLocker(attacker.address),
            'W1a LockManager.setLocker (fresh, attacker)', 'Only deployer');
        await expectRevert(() => freshVh.connect(attacker).setLocker(attacker.address),
            'W2a ValidationHandler.setLocker (fresh, attacker)', 'Only deployer');
        await expectRevert(() => freshSm.connect(attacker).setLocker(attacker.address),
            'W3a SignerManager.setLocker (fresh, attacker)', 'Only deployer');
        await expectRevert(() => freshVm.connect(attacker).setLocker(attacker.address),
            'W4a VestingManager.setLocker (fresh, attacker)', 'Only deployer');

        // Already-wired modules: even the legitimate deployer cannot re-point them.
        await expectRevert(() => lm.connect(deployer).setLocker(attacker.address),
            'W1b LockManager.setLocker (re-init)', 'Z');
        await expectRevert(() => vh.connect(deployer).setLocker(attacker.address),
            'W2b ValidationHandler.setLocker (re-init)', 'Already initialized');
        await expectRevert(() => sm.connect(deployer).setLocker(attacker.address),
            'W3b SignerManager.setLocker (re-init)', 'Already initialized');
        await expectRevert(() => vmgr.connect(deployer).setLocker(attacker.address),
            'W4b VestingManager.setLocker (re-init)', 'Already set or zero');

        // ====================================================================
        // PHASE 3: LockManager onlyLocker surface — attacker AND signer EOA
        // ====================================================================
        logPhase(3, 'LockManager direct entry points (onlyLocker)');

        for (const [who, caller] of [['attacker', attacker], ['signer EOA', s1]]) {
            await expectRevert(
                () => lm.connect(caller).createLock(tokenAddr, 1, 3600, ethers.ZeroAddress, ethers.ZeroAddress, 0, false, 0, 0),
                `M1 LockManager.createLock (${who})`, 'NA');
            await expectRevert(
                () => lm.connect(caller).addToLock(LOCK1, 1, caller.address, ethers.ZeroHash),
                `M2 LockManager.addToLock (${who})`, 'NA');
            await expectRevert(
                () => lm.connect(caller).validateAndUnlock(LOCK1, 1),
                `M3 LockManager.validateAndUnlock (${who})`, 'NA');
            await expectRevert(
                () => lm.connect(caller).unlockVestedAmount(LOCK1, 1),
                `M4 LockManager.unlockVestedAmount (${who})`, 'NA');
        }

        // ====================================================================
        // PHASE 4: SignerManager onlyLocker surface
        // ====================================================================
        logPhase(4, 'SignerManager direct entry points (onlyLocker)');

        for (const [who, caller] of [['attacker', attacker], ['signer EOA', s1]]) {
            await expectRevert(() => sm.connect(caller).addSignerDirect(attacker.address),
                `G1 SignerManager.addSignerDirect (${who})`, 'Only locker allowed');
            await expectRevert(() => sm.connect(caller).removeSignerDirect(s2.address),
                `G2 SignerManager.removeSignerDirect (${who})`, 'Only locker allowed');
        }

        // ====================================================================
        // PHASE 5: ValidationHandler guarded surface
        // ====================================================================
        logPhase(5, 'ValidationHandler entry points');

        // F2 hardening: setThreshold / bumpConfigEpoch / markAsExecuted are onlyLocker,
        // so every non-locker caller (attacker or signer EOA) gets 'Only locker allowed'.
        for (const [who, caller] of [['attacker', attacker], ['signer EOA', s1]]) {
            await expectRevert(() => vh.connect(caller).setThreshold(1),
                `V1 ValidationHandler.setThreshold (${who})`, 'Only locker allowed');
            await expectRevert(() => vh.connect(caller).bumpConfigEpoch(),
                `V2 ValidationHandler.bumpConfigEpoch (${who})`, 'Only locker allowed');
        }
        const fakeOpKey = ethers.solidityPackedKeccak256(['string'], ['FAKE_OP']);
        await expectRevert(() => vh.connect(attacker).markAsExecuted(fakeOpKey),
            'V3 ValidationHandler.markAsExecuted (attacker)', 'Only locker allowed');

        // V4 — even with a FULL set of genuine signer signatures on a real opKey,
        // only the LockerContract may register approvals.
        const unlockAmount10 = ethers.parseEther('10');
        const opKeyUnlock10 = await locker.getUnlockOpKey(LOCK1, recipient.address, unlockAmount10);
        const unlockMsg10 = { lockId: LOCK1, to: recipient.address, amount: unlockAmount10, nonce: await locker.unlockNonce(LOCK1) };
        const fullSigs = await collectSignatures('Unlock', unlockMsg10, [s1, s2, s3], domain);
        await expectRevert(
            () => vh.connect(attacker).batchApproveWithSignatures(opKeyUnlock10, fullSigs.addresses, fullSigs.signatures),
            'V4 ValidationHandler.batchApproveWithSignatures (attacker, valid quorum sigs)',
            'Only locker allowed');
        assertEqual(await vh.approvalsCount(opKeyUnlock10), 0n, 'No approval must have been registered');
        logSuccess('V4 control: approvalsCount still 0 — outsiders cannot pre-register approvals');

        // ====================================================================
        // PHASE 6: VestingManager onlyLocker surface
        // ====================================================================
        logPhase(6, 'VestingManager direct entry points (onlyLocker)');

        for (const [who, caller] of [['attacker', attacker], ['signer EOA', s1]]) {
            await expectRevert(() => vmgr.connect(caller).initializeVesting(LOCK1, 1, 3600, false),
                `T1 VestingManager.initializeVesting (${who})`, 'Not authorized');
            await expectRevert(() => vmgr.connect(caller).unlockVested(LOCK1),
                `T2 VestingManager.unlockVested (${who})`, 'Not authorized');
        }

        // ====================================================================
        // PHASE 7: LockerContract M-of-N quorum gates
        // ====================================================================
        logPhase(7, 'LockerContract quorum gates (threshold = 3)');

        // Q1 — zero signatures.
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(LOCK1, recipient.address, unlockAmount10, [], []),
            'Q1 executeUnlockWithSignatures (0 sigs)', 'Insufficient approvals');
        attemptedOpKeys.push(opKeyUnlock10);

        // Q2 — exactly threshold-1 valid signatures (boundary).
        const twoSigs = await collectSignatures('Unlock', unlockMsg10, [s1, s2], domain);
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(LOCK1, recipient.address, unlockAmount10, twoSigs.addresses, twoSigs.signatures),
            'Q2 executeUnlockWithSignatures (2 of 3 sigs)', 'Insufficient approvals');

        // Q3 — one genuine signer repeated: idempotent registration counts once.
        const s3Sig = await collectSignatures('Unlock', unlockMsg10, [s3], domain);
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(
                LOCK1, recipient.address, unlockAmount10,
                [s3.address, s3.address, s3.address],
                [s3Sig.signatures[0], s3Sig.signatures[0], s3Sig.signatures[0]]),
            'Q3 executeUnlockWithSignatures (same signer ×3)', 'Insufficient approvals');

        // Q4 — quorum-sized batch of NON-signer signatures.
        const outsiderWallets = [attacker, recipient, deployer];
        const outsiderOpKey = await locker.getUnlockOpKey(LOCK1, attacker.address, unlockAmount10);
        const outsiderMsg = { lockId: LOCK1, to: attacker.address, amount: unlockAmount10, nonce: await locker.unlockNonce(LOCK1) };
        const outsiderSigs = await collectSignatures('Unlock', outsiderMsg, outsiderWallets, domain);
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(LOCK1, attacker.address, unlockAmount10, outsiderSigs.addresses, outsiderSigs.signatures),
            'Q4 executeUnlockWithSignatures (3 non-signer sigs)', 'ERR_001');
        attemptedOpKeys.push(outsiderOpKey);

        // Q5 — parameter binding: signatures for amount=10, submitted amount=11.
        const sigsFor10 = await collectSignatures('Unlock', unlockMsg10, [s1, s2, s3], domain);
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(
                LOCK1, recipient.address, ethers.parseEther('11'), sigsFor10.addresses, sigsFor10.signatures),
            'Q5 executeUnlockWithSignatures (tampered amount)', ['ERR_005', 'ERR_004']);

        // Q6 — parameter binding: signatures for `recipient`, submitted to attacker.
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(
                LOCK1, attacker.address, unlockAmount10, sigsFor10.addresses, sigsFor10.signatures),
            'Q6 executeUnlockWithSignatures (swapped recipient)', ['ERR_005', 'ERR_004']);

        // Q7 — updateThresholdWithSignatures below quorum.
        const thresholdNonce = await locker.thresholdNonce();
        const thresholdMsg = { newThreshold: 4, nonce: thresholdNonce };
        const opKeyThreshold = lockerOpKey('UpdateThreshold', thresholdMsg);
        const thrSigs = await collectSignatures('UpdateThreshold', thresholdMsg, [s1, s2], domain);
        await expectRevert(
            () => locker.connect(attacker).updateThresholdWithSignatures(4, thrSigs.addresses, thrSigs.signatures),
            'Q7 updateThresholdWithSignatures (2 sigs)', 'Insufficient approvals');
        attemptedOpKeys.push(opKeyThreshold);

        // Q8 — batchUpdateSignersWithSignatures below quorum (attacker self-promotion).
        const batchNonce = await locker.batchUpdateSignersNonce();
        const batchMsg = { signersToRemove: [], signersToAdd: [attacker.address], nonce: batchNonce };
        const opKeyBatch = lockerOpKey('BatchUpdateSigners', batchMsg);
        const batchSigs = await collectSignatures('BatchUpdateSigners', batchMsg, [s1, s2], domain);
        await expectRevert(
            () => locker.connect(attacker).batchUpdateSignersWithSignatures([], [attacker.address], batchSigs.addresses, batchSigs.signatures),
            'Q8 batchUpdateSignersWithSignatures (2 sigs)', 'Insufficient approvals');
        attemptedOpKeys.push(opKeyBatch);
        assert(!(await locker.isSigner(attacker.address)), 'Attacker must NOT have become a signer');

        // Q9 — token rescue below quorum (non-locked token sent by mistake).
        const strayToken = await ERC20Mock.deploy('Stray', 'STR', deployer.address, ethers.parseEther('1000'), 18);
        await strayToken.waitForDeployment();
        const strayAddr = await strayToken.getAddress();
        await (await strayToken.transfer(lockerAddress, ethers.parseEther('5'))).wait();
        const rescueNonce = await locker.rescueNonce();
        const opKeyRescue = await locker.getRescueTokenOpKey(strayAddr, attacker.address, ethers.parseEther('5'));
        const rescueMsg = { token: strayAddr, to: attacker.address, amount: ethers.parseEther('5'), chainId, nonce: rescueNonce };
        const rescueSigs = await collectSignatures('RescueToken', rescueMsg, [s1, s2], domain);
        await expectRevert(
            () => locker.connect(attacker).executeRescueWithSignatures(strayAddr, attacker.address, ethers.parseEther('5'), rescueSigs.addresses, rescueSigs.signatures),
            'Q9 executeRescueWithSignatures (2 sigs)', 'Insufficient approvals');
        attemptedOpKeys.push(opKeyRescue);

        // Q10 — native rescue below quorum (force-sent ETH).
        const ForceSend = await ethers.getContractFactory('ForceSend');
        const forceSend = await ForceSend.deploy();
        await forceSend.waitForDeployment();
        await (await forceSend.forceSend(lockerAddress, { value: 1000n })).wait();
        const opKeyNative = await locker.getRescueNativeOpKey(attacker.address, 1000n);
        const nativeMsg = { to: attacker.address, amount: 1000n, chainId, nonce: rescueNonce };
        const nativeSigs = await collectSignatures('RescueNative', nativeMsg, [s1, s2], domain);
        await expectRevert(
            () => locker.connect(attacker).executeRescueNativeWithSignatures(attacker.address, 1000n, nativeSigs.addresses, nativeSigs.signatures),
            'Q10 executeRescueNativeWithSignatures (2 sigs)', 'Insufficient approvals');
        attemptedOpKeys.push(opKeyNative);

        // Q11 — vesting release below quorum.
        const vestingNonce = await locker.vestingNonce(LOCK1);
        const vestingMsg = { lockId: LOCK1, recipient: attacker.address, maxAmountTokens: 1n, chainId, nonce: vestingNonce };
        const opKeyVesting = lockerOpKey('VestingUnlock', vestingMsg);
        const vestSigs = await collectSignatures('VestingUnlock', vestingMsg, [s1, s2], domain);
        await expectRevert(
            () => locker.connect(attacker).unlockVestedWithSignatures(LOCK1, attacker.address, 1n, vestSigs.addresses, vestSigs.signatures),
            'Q11 unlockVestedWithSignatures (2 sigs)', 'Insufficient approvals');
        attemptedOpKeys.push(opKeyVesting);

        // ====================================================================
        // PHASE 8: LockerContract signer gates
        // ====================================================================
        logPhase(8, 'LockerContract signer gates');

        // S1 — createLock by a funded, approved NON-signer.
        await (await token.transfer(attacker.address, ethers.parseEther('10'))).wait();
        await (await token.connect(attacker).approve(lockerAddress, ethers.parseEther('10'))).wait();
        await expectRevert(
            () => locker.connect(attacker).createLock(baseLockParams(tokenAddr, ethers.parseEther('10'))),
            'S1 createLock (non-signer)', ['NotSigner', sel('NotSigner()')]);

        // S2 — createLockWithSignatures declaring a non-signer as the signer.
        const clNonce = await locker.createLockNonce();
        const clParams = baseLockParams(tokenAddr, ethers.parseEther('10'));
        const clMsg = {
            token: clParams.token,
            amount: clParams.amount,
            lockDuration: clParams.lockDuration,
            pair: clParams.pair,
            ethUsdPair: clParams.ethUsdPair,
            targetPriceUSD1e18: clParams.targetPriceUSD1e18,
            isEthPair: clParams.isEthPair,
            stablecoinPosition: clParams.stablecoinPosition,
            priceDirection: clParams.priceDirection,
            vestingTokensPerPeriod: clParams.vestingTokensPerPeriod,
            vestingPeriodSeconds: clParams.vestingPeriodSeconds,
            vestingAccumulate: clParams.vestingAccumulate,
            nonce: clNonce,
            signer: attacker.address
        };
        const attackerSig = await signLockerOp(attacker, domain, 'CreateLock', clMsg);
        await expectRevert(
            () => locker.connect(attacker).createLockWithSignatures(clParams, { signer: attacker.address, signature: attackerSig }),
            'S2 createLockWithSignatures (non-signer signer)', ['NotSigner', sel('NotSigner()')]);

        // S3 — forged signature: declares genuine signer s1, signed by attacker.
        const clMsgForged = { ...clMsg, signer: s1.address };
        const forgedSig = await signLockerOp(attacker, domain, 'CreateLock', clMsgForged);
        await expectRevert(
            () => locker.connect(attacker).createLockWithSignatures(clParams, { signer: s1.address, signature: forgedSig }),
            'S3 createLockWithSignatures (forged signature)', 'INV_SIG');

        // S4 — addToLock is permissionless by design, but it can only pull the
        // CALLER's own funds: with no allowance the transferFrom must revert and
        // the lock must be unchanged.
        const lock1Before = await locker.locks(LOCK1);
        await (await token.connect(attacker).approve(lockerAddress, 0)).wait();
        await expectRevert(
            () => locker.connect(attacker).addToLock(LOCK1, ethers.parseEther('1'), ethers.ZeroHash),
            'S4 addToLock (no allowance)',
            ['insufficient allowance', 'ERC20InsufficientAllowance', 'SafeERC20', 'transfer amount exceeds allowance']);
        const lock1After = await locker.locks(LOCK1);
        assertEqual(lock1After.basic.availableAmount, lock1Before.basic.availableAmount, 'Lock #1 unchanged after failed addToLock');

        // NOTE: DeploymentRegistry is not part of this repository — its admin
        // lockdown is covered by its own test suite.

        // ====================================================================
        // PHASE 9: Positive controls
        // ====================================================================
        logPhase(9, 'Positive controls');

        // P1 — full 3-of-N quorum on the zero-duration lock #2: must succeed.
        // Proves the signature harness is valid, so every rejection above was
        // the guard itself and not a malformed signature.
        const lock2Msg = { lockId: LOCK2, to: recipient.address, amount: lock2Amount, nonce: await locker.unlockNonce(LOCK2) };
        const quorumSigs = await collectSignatures('Unlock', lock2Msg, [s1, s2, s3], domain);
        const balBefore = await token.balanceOf(recipient.address);
        await (await locker.connect(s1).executeUnlockWithSignatures(
            LOCK2, recipient.address, lock2Amount, quorumSigs.addresses, quorumSigs.signatures)).wait();
        assertEqual(await token.balanceOf(recipient.address), balBefore + lock2Amount, 'Quorum unlock must transfer lock #2 funds');
        logSuccess('P1 control: full 3-of-N quorum unlock succeeds (harness signatures are valid)');

        // P2 — none of the sub-threshold operations ever executed.
        for (const opKey of attemptedOpKeys) {
            assert(!(await vh.hasExecuted(opKey)), `opKey ${opKey} must never have executed`);
        }
        logSuccess(`P2 control: ${attemptedOpKeys.length} attacked opKeys all remain non-executed`);

        // P3 — the time-locked lock #1 is intact and the vault still holds its funds.
        const lock1Final = await locker.locks(LOCK1);
        assertEqual(lock1Final.basic.availableAmount, lock1Amount, 'Lock #1 balance untouched');
        assert((await token.balanceOf(lockerAddress)) >= lock1Amount, 'Vault still holds lock #1 funds');
        assertEqual((await locker.getSigners()).length, 4, 'Signer set unchanged');
        assertEqual(await locker.approvalsThreshold(), 3n, 'Threshold unchanged');
        logSuccess('P3 control: lock #1, signer set and threshold all intact');

        logSuccess('\n🎉 TEST 58 PASSED: every entry point verified locked!\n');
        reportTestResult('58-entrypoint-lockdown-matrix', true);

    } catch (error) {
        reportTestResult('58-entrypoint-lockdown-matrix', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
