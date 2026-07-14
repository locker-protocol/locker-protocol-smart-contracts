/**
 * Test 53: SignerManager Negative Paths & Neutral Getters
 *
 * Exhaustive negative coverage of SignerManager against the CURRENT code
 * (owner role removed — no setOwner/owner paths exist anymore):
 *
 * 1. Constructor negatives (fresh deployments):
 *    - 'Zero validation handler'
 *    - 'Invalid signer count' (below MIN_SIGNERS=3 and above MAX_SIGNERS=20)
 *    - 'Threshold too low' (0)
 *    - 'Threshold too high' (> signers.length)
 *    - 'Invalid signer address' (zero address in array)
 *    - 'Duplicate signer'
 *
 * 2. updateThresholdWithSignatures (now on LockerContract via LockerSignerOperations —
 *    SignerManager itself no longer has updateThreshold):
 *    - 'Threshold too low (minimum is 3)' (==0)
 *    - 'Threshold too high (max is signer count)' (> signer count)
 *    - 'ERR_001: Not authorized signer' (exact string, non-signer in approval set)
 *    - 'Already approved' is OBSOLETE: duplicate approvals are silently skipped
 *      (anti-front-run idempotency) — duplicates count once → 'Insufficient approvals'
 *    - 'Already executed' (exact string, ValidationHandler.markAsExecuted replay guard;
 *      unreachable through updateThresholdWithSignatures because the opKey embeds the
 *      incrementing thresholdNonce — exercised on a fresh ValidationHandler whose
 *      locker is set to an EOA we control)
 *    - 'Not authorized signer' (exact bare string, ValidationHandler.verifySignatureOnly)
 *
 * 3. addSignerDirect 'Invalid signer state' — unreachable through the public entry
 *    (LockerContract.batchUpdateSignersWithSignatures pre-filters with
 *    'Cannot add zero address' / 'Signer already exists'), so it is exercised
 *    directly on a fresh SignerManager whose locker is set to an EOA (onlyLocker
 *    passes when msg.sender == locker; setLocker only requires tx.origin == deployer
 *    and a nonzero address — the EOA itself qualifies).
 *
 * 4. removeSignerDirect: no-match path (absent address → silent no-op, list intact)
 *    and removal of a MIDDLE element (swap-with-last + pop → exact final order).
 *
 * 5. canRemoveSigner → false when signersList.length <= MIN_SIGNERS.
 *
 * 6. setLocker: 'Already initialized' (re-init) + the _locker==0 branch of the same
 *    combined require + 'Only deployer' (tx.origin guard).
 *
 * 7. Neutral getters: validationHandler(), signersList(uint256), MIN_THRESHOLD(),
 *    MIN_SIGNERS(), MAX_SIGNERS(), initialized().
 *
 * Everything runs on FRESH instances — the shared deployment is never mutated.
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

// Hardhat's stack-trace inference sometimes fails on viaIR-compiled frames
// ("Transaction reverted and Hardhat couldn't infer the reason") even though the
// raw returndata carries a standard Error(string). Decode it ourselves as fallback.
function extractRevertReason(e) {
    const seen = new Set();
    const queue = [e, e?.error, e?.info, e?.info?.error, e?.data, e?.error?.data];
    for (const item of queue) {
        const d = typeof item === 'string' ? item : item?.data;
        if (typeof d === 'string' && d.startsWith('0x08c379a0') && !seen.has(d)) {
            seen.add(d);
            try {
                return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + d.slice(10))[0];
            } catch { /* keep scanning */ }
        }
    }
    return '';
}

async function expectRevert(promiseFactory, reason, label) {
    try {
        await promiseFactory();
        throw new Error(`__NO_REVERT__`);
    } catch (e) {
        if (e.message.includes('__NO_REVERT__')) {
            throw new Error(`${label}: expected revert '${reason}' but call succeeded`);
        }
        const decoded = extractRevertReason(e);
        assert(
            e.message.includes(reason) || decoded.includes(reason),
            `${label}: expected '${reason}' but got: ${e.message}${decoded ? ` (raw reason: '${decoded}')` : ''}`
        );
        logSuccess(`${label} → reverted with '${reason}'`);
    }
}

function randomAddresses(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(ethers.Wallet.createRandom().address);
    }
    return out;
}

