/**
 * Test 48: LockerContract Negative-Path Coverage
 *
 * Covers audit-identified negative paths of LockerContract that no other test hits:
 *
 *   C1. constructor: zero module address                      → "Invalid contract addresses"
 *   C2. constructor: 2 signers / 21 signers                   → "Invalid signers count (must be 3-20)"
 *   C3. constructor: threshold 2 / threshold > signer count   → "Invalid threshold"
 *   C4. constructor: module wiring mismatch                   → "ERR_007"
 *       (all real modules revert on double-init, so the ERR_007 defense-in-depth check is
 *        only reachable with a NON-conforming module: a raw-bytecode stub whose setLocker()
 *        succeeds but whose locker() returns address(0))
 *   C5. constructor: control — fresh modules wire successfully
 *   L1. createLock: amount == 0 (called by a signer)          → "Lock amount must be greater than 0"
 *   L2. createLock: called by a non-signer                    → custom error NotSigner()
 *   S1. createLockWithSignatures: amount == 0                 → "Lock amount must be greater than 0"
 *   S2. createLockWithSignatures: sig signer not authorized   → custom error NotSigner()
 *   S3. createLockWithSignatures: forged signature            → "INV_SIG"
 *   R1. executeRescueWithSignatures: amount == 0 (full sigs)  → "Invalid amount or recipient"
 *   R2. executeRescueWithSignatures: to == 0 (full sigs)      → "Invalid amount or recipient"
 *   R3. executeRescueNativeWithSignatures: amount == 0        → "Invalid amount or recipient"
 *   R4. executeRescueNativeWithSignatures: to == 0            → "Invalid amount or recipient"
 *   V1. unlockVestedWithSignatures: recipient == 0            → "Invalid recipient"
 *   T1. updateThresholdWithSignatures: above signer count     → "Threshold too high (max is signer count)"
 *   B1. batchUpdateSignersWithSignatures: both arrays empty   → "No signers provided"
 *   W1. neutral view wrappers approvalsCount(bytes32) and hasApproved(bytes32,address)
 *
 * NOT covered (unreachable by construction):
 *   - batchUpdateSignersWithSignatures "OpKey is zero": the opKey is keccak256 of a
 *     non-empty abi.encodePacked payload; producing bytes32(0) would require a keccak256
 *     preimage of zero, which is computationally infeasible. Dead defensive code.
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
    signLockerOp,
    getEthers
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
    const parts = [error.shortMessage, error.reason, error.message];
    if (typeof error.data === 'string') parts.push(error.data);
    if (error.info && error.info.error && error.info.error.message) parts.push(error.info.error.message);
    if (error.error && error.error.message) parts.push(error.error.message);
    return parts.filter(Boolean).join(' | ');
}

/**
 * Expects the call to revert. `expected` is a string or an array of strings —
 * the revert text must contain at least one of them (exact contract strings).
 */
