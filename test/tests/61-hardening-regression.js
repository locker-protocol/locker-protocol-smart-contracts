/**
 * Test 61: Hardening Regression (audit findings F1, F2, F4, F5)
 *
 * Locks in the behaviour of the four hardening changes applied after the audit:
 *
 *   F1  _validateBatchUpdate rejects duplicate addresses in signersToRemove
 *       → "Duplicate removal detected"
 *   F2  setThreshold / bumpConfigEpoch / markAsExecuted are onlyLocker (the old
 *       "locker OR signerManager" surface is gone) → "Only locker allowed" for
 *       every non-locker caller, including a signer EOA
 *   F4  addToLock(lockId, 0) (auto-detect from balance) is restricted to signers
 *       → NotSigner() for outsiders; explicit-amount top-ups stay permissionless
 *   F5  _recoverSignerOptimized accepts the {0,1} yParity encoding and rejects any
 *       other v → a v∈{0,1} signature verifies; a v==29 signature reverts "ERR_006C"
 *
 * Self-contained: deploys its own stack with Hardhat-account signers.
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    signLockerOp,
    lockerOpKey,
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

let passed = 0;
function pass(label) { passed++; logSuccess(`[CHECK ${passed}] ${label}`); }

function revertText(error) {
    const parts = [error.shortMessage, error.reason, error.message].filter(Boolean);
    // Node/Hardhat combos that fail to infer the reason still carry the ABI-encoded
    // Error(string) payload in error.data (or nested); decode it for uniform assertions.
    const data = error?.data || error?.info?.error?.data || error?.error?.data;
    if (typeof data === 'string' && data.startsWith('0x')) {
        parts.push(data); // raw payload — matches custom-error selectors (e.g. NotSigner())
        if (data.startsWith('0x08c379a0')) {
            try {
                parts.push(ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0]);
            } catch (_) { /* not an Error(string) payload */ }
        }
    }
    return parts.join(' | ');
}