async function main() {
    log('\n🧪 TEST 53: SIGNERMANAGER NEGATIVE PATHS & NEUTRAL GETTERS\n', '\x1b[1m\x1b[36m');

    try {
        const [deployer, other] = await ethers.getSigners();
        log(`Deployer: ${deployer.address}`, '\x1b[90m');

        const SM = await ethers.getContractFactory('SignerManager');
        const VH = await ethers.getContractFactory('ValidationHandler');

        // A valid ValidationHandler address for constructor-arg purposes
        const vhRef = await VH.deploy(3);
        await vhRef.waitForDeployment();
        const vhRefAddr = await vhRef.getAddress();
        logSuccess(`Reference ValidationHandler deployed at ${vhRefAddr}`);

        const threeSigners = randomAddresses(3);

        // ========================================
        // PHASE 1: Constructor negatives
        // ========================================
        logPhase(1, 'Constructor negatives (fresh deployments)');

        await expectRevert(
            () => SM.deploy(ethers.ZeroAddress, threeSigners, 3),
            'Zero validation handler',
            'constructor(validationHandler=0)'
        );

        await expectRevert(
            () => SM.deploy(vhRefAddr, randomAddresses(2), 3),
            'Invalid signer count',
            'constructor(2 signers, below MIN_SIGNERS=3)'
        );

        await expectRevert(
            () => SM.deploy(vhRefAddr, randomAddresses(21), 3),
            'Invalid signer count',
            'constructor(21 signers, above MAX_SIGNERS=20)'
        );

        await expectRevert(
            () => SM.deploy(vhRefAddr, threeSigners, 0),
            'Threshold too low',
            'constructor(threshold=0)'
        );

        await expectRevert(
            () => SM.deploy(vhRefAddr, threeSigners, 4),
            'Threshold too high',
            'constructor(threshold=4 > 3 signers)'
        );

        await expectRevert(
            () => SM.deploy(vhRefAddr, [threeSigners[0], ethers.ZeroAddress, threeSigners[2]], 3),
            'Invalid signer address',
            'constructor(zero address in signer array)'
        );

        await expectRevert(
            () => SM.deploy(vhRefAddr, [threeSigners[0], threeSigners[1], threeSigners[0]], 3),
            'Duplicate signer',
            'constructor(duplicate signer in array)'
        );

        // Boundary sanity: exactly MAX_SIGNERS=20 must succeed
        const smMax = await SM.deploy(vhRefAddr, randomAddresses(20), 3);
        await smMax.waitForDeployment();
        assertEqual((await smMax.getSigners()).length, 20, 'Boundary deploy with 20 signers succeeds');

        // ========================================
        // PHASE 2: updateThresholdWithSignatures negatives
        // (SignerManager no longer exposes updateThreshold — the flow lives on
        //  LockerContract → LockerSignerOperations → ValidationHandler)
        // ========================================
        logPhase(2, 'updateThresholdWithSignatures negatives (fresh full stack)');

        // Fresh, fully wired stack (never touches the shared deployment)
        const signerWallets = [];
        for (let i = 0; i < 5; i++) {
            signerWallets.push(ethers.Wallet.createRandom());
        }
        const signerAddresses = signerWallets.map(w => w.address);

        const PC = await ethers.getContractFactory('PriceCalculator');
        const pc = await PC.deploy(ethers.ZeroAddress, []);
        await pc.waitForDeployment();

        const vh = await VH.deploy(3);
        await vh.waitForDeployment();
        const vhAddr = await vh.getAddress();

        const LM = await ethers.getContractFactory('LockManager');
        const lm = await LM.deploy(await pc.getAddress());
        await lm.waitForDeployment();

        const VMgr = await ethers.getContractFactory('VestingManager');
        const vmgr = await VMgr.deploy(await lm.getAddress());
        await vmgr.waitForDeployment();

        const sm = await SM.deploy(vhAddr, signerAddresses, 3);
        await sm.waitForDeployment();

        const LC = await ethers.getContractFactory('LockerContract');
        const locker = await LC.deploy(
            vhAddr,
            await lm.getAddress(),
            await sm.getAddress(),
            await vmgr.getAddress(),
            signerAddresses,
            3
        );
        await locker.waitForDeployment();
        const lockerAddress = await locker.getAddress();
        logSuccess(`Fresh LockerContract deployed at ${lockerAddress}`);

        // Threshold too low (==0) — checked before any signature handling
        await expectRevert(
            () => locker.updateThresholdWithSignatures(0, [], []),
            'Threshold too low (minimum is 3)',
            'updateThresholdWithSignatures(0)'
        );

        // Threshold too high (> signer count: 6 > 5)
        await expectRevert(
            () => locker.updateThresholdWithSignatures(6, [], []),
            'Threshold too high (max is signer count)',
            'updateThresholdWithSignatures(6 > 5 signers)'
        );

        // EIP-712 plumbing for signature-level negatives
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        const domain = {
            name: 'LockerContract',
            version: '1',
            chainId,
            verifyingContract: lockerAddress
        };
        const nonce = await locker.thresholdNonce();
        // Each op is now signed as its decoded struct; opKey IS the EIP-712 hashStruct.
        const thresholdMsg = { newThreshold: 4, nonce };
        const opKey = lockerOpKey('UpdateThreshold', thresholdMsg);

        // 'Not authorized signer' — EXACT current string is 'ERR_001: Not authorized signer'
        // (tests 34/42 only caught a generic revert here)
        const outsider = ethers.Wallet.createRandom();
        const outsiderSig = await signLockerOp(outsider, domain, 'UpdateThreshold', thresholdMsg);
        await expectRevert(
            () => locker.updateThresholdWithSignatures(4, [outsider.address], [outsiderSig]),
            'ERR_001: Not authorized signer',
            'updateThresholdWithSignatures(non-signer approval)'
        );

        // 'Already approved' is OBSOLETE: duplicate approvals from the same signer are
        // silently skipped (idempotent anti-front-run), so they count ONCE and the flow
        // fails the quorum check with 'Insufficient approvals' instead of reverting early.
        const dupSig = await signLockerOp(signerWallets[0], domain, 'UpdateThreshold', thresholdMsg);
        await expectRevert(
            () => locker.updateThresholdWithSignatures(
                4,
                [signerAddresses[0], signerAddresses[0], signerAddresses[0]],
                [dupSig, dupSig, dupSig]
            ),
            'Insufficient approvals',
            'updateThresholdWithSignatures(same signer x3 counts once)'
        );

        // 'Not authorized signer' — exact bare string lives in verifySignatureOnly
        await expectRevert(
            () => vh.verifySignatureOnly(opKey, outsider.address, outsiderSig),
            'Not authorized signer',
            'ValidationHandler.verifySignatureOnly(non-signer)'
        );

        // ========================================
        // PHASE 3: 'Already executed' (exact string)
        // Unreachable through updateThresholdWithSignatures (opKey embeds the
        // incrementing thresholdNonce), so exercise markAsExecuted's replay guard on a
        // fresh ValidationHandler whose locker is an EOA we control:
        // onlyLockerOrSignerManager passes when msg.sender == locker, and
        // setThreshold(0) lets markAsExecuted pass the quorum check with 0 approvals.
        // ========================================
        logPhase(3, "'Already executed' replay guard (fresh ValidationHandler, EOA locker)");

        const vhEoa = await VH.deploy(3);
        await vhEoa.waitForDeployment();
        await (await vhEoa.setLocker(deployer.address)).wait();
        logSuccess('Fresh ValidationHandler wired to EOA locker (deployer)');

        await (await vhEoa.setThreshold(0)).wait();
        const replayKey = ethers.solidityPackedKeccak256(['string'], ['TEST53_REPLAY']);
        await (await vhEoa.markAsExecuted(replayKey)).wait();
        assert(await vhEoa.hasExecuted(replayKey), 'opKey should be marked executed');
        logSuccess('markAsExecuted succeeded once (threshold 0, 0 approvals)');

        await expectRevert(
            () => vhEoa.markAsExecuted(replayKey),
            'Already executed',
            'markAsExecuted(replay of executed opKey)'
        );

        // ========================================
        // PHASE 4: addSignerDirect / removeSignerDirect on an EOA-locker instance
        // 'Invalid signer state' is unreachable through the public entry:
        // batchUpdateSignersWithSignatures pre-filters with 'Cannot add zero address'
        // and 'Signer already exists'. So set locker to an EOA and call directly.
        // ========================================
        logPhase(4, 'addSignerDirect / removeSignerDirect (fresh SignerManager, EOA locker)');

        const [A, B, C, D, E] = randomAddresses(5);
        const smDirect = await SM.deploy(vhRefAddr, [A, B, C, D, E], 3);
        await smDirect.waitForDeployment();
        await (await smDirect.setLocker(deployer.address)).wait();
        assertEqual(await smDirect.locker(), deployer.address, 'locker set to EOA (deployer)');
        assertEqual(await smDirect.initialized(), true, 'initialized() true after setLocker');

        // addSignerDirect: zero address → 'Invalid signer state'
        await expectRevert(
            () => smDirect.addSignerDirect(ethers.ZeroAddress),
            'Invalid signer state',
            'addSignerDirect(address(0))'
        );

        // addSignerDirect: already a signer → 'Invalid signer state'
        await expectRevert(
            () => smDirect.addSignerDirect(A),
            'Invalid signer state',
            'addSignerDirect(existing signer)'
        );

        // removeSignerDirect: no-match path — absent address is a silent no-op
        logSection('removeSignerDirect no-match (absent address)');
        const absent = ethers.Wallet.createRandom().address;
        await (await smDirect.removeSignerDirect(absent)).wait();
        const afterNoMatch = await smDirect.getSigners();
        assertEqual(afterNoMatch.length, 5, 'List length unchanged after no-match removal');
        assertEqual(afterNoMatch.join(','), [A, B, C, D, E].join(','), 'List order unchanged after no-match removal');
        assert(!(await smDirect.isSigner(absent)), 'Absent address still not a signer');
        logSuccess('removeSignerDirect(absent) is a silent no-op (no revert, list intact)');

        // removeSignerDirect: MIDDLE element — swap-with-last + pop
        logSection('removeSignerDirect middle element (swap-with-last + pop)');
        await (await smDirect.removeSignerDirect(B)).wait();
        const afterMiddle = await smDirect.getSigners();
        assertEqual(afterMiddle.length, 4, 'List length 4 after removing middle signer');
        assertEqual(afterMiddle.join(','), [A, E, C, D].join(','), 'Order after middle removal is [A, E, C, D]');
        assert(!(await smDirect.isSigner(B)), 'Removed signer no longer isSigner');
        logSuccess('Middle removal: last element (E) swapped into slot 1, then popped');

        // addSignerDirect positive: re-add B — appended at the end
        await (await smDirect.addSignerDirect(B)).wait();
        const afterReAdd = await smDirect.getSigners();
        assertEqual(afterReAdd.join(','), [A, E, C, D, B].join(','), 'Re-added signer appended: [A, E, C, D, B]');
        assert(await smDirect.isSigner(B), 'Re-added signer isSigner again');

        // setLocker: 'Already initialized' (exact string, re-init attempt)
        await expectRevert(
            () => smDirect.setLocker(other.address),
            'Already initialized',
            'setLocker(re-init on initialized instance)'
        );

        // ========================================
        // PHASE 5: canRemoveSigner false at minimum + setLocker zero branch + getters
        // ========================================
        logPhase(5, 'canRemoveSigner at minimum, setLocker zero branch, neutral getters');

        const [X, Y, Z] = randomAddresses(3);
        const smMin = await SM.deploy(vhRefAddr, [X, Y, Z], 3);
        await smMin.waitForDeployment();

        // canRemoveSigner → false when length <= MIN_SIGNERS (3 <= 3), even for a real signer
        assert(await smMin.isSigner(X), 'X is a signer');
        assert(!(await smMin.canRemoveSigner(X)), 'canRemoveSigner(X) false at minimum count');
        logSuccess('canRemoveSigner returns false when signersList.length <= MIN_SIGNERS');

        // canRemoveSigner → false for a non-signer too
        assert(!(await smMin.canRemoveSigner(deployer.address)), 'canRemoveSigner(non-signer) false');
        logSuccess('canRemoveSigner returns false for non-signer');

        // setLocker(_locker == 0) on an UN-initialized instance hits the zero-address
        // branch of require(!initialized && _locker != address(0), "Already initialized")
        await expectRevert(
            () => smMin.setLocker(ethers.ZeroAddress),
            'Already initialized',
            'setLocker(address(0)) zero branch'
        );
        assertEqual(await smMin.initialized(), false, 'Still uninitialized after zero-address attempt');

        // setLocker from another EOA → 'Only deployer' (tx.origin guard)
        await expectRevert(
            () => smMin.connect(other).setLocker(other.address),
            'Only deployer',
            'setLocker(from non-deployer tx.origin)'
        );

        // Neutral getters never read elsewhere
        logSection('Neutral getters');
        assertEqual(await smMin.validationHandler(), vhRefAddr, 'validationHandler()');
        assertEqual(await smMin.MIN_THRESHOLD(), 3n, 'MIN_THRESHOLD()');
        assertEqual(await smMin.MIN_SIGNERS(), 3n, 'MIN_SIGNERS()');
        assertEqual(await smMin.MAX_SIGNERS(), 20n, 'MAX_SIGNERS()');
        assertEqual(await smMin.initialized(), false, 'initialized() false pre-wiring');
        assertEqual(await smMin.locker(), ethers.ZeroAddress, 'locker() zero pre-wiring');
        assertEqual(await smMin.signersList(0), X, 'signersList(0)');
        assertEqual(await smMin.signersList(1), Y, 'signersList(1)');
        assertEqual(await smMin.signersList(2), Z, 'signersList(2)');
        assertEqual((await smMin.getSigners()).join(','), [X, Y, Z].join(','), 'getSigners() matches signersList');
        logSuccess('All neutral getters return expected values');

        logSuccess('\n🎉 TEST 53 PASSED: SignerManager negative paths fully covered!\n');
        reportTestResult('53-signermanager-negatives', true);

    } catch (error) {
        reportTestResult('53-signermanager-negatives', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