async function expectRevert(callFn, label, expected) {
    const expectedList = Array.isArray(expected) ? expected : [expected];
    try {
        const result = await callFn();
        if (result && result.wait) await result.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 160)}`);
        assert(
            expectedList.some((s) => text.includes(s)),
            `${label}: expected revert containing one of [${expectedList.join(', ')}], got: ${text.substring(0, 250)}`
        );
        logSuccess(`${label} correctly reverted with "${expectedList.find((s) => text.includes(s))}"`);
        return;
    }
    throw new Error(`${label}: expected revert but call succeeded`);
}

function baseLockParams(tokenAddress, amount) {
    return {
        token: tokenAddress,
        amount,
        lockDuration: 3600,
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

/**
 * Deploys a minimal raw-bytecode stub that returns 32 zero bytes for ANY call.
 * - setLocker(address) on it: succeeds (void call, extcodesize > 0, extra data ignored)
 * - locker() on it: decodes to address(0)
 * This is the only way to reach the constructor's ERR_007 wiring check, since every
 * real module either wires correctly or reverts on double-initialization.
 *
 * Runtime (5 bytes):  PUSH1 0x20, PUSH1 0x00, RETURN        → 6020 6000 f3
 * Initcode (11 bytes): PUSH1 0x05, DUP1, PUSH1 0x0b, PUSH1 0x00, CODECOPY, PUSH1 0x00, RETURN
 */
async function deployZeroReturnStub(deployer) {
    const initcode = '0x600580600b6000396000f360206000f3';
    const tx = await deployer.sendTransaction({ data: initcode });
    const receipt = await tx.wait();
    assert(receipt.contractAddress, 'Stub deployment must yield a contract address');
    const code = await ethers.provider.getCode(receipt.contractAddress);
    assertEqual(code, '0x60206000f3', 'Stub runtime bytecode deployed');
    return receipt.contractAddress;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 48: LOCKERCONTRACT NEGATIVE-PATH COVERAGE\n', '\x1b[1m\x1b[36m');

    const state = loadSharedState();
    const deployer = await getWallet(0);

    const locker = await getContract('LockerContract', 0);
    const lockerAddress = await locker.getAddress();
    const validationHandler = await getContract('ValidationHandler', 0);
    const domain = await buildDomain(lockerAddress);
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    // Live multisig configuration
    const signers = await locker.getSigners();
    const threshold = Number(await locker.approvalsThreshold());
    log(`  Signers: ${signers.length}, threshold: ${threshold}`);

    // A wallet that IS a signer and one that is NOT
    const signerLower = signers.map((a) => a.toLowerCase());
    const signerWallet = await ethers.getSigner(signers[0]);
    let nonSigner = null;
    for (let i = 0; i < 10; i++) {
        const w = await getWallet(i);
        if (!signerLower.includes(w.address.toLowerCase())) { nonSigner = w; break; }
    }
    assert(nonSigner !== null, 'Found a non-signer wallet among the test wallets');
    log(`  Signer wallet:     ${signerWallet.address}`);
    log(`  Non-signer wallet: ${nonSigner.address}`);

    const dummySig = '0x' + '11'.repeat(65); // never verified in the paths that use it

    let passed = 0, failed = 0;

    // ════════════════════════════════════════════════════════════════════
    // PHASE 1: Constructor negatives (fresh module instances, as in 00-setup)
    // ════════════════════════════════════════════════════════════════════
    logPhase(1, 'Constructor negatives (fresh modules)');

    let freshModules = null;
    try {
        logSection('Deploying fresh modules (PriceCalculator, ValidationHandler, LockManager, VestingManager, SignerManager)');
        const fiveSigners = [];
        for (let i = 0; i < 5; i++) fiveSigners.push((await getWallet(i)).address);

        const PriceCalculator = await ethers.getContractFactory('PriceCalculator');
        const pc = await PriceCalculator.deploy(ethers.ZeroAddress, []);
        await pc.waitForDeployment();

        const ValidationHandler = await ethers.getContractFactory('ValidationHandler');
        const vh = await ValidationHandler.deploy(3);
        await vh.waitForDeployment();

        const LockManager = await ethers.getContractFactory('LockManager');
        const lm = await LockManager.deploy(await pc.getAddress());
        await lm.waitForDeployment();

        const VestingManager = await ethers.getContractFactory('VestingManager');
        const vm = await VestingManager.deploy(await lm.getAddress());
        await vm.waitForDeployment();

        const SignerManager = await ethers.getContractFactory('SignerManager');
        const sm = await SignerManager.deploy(await vh.getAddress(), fiveSigners, 3);
        await sm.waitForDeployment();

        freshModules = {
            vh: await vh.getAddress(),
            lm: await lm.getAddress(),
            sm: await sm.getAddress(),
            vm: await vm.getAddress(),
            vhContract: vh,
            fiveSigners
        };
        logSuccess('Fresh modules deployed (uninitialized: no setLocker called yet)');
    } catch (e) {
        log(`  ❌ Fresh module deployment FAILED: ${e.message}`);
    }

    const LockerContractFactory = await ethers.getContractFactory('LockerContract');

    // C1 — zero module address
    try {
        logSection('C1 — constructor with a zero module address');
        assert(freshModules, 'Fresh modules required');
        await expectRevert(
            () => LockerContractFactory.deploy(
                ethers.ZeroAddress, freshModules.lm, freshModules.sm, freshModules.vm,
                freshModules.fiveSigners, 3
            ),
            'C1a (validationHandler = 0)',
            'Invalid contract addresses'
        );
        await expectRevert(
            () => LockerContractFactory.deploy(
                freshModules.vh, freshModules.lm, freshModules.sm, ethers.ZeroAddress,
                freshModules.fiveSigners, 3
            ),
            'C1b (vestingManager = 0)',
            'Invalid contract addresses'
        );
        passed++;
    } catch (e) { log(`  ❌ C1 FAILED: ${e.message}`); failed++; }

    // C2 — invalid signers count (below 3 and above 20)
    try {
        logSection('C2 — constructor with invalid signers count');
        assert(freshModules, 'Fresh modules required');
        const twoSigners = freshModules.fiveSigners.slice(0, 2);
        await expectRevert(
            () => LockerContractFactory.deploy(
                freshModules.vh, freshModules.lm, freshModules.sm, freshModules.vm,
                twoSigners, 3
            ),
            'C2a (2 signers)',
            'Invalid signers count (must be 3-20)'
        );
        const twentyOneSigners = Array.from({ length: 21 }, () => ethers.Wallet.createRandom().address);
        await expectRevert(
            () => LockerContractFactory.deploy(
                freshModules.vh, freshModules.lm, freshModules.sm, freshModules.vm,
                twentyOneSigners, 3
            ),
            'C2b (21 signers)',
            'Invalid signers count (must be 3-20)'
        );
        passed++;
    } catch (e) { log(`  ❌ C2 FAILED: ${e.message}`); failed++; }

    // C3 — invalid threshold (below 3 and above signer count)
    try {
        logSection('C3 — constructor with invalid threshold');
        assert(freshModules, 'Fresh modules required');
        await expectRevert(
            () => LockerContractFactory.deploy(
                freshModules.vh, freshModules.lm, freshModules.sm, freshModules.vm,
                freshModules.fiveSigners.slice(0, 3), 2
            ),
            'C3a (threshold 2 < min 3)',
            'Invalid threshold'
        );
        await expectRevert(
            () => LockerContractFactory.deploy(
                freshModules.vh, freshModules.lm, freshModules.sm, freshModules.vm,
                freshModules.fiveSigners, 6
            ),
            'C3b (threshold 6 > 5 signers)',
            'Invalid threshold'
        );
        passed++;
    } catch (e) { log(`  ❌ C3 FAILED: ${e.message}`); failed++; }

    // C4 — ERR_007: wiring mismatch (stub accepts setLocker but locker() stays 0)
    try {
        logSection('C4 — constructor ERR_007 (setLocker/locker() wiring mismatch)');
        assert(freshModules, 'Fresh modules required');
        const stub = await deployZeroReturnStub(deployer);
        log(`  Zero-return stub (fake ValidationHandler): ${stub}`);
        await expectRevert(
            () => LockerContractFactory.deploy(
                stub, freshModules.lm, freshModules.sm, freshModules.vm,
                freshModules.fiveSigners, 3
            ),
            'C4 (stub.locker() returns address(0))',
            'ERR_007'
        );
        passed++;
    } catch (e) { log(`  ❌ C4 FAILED: ${e.message}`); failed++; }

    // C5 — control: same fresh modules wire successfully with valid arguments
    try {
        logSection('C5 — control: fresh modules deploy successfully');
        assert(freshModules, 'Fresh modules required');
        const freshLocker = await LockerContractFactory.deploy(
            freshModules.vh, freshModules.lm, freshModules.sm, freshModules.vm,
            freshModules.fiveSigners, 3
        );
        await freshLocker.waitForDeployment();
        const freshLockerAddress = await freshLocker.getAddress();
        assertEqual(
            await freshModules.vhContract.locker(),
            freshLockerAddress,
            'Fresh ValidationHandler wired to the fresh LockerContract'
        );
        assertEqual((await freshLocker.getSigners()).length, 5, 'Fresh locker exposes 5 signers');
        logSuccess('C5 — control deployment succeeded (previous reverts were the asserted requires)');
        passed++;
    } catch (e) { log(`  ❌ C5 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 2: createLock negatives (shared LockerContract instance)
    // ════════════════════════════════════════════════════════════════════
    logPhase(2, 'createLock negatives');

    // L1 — amount == 0, called by a signer (passes onlySigner, fails amount require)
    try {
        logSection('L1 — createLock with amount == 0 (signer caller)');
        await expectRevert(
            () => locker.connect(signerWallet).createLock(baseLockParams(state.contracts.TestToken, 0)),
            'L1 (amount == 0)',
            'Lock amount must be greater than 0'
        );
        passed++;
    } catch (e) { log(`  ❌ L1 FAILED: ${e.message}`); failed++; }

    // L2 — non-signer caller → custom error NotSigner()
    try {
        logSection('L2 — createLock from a non-signer');
        await expectRevert(
            () => locker.connect(nonSigner).createLock(
                baseLockParams(state.contracts.TestToken, ethers.parseEther('1'))
            ),
            'L2 (non-signer caller)',
            ['NotSigner', ethers.id('NotSigner()').slice(0, 10)]
        );
        passed++;
    } catch (e) { log(`  ❌ L2 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 3: createLockWithSignatures negatives
    // ════════════════════════════════════════════════════════════════════
    logPhase(3, 'createLockWithSignatures negatives');

    // S1 — amount == 0 (checked before any signature handling)
    try {
        logSection('S1 — createLockWithSignatures with amount == 0');
        await expectRevert(
            () => locker.connect(deployer).createLockWithSignatures(
                baseLockParams(state.contracts.TestToken, 0),
                { signer: signers[0], signature: dummySig }
            ),
            'S1 (amount == 0)',
            'Lock amount must be greater than 0'
        );
        passed++;
    } catch (e) { log(`  ❌ S1 FAILED: ${e.message}`); failed++; }

    // S2 — sigParams.signer is not an authorized signer → NotSigner()
    try {
        logSection('S2 — createLockWithSignatures with unauthorized sig signer');
        await expectRevert(
            () => locker.connect(deployer).createLockWithSignatures(
                baseLockParams(state.contracts.TestToken, ethers.parseEther('1')),
                { signer: nonSigner.address, signature: dummySig }
            ),
            'S2 (unauthorized signer)',
            ['NotSigner', ethers.id('NotSigner()').slice(0, 10)]
        );
        passed++;
    } catch (e) { log(`  ❌ S2 FAILED: ${e.message}`); failed++; }

    // S3 — forged signature: correct opKey signed by the WRONG key → INV_SIG
    try {
        logSection('S3 — createLockWithSignatures with forged signature');
        const lockParams = baseLockParams(state.contracts.TestToken, ethers.parseEther('1'));
        const nonceBefore = await locker.createLockNonce();

        // Correct CreateLock struct (claimed signer = a real signer), so its hashStruct
        // matches the opKey the contract derives from sigParams.signer = signers[0]...
        const createLockMessage = {
            token: lockParams.token,
            amount: lockParams.amount,
            lockDuration: lockParams.lockDuration,
            pair: lockParams.pair,
            ethUsdPair: lockParams.ethUsdPair,
            targetPriceUSD1e18: lockParams.targetPriceUSD1e18,
            isEthPair: lockParams.isEthPair,
            stablecoinPosition: lockParams.stablecoinPosition,
            priceDirection: lockParams.priceDirection,
            vestingTokensPerPeriod: lockParams.vestingTokensPerPeriod,
            vestingPeriodSeconds: lockParams.vestingPeriodSeconds,
            vestingAccumulate: lockParams.vestingAccumulate,
            nonce: nonceBefore,
            signer: signers[0]
        };
        // ... but signed by the non-signer's key: recovered != claimed signer
        const forgedSignature = await signLockerOp(nonSigner, domain, 'CreateLock', createLockMessage);

        await expectRevert(
            () => locker.connect(deployer).createLockWithSignatures(
                lockParams,
                { signer: signers[0], signature: forgedSignature }
            ),
            'S3 (forged signature)',
            'INV_SIG'
        );
        assertEqual(await locker.createLockNonce(), nonceBefore, 'createLockNonce unchanged by rejected call');
        passed++;
    } catch (e) { log(`  ❌ S3 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 4: rescue negatives — "Invalid amount or recipient"
    // ════════════════════════════════════════════════════════════════════
    logPhase(4, 'Rescue negatives (token path needs full threshold signatures)');

    // R1 — token rescue with amount == 0 (signature validation passes, library require fires)
    try {
        logSection('R1 — executeRescueWithSignatures with amount == 0');
        const rescueNonceBefore = await locker.rescueNonce();
        const to = (await getWallet(3)).address;
        const sigs = await collectSignatures(
            'RescueToken',
            { token: state.contracts.TestToken2, to, amount: 0, chainId, nonce: rescueNonceBefore },
            signers, threshold, domain
        );
        await expectRevert(
            () => locker.connect(deployer).executeRescueWithSignatures(
                state.contracts.TestToken2, to, 0, sigs.addresses, sigs.signatures
            ),
            'R1 (token rescue, amount == 0)',
            'Invalid amount or recipient'
        );
        assertEqual(await locker.rescueNonce(), rescueNonceBefore, 'rescueNonce unchanged by reverted rescue');
        passed++;
    } catch (e) { log(`  ❌ R1 FAILED: ${e.message}`); failed++; }

    // R2 — token rescue with to == address(0)
    try {
        logSection('R2 — executeRescueWithSignatures with to == address(0)');
        const sigs = await collectSignatures(
            'RescueToken',
            { token: state.contracts.TestToken2, to: ethers.ZeroAddress, amount: 1n, chainId, nonce: await locker.rescueNonce() },
            signers, threshold, domain
        );
        await expectRevert(
            () => locker.connect(deployer).executeRescueWithSignatures(
                state.contracts.TestToken2, ethers.ZeroAddress, 1n, sigs.addresses, sigs.signatures
            ),
            'R2 (token rescue, to == 0)',
            'Invalid amount or recipient'
        );
        passed++;
    } catch (e) { log(`  ❌ R2 FAILED: ${e.message}`); failed++; }

    // R3 — native rescue with amount == 0 (require fires before signature handling)
    try {
        logSection('R3 — executeRescueNativeWithSignatures with amount == 0');
        const nativeRecipient = (await getWallet(3)).address;
        await expectRevert(
            () => locker.connect(deployer).executeRescueNativeWithSignatures(
                nativeRecipient, 0, [], []
            ),
            'R3 (native rescue, amount == 0)',
            'Invalid amount or recipient'
        );
        passed++;
    } catch (e) { log(`  ❌ R3 FAILED: ${e.message}`); failed++; }

    // R4 — native rescue with to == address(0)
    try {
        logSection('R4 — executeRescueNativeWithSignatures with to == address(0)');
        await expectRevert(
            () => locker.connect(deployer).executeRescueNativeWithSignatures(
                ethers.ZeroAddress, 1n, [], []
            ),
            'R4 (native rescue, to == 0)',
            'Invalid amount or recipient'
        );
        passed++;
    } catch (e) { log(`  ❌ R4 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 5: unlockVestedWithSignatures — "Invalid recipient"
    // ════════════════════════════════════════════════════════════════════
    logPhase(5, 'unlockVestedWithSignatures negatives');

    // V1 — recipient == address(0) (first require, no signatures needed)
    try {
        logSection('V1 — unlockVestedWithSignatures with recipient == address(0)');
        await expectRevert(
            () => locker.connect(deployer).unlockVestedWithSignatures(
                999999, ethers.ZeroAddress, 1n, [], []
            ),
            'V1 (recipient == 0)',
            'Invalid recipient'
        );
        passed++;
    } catch (e) { log(`  ❌ V1 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 6: updateThresholdWithSignatures — threshold too high
    // ════════════════════════════════════════════════════════════════════
    logPhase(6, 'updateThresholdWithSignatures negatives');

    // T1 — newThreshold above signer count (checked before signature validation)
    try {
        logSection('T1 — updateThresholdWithSignatures above signer count');
        const tooHigh = signers.length + 1;
        log(`  Current signer count: ${signers.length}, requesting threshold: ${tooHigh}`);
        await expectRevert(
            () => locker.connect(deployer).updateThresholdWithSignatures(tooHigh, [], []),
            'T1 (threshold > signer count)',
            'Threshold too high (max is signer count)'
        );
        passed++;
    } catch (e) { log(`  ❌ T1 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 7: batchUpdateSignersWithSignatures — empty batch
    // ════════════════════════════════════════════════════════════════════
    logPhase(7, 'batchUpdateSignersWithSignatures negatives');

    // B1 — both toRemove and toAdd empty
    // (The sibling "OpKey is zero" require is unreachable: keccak256 of the non-empty
    //  packed payload can never be bytes32(0) — see file header.)
    try {
        logSection('B1 — batchUpdateSignersWithSignatures with no signers provided');
        await expectRevert(
            () => locker.connect(deployer).batchUpdateSignersWithSignatures([], [], [], []),
            'B1 (empty add/remove arrays)',
            'No signers provided'
        );
        passed++;
    } catch (e) { log(`  ❌ B1 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 8: neutral view wrappers on the Locker instance
    // ════════════════════════════════════════════════════════════════════
    logPhase(8, 'Neutral view wrappers: approvalsCount / hasApproved');

    // W1 — both wrappers delegate to ValidationHandler and report neutral values
    try {
        logSection('W1 — approvalsCount(bytes32) and hasApproved(bytes32,address)');
        const probeOpKey = ethers.keccak256(ethers.toUtf8Bytes('48-neutral-wrapper-probe'));

        const count = await locker.approvalsCount(probeOpKey);
        assertEqual(count, 0n, 'locker.approvalsCount(unknown opKey) is 0');

        const approved = await locker.hasApproved(probeOpKey, signers[0]);
        assertEqual(approved, false, 'locker.hasApproved(unknown opKey, signer) is false');

        // Wrappers must agree with the ValidationHandler they delegate to
        assertEqual(
            await validationHandler.approvalsCount(probeOpKey),
            count,
            'Wrapper approvalsCount matches ValidationHandler'
        );
        assertEqual(
            await validationHandler.hasApproved(probeOpKey, signers[0]),
            approved,
            'Wrapper hasApproved matches ValidationHandler'
        );
        passed++;
    } catch (e) { log(`  ❌ W1 FAILED: ${e.message}`); failed++; }

    // ════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ════════════════════════════════════════════════════════════════════
    log('\n' + '═'.repeat(70), '\x1b[1m\x1b[36m');
    log(`RESULTS: ${passed}/${passed + failed} scenarios PASSED`, '\x1b[1m\x1b[36m');
    log('═'.repeat(70), '\x1b[1m\x1b[36m');

    if (failed > 0) {
        reportTestResult('48-lockercontract-negatives', false, `${failed} scenario(s) failed`);
        throw new Error(`${failed} scenario(s) failed`);
    }
    reportTestResult('48-lockercontract-negatives', true);
    logSuccess('\n✅ TEST 48 PASSED — LockerContract negative paths verified!\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