// Accepts a single expected substring or an array (any-match).
async function expectRevert(callFn, label, expected = null) {
    try {
        const tx = await callFn();
        if (tx && tx.wait) await tx.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 150)}`);
        if (expected) {
            const list = Array.isArray(expected) ? expected : [expected];
            assert(
                list.some(e => text.includes(e)),
                `${label}: expected one of [${list.join(', ')}], got: ${text.substring(0, 220)}`
            );
        }
        pass(`${label} correctly reverted`);
        return;
    }
    throw new Error(`${label}: expected revert but the call SUCCEEDED`);
}

function buildDomain(lockerAddress, chainId) {
    return { name: 'LockerContract', version: '1', chainId: Number(chainId), verifyingContract: lockerAddress };
}

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

// Rewrite the trailing v byte of a 65-byte signature.
function withV(sig, v) {
    return sig.substring(0, 130) + v.toString(16).padStart(2, '0');
}

function makeLockParams(tokenAddress, amount) {
    return {
        token: tokenAddress, amount, lockDuration: 0,
        pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress, targetPriceUSD1e18: 0,
        isEthPair: false, stablecoinPosition: 2, priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: 0, vestingPeriodSeconds: 0, vestingAccumulate: false
    };
}

async function deployStack(deployer, signerAddresses, threshold) {
    const VH = await ethers.getContractFactory('ValidationHandler', deployer);
    const validationHandler = await VH.deploy(threshold); await validationHandler.waitForDeployment();
    const PC = await ethers.getContractFactory('PriceCalculator', deployer);
    const priceCalculator = await PC.deploy(ethers.ZeroAddress, []); await priceCalculator.waitForDeployment();
    const LM = await ethers.getContractFactory('LockManager', deployer);
    const lockManager = await LM.deploy(await priceCalculator.getAddress()); await lockManager.waitForDeployment();
    const VM = await ethers.getContractFactory('VestingManager', deployer);
    const vestingManager = await VM.deploy(await lockManager.getAddress()); await vestingManager.waitForDeployment();
    const SM = await ethers.getContractFactory('SignerManager', deployer);
    const signerManager = await SM.deploy(await validationHandler.getAddress(), signerAddresses, threshold);
    await signerManager.waitForDeployment();
    const LC = await ethers.getContractFactory('LockerContract', deployer);
    const locker = await LC.deploy(
        await validationHandler.getAddress(), await lockManager.getAddress(),
        await signerManager.getAddress(), await vestingManager.getAddress(),
        signerAddresses, threshold
    );
    await locker.waitForDeployment();
    return { validationHandler, lockManager, vestingManager, locker };
}

async function deployToken(deployer, holder) {
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const token = await ERC20Mock.deploy('Hardening Token', 'HARD', holder, ethers.parseEther('1000000'), 18);
    await token.waitForDeployment();
    return token;
}

async function main() {
    log('\n🧪 TEST 61: HARDENING REGRESSION (F1/F2/F4/F5)\n', '\x1b[1m\x1b[36m');

    try {
        const all = await ethers.getSigners();
        const deployer = all[0];
        const nonSigner = all[9];
        const signerAccounts = [all[1], all[2], all[3], all[4], all[5]];
        const signers = signerAccounts.map(s => s.address);
        const THRESHOLD = 3;
        const executor = signerAccounts[0];
        const chainId = Number((await ethers.provider.getNetwork()).chainId);

        const { locker, lockManager, validationHandler } = await deployStack(deployer, signers, THRESHOLD);
        const lockerAddress = await locker.getAddress();
        const domain = buildDomain(lockerAddress, chainId);
        const NOT_SIGNER = ['NotSigner', ethers.id('NotSigner()').slice(0, 10)];

        // ════════════════════════════════════════════════════════════════
        // F1: duplicate address in signersToRemove
        // ════════════════════════════════════════════════════════════════
        logPhase(1, 'F1 — duplicate signersToRemove rejected');
        // newCount = 5 - 2 + 0 = 3 (passes min/threshold), so the guard reached is the
        // new duplicate check, not "Final count below minimum".
        await expectRevert(
            () => locker.connect(executor).batchUpdateSignersWithSignatures(
                [signers[0], signers[0]], [], [], []
            ),
            'F1: same signer twice in signersToRemove',
            'Duplicate removal detected'
        );

        // ════════════════════════════════════════════════════════════════
        // F2: setThreshold / bumpConfigEpoch / markAsExecuted are onlyLocker
        // ════════════════════════════════════════════════════════════════
        logPhase(2, 'F2 — onlyLocker on the ValidationHandler admin surface');
        for (const caller of [nonSigner, executor]) {
            const who = caller.address === executor.address ? 'signer EOA' : 'outsider';
            await expectRevert(
                () => validationHandler.connect(caller).setThreshold(3),
                `F2: setThreshold (${who})`, 'Only locker allowed'
            );
            await expectRevert(
                () => validationHandler.connect(caller).bumpConfigEpoch(),
                `F2: bumpConfigEpoch (${who})`, 'Only locker allowed'
            );
            await expectRevert(
                () => validationHandler.connect(caller).markAsExecuted(ethers.ZeroHash),
                `F2: markAsExecuted (${who})`, 'Only locker allowed'
            );
        }

        // ════════════════════════════════════════════════════════════════
        // F4: addToLock(lockId, 0) auto-detect restricted to signers
        // ════════════════════════════════════════════════════════════════
        logPhase(4, 'F4 — addToLock auto-detect (amount==0) is signer-gated');
        const tokenF4 = await deployToken(deployer, executor.address);
        const lockAmt = ethers.parseEther('1000');
        await (await tokenF4.connect(executor).approve(lockerAddress, lockAmt)).wait();
        const lockId = await lockManager.nextLockId();
        await (await locker.connect(executor).createLock(makeLockParams(await tokenF4.getAddress(), lockAmt))).wait();

        // Outsider auto-detect top-up → NotSigner
        await expectRevert(
            () => locker.connect(nonSigner).addToLock(lockId, 0, ethers.ZeroHash),
            'F4: non-signer addToLock(lockId, 0)', NOT_SIGNER
        );
        // Signer auto-detect with no surplus → passes the gate, fails later on "no surplus"
        await expectRevert(
            () => locker.connect(executor).addToLock(lockId, 0, ethers.ZeroHash),
            'F4: signer addToLock(lockId, 0) with no surplus', 'No additional amount to add'
        );
        // Explicit-amount top-up stays permissionless: fund the non-signer and let them top up
        const topUp = ethers.parseEther('250');
        await (await tokenF4.connect(executor).transfer(nonSigner.address, topUp)).wait();
        await (await tokenF4.connect(nonSigner).approve(lockerAddress, topUp)).wait();
        const availBefore = (await lockManager.getLock(lockId)).basic.availableAmount;
        await (await locker.connect(nonSigner).addToLock(lockId, topUp, ethers.ZeroHash)).wait();
        assertEqual(
            (await lockManager.getLock(lockId)).basic.availableAmount, availBefore + topUp,
            'F4: explicit-amount top-up by a non-signer still works (permissionless)'
        );

        // ════════════════════════════════════════════════════════════════
        // F5: v-normalization ({0,1} accepted, anything else rejected)
        // ════════════════════════════════════════════════════════════════
        logPhase(5, 'F5 — v yParity normalization');
        const drawF5 = ethers.parseEther('500');
        const nonceF5 = await locker.unlockNonce(lockId);
        const msgF5 = { lockId, to: all[7].address, amount: drawF5, nonce: nonceF5 };
        const opKeyF5 = lockerOpKey('Unlock', msgF5);

        // A single reference signature from signer0
        const refSig = await signLockerOp(executor, domain, 'Unlock', msgF5);
        const refV = parseInt(refSig.substring(130, 132), 16); // 27 or 28
        const sigV01 = withV(refSig, refV - 27); // 0 or 1
        const sigV29 = withV(refSig, 29);

        // v∈{0,1} must be accepted by the recovery path (verifySignatureOnly is view)
        await validationHandler.verifySignatureOnly(opKeyF5, executor.address, sigV01);
        pass('F5: signature with v∈{0,1} accepted');

        // v==29 (neither {0,1} nor {27,28}) must be rejected
        await expectRevert(
            () => validationHandler.verifySignatureOnly(opKeyF5, executor.address, sigV29),
            'F5: signature with v==29', 'ERR_006C'
        );

        // End-to-end: a full unlock signed with all-{0,1} v bytes goes through
        const bundle = await collectSignatures('Unlock', msgF5, signers, THRESHOLD, domain);
        const v01Bundle = bundle.signatures.map(s => withV(s, parseInt(s.substring(130, 132), 16) - 27));
        const recvBefore = await tokenF4.balanceOf(all[7].address);
        await (await locker.connect(executor).executeUnlockWithSignatures(
            lockId, all[7].address, drawF5, bundle.addresses, v01Bundle
        )).wait();
        assertEqual(
            (await tokenF4.balanceOf(all[7].address)) - recvBefore, drawF5,
            'F5: end-to-end unlock with v∈{0,1} signatures delivered the tokens'
        );

        log(`\n📊 Hardening checks passed: ${passed}\n`, '\x1b[1m\x1b[32m');
        reportTestResult('61-hardening-regression', true);
        logSuccess('\n✅ TEST 61 PASSED!\n');

    } catch (error) {
        reportTestResult('61-hardening-regression', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST 61 FAILED:\n', error);
        process.exit(1);
    });
