/**
 * Test 60: Adversarial Fund-Theft Suite
 *
 * This file is the security audit's attack list made executable. Each phase is one
 * concrete attempt to DIVERT LOCKED FUNDS, and asserts on-chain that it fails and that
 * no token leaves the contract unless the full M-of-N EIP-712 multisig authorized it.
 *
 * Attacks (mirrors the audit's "what I tried and why it fails"):
 *   P1  Replay a multisig-approved unlock to drain more than approved
 *   P2  Reach the threshold with fewer than M distinct signers (duplicate signatures)
 *   P3  A single compromised signer drains (and createLockWithSignatures only deposits)
 *   P4  Hijack the deploy-time wiring (front-run setLocker)
 *   P5  Bypass the time/price condition via rescue on a token that has a live lock
 *   P6  Manipulate the spot oracle to release funds without the multisig
 *   P7  Re-enter executeUnlockWithSignatures during the token transfer (ERC-777 style)
 *   P8  Drain a sibling lock via the pooled per-token balance
 *   P9  Signature malleability (upper-half s)
 *   P10 Cross-chain / cross-field signature replay
 *   P11 Vesting: exceed the signed cap / double-claim within a period
 *
 * Fully self-contained: deploys its own Locker stack with signers whose keys the test
 * controls (Hardhat accounts), so it never touches the shared-state deployment.
 */

import {
    logPhase,
    logSection,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    advanceTime,
    signLockerOp,
    PRICE_DIRECTION,
    getEthers
} from '../core/utils.js';

const ethers = getEthers();

// ============================================================================
// HELPERS
// ============================================================================

let passed = 0;
function pass(label) { passed++; logSuccess(`[CHECK ${passed}] ${label}`); }

function revertText(error) {
    const parts = [error.shortMessage, error.reason, error.message].filter(Boolean);
    // Node/Hardhat combos that fail to infer the reason still carry the ABI-encoded
    // Error(string) payload in error.data (or nested). Decode it so substring
    // assertions work uniformly across every revert.
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

async function expectRevert(callFn, label, expectedSubstring = null) {
    try {
        const tx = await callFn();
        if (tx && tx.wait) await tx.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 150)}`);
        if (expectedSubstring) {
            assert(
                text.includes(expectedSubstring),
                `${label}: expected revert containing "${expectedSubstring}", got: ${text.substring(0, 220)}`
            );
        }
        pass(`${label} correctly reverted${expectedSubstring ? ` ("${expectedSubstring}")` : ''}`);
        return;
    }
    throw new Error(`${label}: expected revert but the call SUCCEEDED (funds may be at risk!)`);
}

function buildDomain(lockerAddress, chainId) {
    return { name: 'LockerContract', version: '1', chainId: Number(chainId), verifyingContract: lockerAddress };
}

// Collect `count` signatures over the typed op struct from DISTINCT signers.
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

function makeLockParams(tokenAddress, amount, overrides = {}) {
    return {
        token: tokenAddress,
        amount,
        lockDuration: 0,
        pair: ethers.ZeroAddress,
        ethUsdPair: ethers.ZeroAddress,
        targetPriceUSD1e18: 0,
        isEthPair: false,
        stablecoinPosition: 2,
        priceDirection: PRICE_DIRECTION.UPSIDE,
        vestingTokensPerPeriod: 0,
        vestingPeriodSeconds: 0,
        vestingAccumulate: false,
        ...overrides
    };
}

// Deploy a fresh, fully-wired Locker stack. `deployer` deploys every module (so the
// tx.origin wiring in the LockerContract constructor succeeds) and `signerAddresses`
// become the M-of-N signer set.
async function deployStack(deployer, signerAddresses, threshold) {
    const ValidationHandler = await ethers.getContractFactory('ValidationHandler', deployer);
    const validationHandler = await ValidationHandler.deploy(threshold);
    await validationHandler.waitForDeployment();

    const PriceCalculator = await ethers.getContractFactory('PriceCalculator', deployer);
    const priceCalculator = await PriceCalculator.deploy(ethers.ZeroAddress, []);
    await priceCalculator.waitForDeployment();

    const LockManager = await ethers.getContractFactory('LockManager', deployer);
    const lockManager = await LockManager.deploy(await priceCalculator.getAddress());
    await lockManager.waitForDeployment();

    const VestingManager = await ethers.getContractFactory('VestingManager', deployer);
    const vestingManager = await VestingManager.deploy(await lockManager.getAddress());
    await vestingManager.waitForDeployment();

    const SignerManager = await ethers.getContractFactory('SignerManager', deployer);
    const signerManager = await SignerManager.deploy(
        await validationHandler.getAddress(), signerAddresses, threshold
    );
    await signerManager.waitForDeployment();

    const LockerContract = await ethers.getContractFactory('LockerContract', deployer);
    const locker = await LockerContract.deploy(
        await validationHandler.getAddress(),
        await lockManager.getAddress(),
        await signerManager.getAddress(),
        await vestingManager.getAddress(),
        signerAddresses,
        threshold
    );
    await locker.waitForDeployment();

    return { validationHandler, priceCalculator, lockManager, vestingManager, signerManager, locker };
}

// Deploy an 18-decimal mock token holding `supply` for `holder`.
async function deployToken(deployer, holder, supply = ethers.parseEther('1000000')) {
    const ERC20Mock = await ethers.getContractFactory('ERC20Mock', deployer);
    const token = await ERC20Mock.deploy('Adversarial Token', 'ADV', holder, supply, 18);
    await token.waitForDeployment();
    return token;
}

// Create a lock funded by `creator` (must be a signer) and return its id.
async function createLock(locker, lockManager, token, creator, params) {
    await (await token.connect(creator).approve(await locker.getAddress(), params.amount)).wait();
    const lockId = await lockManager.nextLockId();
    await (await locker.connect(creator).createLock(params)).wait();
    return lockId;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 60: ADVERSARIAL FUND-THEFT SUITE\n', '\x1b[1m\x1b[36m');

    try {
        const all = await ethers.getSigners();
        const deployer = all[0];
        const attacker = all[9];
        const recipient = all[8];
        // 5 signers, threshold 3 (a real M-of-N)
        const signerAccounts = [all[1], all[2], all[3], all[4], all[5]];
        const signers = signerAccounts.map(s => s.address);
        const THRESHOLD = 3;
        const executor = signerAccounts[0]; // a signer, needed for onlySigner createLock

        const chainId = Number((await ethers.provider.getNetwork()).chainId);

        logSection('Deploy an isolated Locker stack (5 signers, threshold 3)');
        const { locker, lockManager, validationHandler, vestingManager } =
            await deployStack(deployer, signers, THRESHOLD);
        const lockerAddress = await locker.getAddress();
        const domain = buildDomain(lockerAddress, chainId);
        assertEqual(await locker.approvalsThreshold(), THRESHOLD, 'threshold = 3');
        assertEqual((await locker.getSigners()).length, 5, '5 signers');

        // ════════════════════════════════════════════════════════════════
        // P1: Replay a multisig-approved unlock to drain MORE than approved
        // ════════════════════════════════════════════════════════════════
        logPhase(1, 'Replay an approved unlock to over-drain');

        const tokenP1 = await deployToken(deployer, executor.address);
        const lockAmtP1 = ethers.parseEther('10000');
        const lockIdP1 = await createLock(locker, lockManager, tokenP1, executor, makeLockParams(await tokenP1.getAddress(), lockAmtP1));

        const drawP1 = ethers.parseEther('4000');
        const nonceP1 = await locker.unlockNonce(lockIdP1);
        const sigsP1 = await collectSignatures(
            'Unlock', { lockId: lockIdP1, to: recipient.address, amount: drawP1, nonce: nonceP1 },
            signers, THRESHOLD, domain
        );

        const recvBeforeP1 = await tokenP1.balanceOf(recipient.address);
        await (await locker.connect(executor).executeUnlockWithSignatures(
            lockIdP1, recipient.address, drawP1, sigsP1.addresses, sigsP1.signatures
        )).wait();
        assertEqual((await tokenP1.balanceOf(recipient.address)) - recvBeforeP1, drawP1, 'legit unlock delivered 4000');

        // Replay the SAME signatures — nonce advanced, opKey no longer matches
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdP1, recipient.address, drawP1, sigsP1.addresses, sigsP1.signatures
            ),
            'Replay of the executed unlock',
            'ERR_005: Invalid signature'
        );
        assertEqual((await tokenP1.balanceOf(recipient.address)) - recvBeforeP1, drawP1, 'no extra tokens from replay');
        assertEqual((await lockManager.getLock(lockIdP1)).basic.availableAmount, lockAmtP1 - drawP1, 'lock debited exactly once');

        // ════════════════════════════════════════════════════════════════
        // P2: Reach threshold with fewer than M distinct signers (duplicates)
        // ════════════════════════════════════════════════════════════════
        logPhase(2, 'Inflate the approval count with duplicate signatures');

        const drawP2 = ethers.parseEther('1000');
        const nonceP2 = await locker.unlockNonce(lockIdP1);
        const oneSig = await collectSignatures(
            'Unlock', { lockId: lockIdP1, to: attacker.address, amount: drawP2, nonce: nonceP2 },
            signers, 1, domain
        );
        // Same signer repeated THRESHOLD times → idempotent, count stays 1
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdP1, attacker.address, drawP2,
                [oneSig.addresses[0], oneSig.addresses[0], oneSig.addresses[0]],
                [oneSig.signatures[0], oneSig.signatures[0], oneSig.signatures[0]]
            ),
            'Unlock with one signer duplicated 3×',
            'Insufficient approvals'
        );

        // Two distinct signers, one of them duplicated to fake a 3rd → count stays 2
        const twoSigs = await collectSignatures(
            'Unlock', { lockId: lockIdP1, to: attacker.address, amount: drawP2, nonce: nonceP2 },
            signers, 2, domain
        );
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdP1, attacker.address, drawP2,
                [twoSigs.addresses[0], twoSigs.addresses[1], twoSigs.addresses[0]],
                [twoSigs.signatures[0], twoSigs.signatures[1], twoSigs.signatures[0]]
            ),
            'Unlock with 2 distinct + 1 duplicate signer',
            'Insufficient approvals'
        );
        assertEqual(await tokenP1.balanceOf(attacker.address), 0n, 'attacker received nothing');

        // ════════════════════════════════════════════════════════════════
        // P3: A single compromised signer drains
        // ════════════════════════════════════════════════════════════════
        logPhase(3, 'Single-signer withdrawal, and createLockWithSignatures only deposits');

        const drawP3 = ethers.parseEther('1000');
        const nonceP3 = await locker.unlockNonce(lockIdP1);
        const solo = await collectSignatures(
            'Unlock', { lockId: lockIdP1, to: attacker.address, amount: drawP3, nonce: nonceP3 },
            signers, 1, domain
        );
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockIdP1, attacker.address, drawP3, solo.addresses, solo.signatures
            ),
            'Unlock with a single signer (threshold is 3)',
            'Insufficient approvals'
        );

        // The only single-signature entry point (createLockWithSignatures) DEPOSITS.
        const tokenP3 = await deployToken(deployer, executor.address);
        const depositAmt = ethers.parseEther('777');
        const cnP3 = await locker.createLockNonce();
        const createMsg = {
            token: await tokenP3.getAddress(), amount: depositAmt, lockDuration: 0,
            pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress, targetPriceUSD1e18: 0,
            isEthPair: false, stablecoinPosition: 2, priceDirection: PRICE_DIRECTION.UPSIDE,
            vestingTokensPerPeriod: 0, vestingPeriodSeconds: 0, vestingAccumulate: false,
            nonce: cnP3, signer: executor.address
        };
        const createSig = await signLockerOp(executor, domain, 'CreateLock', createMsg);
        await (await tokenP3.connect(executor).approve(lockerAddress, depositAmt)).wait();
        const lockerBeforeP3 = await tokenP3.balanceOf(lockerAddress);
        await (await locker.connect(executor).createLockWithSignatures(
            makeLockParams(await tokenP3.getAddress(), depositAmt),
            { signer: executor.address, signature: createSig }
        )).wait();
        assertEqual(
            (await tokenP3.balanceOf(lockerAddress)) - lockerBeforeP3, depositAmt,
            'single-sig createLock ADDED funds to the contract (no extraction path)'
        );

        // ════════════════════════════════════════════════════════════════
        // P4: Hijack the deploy-time wiring (front-run setLocker)
        // ════════════════════════════════════════════════════════════════
        logPhase(4, 'Deploy-time wiring hijack');

        // A fresh, un-wired module deployed by `deployer`; the attacker tries to claim it.
        // (The reason string is asserted behaviourally here: on the localhost JSON-RPC node
        //  the revert reason for this particular tx is not always surfaced by ethers, so we
        //  assert the STRONGER property — the hijack attempt changed no state at all.)
        const VH = await ethers.getContractFactory('ValidationHandler', deployer);
        const freshVH = await VH.deploy(THRESHOLD);
        await freshVH.waitForDeployment();
        await expectRevert(
            () => freshVH.connect(attacker).setLocker(attacker.address),
            'Attacker calling setLocker on a fresh module (tx.origin != deployer)'
        );
        assertEqual(await freshVH.locker(), ethers.ZeroAddress, 'fresh module NOT wired to the attacker');
        assert((await freshVH.initialized()) === false, 'fresh module still uninitialized after the hijack attempt');

        // The live module is already wired: re-wiring is refused for everyone (even the deployer).
        await expectRevert(
            () => validationHandler.connect(deployer).setLocker(attacker.address),
            'Re-wiring the live ValidationHandler'
        );
        assertEqual(await validationHandler.locker(), lockerAddress, 'live module still points at the real locker');

        // ════════════════════════════════════════════════════════════════
        // P5: Bypass the condition via rescue on a token that has a live lock
        // ════════════════════════════════════════════════════════════════
        logPhase(5, 'Rescue a token that has an active lock');

        const rescueAmt = ethers.parseEther('5000');
        const tokenP1Address = await tokenP1.getAddress();
        const rnP5 = await locker.rescueNonce();
        const rescueSigs = await collectSignatures(
            'RescueToken',
            { token: tokenP1Address, to: attacker.address, amount: rescueAmt, chainId, nonce: rnP5 },
            signers, THRESHOLD, domain
        );
        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                tokenP1Address, attacker.address, rescueAmt, rescueSigs.addresses, rescueSigs.signatures
            ),
            'Full-multisig rescue of a token with a live lock',
            'Lock exists for this token'
        );
        assertEqual(await tokenP1.balanceOf(attacker.address), 0n, 'rescue moved nothing to the attacker');

        // ════════════════════════════════════════════════════════════════
        // P6: Manipulate the spot oracle to release funds without the multisig
        // ════════════════════════════════════════════════════════════════
        logPhase(6, 'Spot-price manipulation cannot release funds without M-of-N');

        const stable = await deployToken(deployer, executor.address); // 18-dec stand-in stablecoin
        const priceToken = await deployToken(deployer, executor.address);
        const Pair = await ethers.getContractFactory('MockUniswapV2Pair', deployer);
        // token0 = priceToken, token1 = stable => stablecoinPosition = 2
        const pair = await Pair.deploy(await priceToken.getAddress(), await stable.getAddress());
        await pair.waitForDeployment();
        // Seed the pool at $1 (target), then a price lock that only opens on price (huge duration)
        await (await pair.setPriceForToken(await priceToken.getAddress(), ethers.parseEther('1'))).wait();

        const priceLockAmt = ethers.parseEther('10000');
        const priceParams = makeLockParams(await priceToken.getAddress(), priceLockAmt, {
            lockDuration: 365 * 24 * 3600, // far future => timeOk stays false
            pair: await pair.getAddress(),
            targetPriceUSD1e18: ethers.parseEther('1'),
            stablecoinPosition: 2,
            priceDirection: PRICE_DIRECTION.UPSIDE
        });
        const priceLockId = await createLock(locker, lockManager, priceToken, executor, priceParams);

        // Attacker flashes the spot price to 2× the target → priceOk flips true
        await (await pair.setPriceForToken(await priceToken.getAddress(), ethers.parseEther('2'))).wait();
        const statusP6 = await lockManager.getLockStatus(priceLockId);
        assert(statusP6.priceOk === true, 'price condition reads OPEN after spot manipulation');
        assert(statusP6.timeOk === false, 'time condition still closed');
        pass('spot manipulation flipped priceOk true (as the audit notes it can)');

        // ...but a withdrawal STILL needs the multisig. No signatures:
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(
                priceLockId, attacker.address, priceLockAmt, [], []
            ),
            'Unlock on a price-open lock with ZERO signatures',
            'Insufficient approvals'
        );
        // Attacker self-signs as a non-signer:
        const selfSig = await signLockerOp(
            attacker, domain, 'Unlock',
            { lockId: priceLockId, to: attacker.address, amount: priceLockAmt, nonce: await locker.unlockNonce(priceLockId) }
        );
        await expectRevert(
            () => locker.connect(attacker).executeUnlockWithSignatures(
                priceLockId, attacker.address, priceLockAmt, [attacker.address], [selfSig]
            ),
            'Unlock on a price-open lock with an attacker self-signature',
            'ERR_001: Not authorized signer'
        );
        assertEqual(await priceToken.balanceOf(attacker.address), 0n, 'attacker drained nothing via price manipulation');

        // Positive control: the real M-of-N CAN unlock the price-open lock.
        const p6Sigs = await collectSignatures(
            'Unlock', { lockId: priceLockId, to: recipient.address, amount: priceLockAmt, nonce: await locker.unlockNonce(priceLockId) },
            signers, THRESHOLD, domain
        );
        const recvBeforeP6 = await priceToken.balanceOf(recipient.address);
        await (await locker.connect(executor).executeUnlockWithSignatures(
            priceLockId, recipient.address, priceLockAmt, p6Sigs.addresses, p6Sigs.signatures
        )).wait();
        assertEqual((await priceToken.balanceOf(recipient.address)) - recvBeforeP6, priceLockAmt, 'M-of-N unlock on a price-open lock works');

        // ════════════════════════════════════════════════════════════════
        // P7: Re-enter executeUnlockWithSignatures during the token transfer
        // ════════════════════════════════════════════════════════════════
        logPhase(7, 'Reentrancy during the unlock out-transfer');

        const Reentrant = await ethers.getContractFactory('ReentrantUnlockToken', deployer);
        const evil = await Reentrant.deploy(executor.address, ethers.parseEther('100000'));
        await evil.waitForDeployment();

        const evilLockAmt = ethers.parseEther('10000');
        const evilLockId = await createLock(locker, lockManager, evil, executor, makeLockParams(await evil.getAddress(), evilLockAmt));

        const evilDraw = ethers.parseEther('1000');
        const evilNonce = await locker.unlockNonce(evilLockId);
        const evilSigs = await collectSignatures(
            'Unlock', { lockId: evilLockId, to: recipient.address, amount: evilDraw, nonce: evilNonce },
            signers, THRESHOLD, domain
        );
        // Arm the token to re-enter with the SAME (still-valid, same-nonce) payload
        await (await evil.arm(
            lockerAddress, evilLockId, recipient.address, evilDraw, evilSigs.addresses, evilSigs.signatures
        )).wait();

        const recvBeforeP7 = await evil.balanceOf(recipient.address);
        await (await locker.connect(executor).executeUnlockWithSignatures(
            evilLockId, recipient.address, evilDraw, evilSigs.addresses, evilSigs.signatures
        )).wait();

        assert(await evil.reentryAttempted(), 'the malicious token attempted a re-entry');
        assert(await evil.reentryBlocked(), 'the re-entrant unlock was blocked (guard/ordering held)');
        assertEqual((await evil.balanceOf(recipient.address)) - recvBeforeP7, evilDraw, 'exactly one unlock delivered (no double-spend)');
        assertEqual((await lockManager.getLock(evilLockId)).basic.availableAmount, evilLockAmt - evilDraw, 'lock debited exactly once');

        // ════════════════════════════════════════════════════════════════
        // P8: Drain a sibling lock via the pooled per-token balance
        // ════════════════════════════════════════════════════════════════
        logPhase(8, 'Cross-lock drain via the pooled token balance');

        const tokenP8 = await deployToken(deployer, executor.address);
        const lockAmtP8 = ethers.parseEther('1000');
        const lockA = await createLock(locker, lockManager, tokenP8, executor, makeLockParams(await tokenP8.getAddress(), lockAmtP8));
        const lockB = await createLock(locker, lockManager, tokenP8, executor, makeLockParams(await tokenP8.getAddress(), lockAmtP8));
        assertEqual(await tokenP8.balanceOf(lockerAddress), lockAmtP8 * 2n, 'contract pools 2000 for the two locks');

        // Try to pull 1500 out of lockB (which only holds 1000) even though the contract holds 2000
        const overDraw = ethers.parseEther('1500');
        const nonceB = await locker.unlockNonce(lockB);
        const sigsOver = await collectSignatures(
            'Unlock', { lockId: lockB, to: attacker.address, amount: overDraw, nonce: nonceB },
            signers, THRESHOLD, domain
        );
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockB, attacker.address, overDraw, sigsOver.addresses, sigsOver.signatures
            ),
            'Unlock 1500 from lockB (holds 1000) while the pool holds 2000',
            'Insufficient available amount in lock'
        );
        assertEqual(await tokenP8.balanceOf(attacker.address), 0n, 'no cross-lock drain');
        // Each lock is still independently bounded
        assertEqual((await lockManager.getLock(lockA)).basic.availableAmount, lockAmtP8, 'lockA intact');
        assertEqual((await lockManager.getLock(lockB)).basic.availableAmount, lockAmtP8, 'lockB intact');

        // ════════════════════════════════════════════════════════════════
        // P9: Signature malleability (upper-half s)
        // ════════════════════════════════════════════════════════════════
        logPhase(9, 'Malleable (upper-half s) signature rejected');

        const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
        const drawP9 = ethers.parseEther('1000');
        const nonceP9 = await locker.unlockNonce(lockA);
        const msgP9 = { lockId: lockA, to: recipient.address, amount: drawP9, nonce: nonceP9 };
        const s0 = await collectSignatures('Unlock', msgP9, signers, 3, domain);
        // Flip signer[2]'s signature into its malleable twin (s' = n - s, v flipped)
        const raw = s0.signatures[2];
        const sOrig = BigInt('0x' + raw.substring(66, 130));
        const flippedS = SECP256K1_N - sOrig;
        const vByte = parseInt(raw.substring(130, 132), 16);
        const flippedV = (vByte === 27 ? 28 : 27).toString(16).padStart(2, '0');
        const malleable = raw.substring(0, 66) + flippedS.toString(16).padStart(64, '0') + flippedV;
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockA, recipient.address, drawP9,
                s0.addresses, [s0.signatures[0], s0.signatures[1], malleable]
            ),
            'Unlock with one malleable (upper-half s) signature',
            'ERR_006'
        );

        // ════════════════════════════════════════════════════════════════
        // P10: Cross-chain / cross-field signature replay
        // ════════════════════════════════════════════════════════════════
        logPhase(10, 'Cross-chain and cross-field signatures do not verify');

        // Both amounts stay <= lockA's availableAmount (1000) so the signature check is the
        // gate that fails, not the amount validation.
        const signedAmt = ethers.parseEther('400');
        const submittedAmt = ethers.parseEther('500');
        const nonceP10 = await locker.unlockNonce(lockA);
        // (a) signatures produced under a DIFFERENT chainId domain
        const wrongDomain = buildDomain(lockerAddress, chainId + 1);
        const wrongChain = await collectSignatures(
            'Unlock', { lockId: lockA, to: recipient.address, amount: signedAmt, nonce: nonceP10 },
            signers, THRESHOLD, wrongDomain
        );
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockA, recipient.address, signedAmt, wrongChain.addresses, wrongChain.signatures
            ),
            'Unlock with signatures bound to a different chainId',
            'ERR_005: Invalid signature'
        );
        // (b) signatures for amount=400 reused for a 500 withdrawal (field re-binding)
        const boundSigs = await collectSignatures(
            'Unlock', { lockId: lockA, to: recipient.address, amount: signedAmt, nonce: nonceP10 },
            signers, THRESHOLD, domain
        );
        await expectRevert(
            () => locker.connect(executor).executeUnlockWithSignatures(
                lockA, recipient.address, submittedAmt, boundSigs.addresses, boundSigs.signatures
            ),
            'Unlock 500 with signatures that authorized 400',
            'ERR_005: Invalid signature'
        );
        assertEqual((await lockManager.getLock(lockA)).basic.availableAmount, lockAmtP8, 'lockA still intact after P9/P10 attempts');

        // ════════════════════════════════════════════════════════════════
        // P11: Vesting — exceed the signed cap / double-claim within a period
        // ════════════════════════════════════════════════════════════════
        logPhase(11, 'Vesting cap and double-claim protection');

        const tokenP11 = await deployToken(deployer, executor.address);
        const vestLockAmt = ethers.parseEther('10000');
        const perPeriod = ethers.parseEther('100');
        const vestParams = makeLockParams(await tokenP11.getAddress(), vestLockAmt, {
            lockDuration: 365 * 24 * 3600, // not time-unlockable => vesting is the only path
            vestingTokensPerPeriod: perPeriod,
            vestingPeriodSeconds: 24 * 3600,
            vestingAccumulate: true
        });
        const vestLockId = await createLock(locker, lockManager, tokenP11, executor, vestParams);

        await advanceTime(5 * 24 * 3600 + 10); // ~5 periods → 500 vested
        const vested = await vestingManager.calculateVestedAmount(vestLockId);
        assert(vested >= perPeriod * 5n, `~5 periods vested (${ethers.formatEther(vested)})`);

        // Attempt to release with a cap BELOW the vested amount → reverts, clock not consumed
        const lowCap = perPeriod * 3n;
        const vnP11 = await locker.vestingNonce(vestLockId);
        const capSigs = await collectSignatures(
            'VestingUnlock', { lockId: vestLockId, recipient: recipient.address, maxAmountTokens: lowCap, chainId, nonce: vnP11 },
            signers, THRESHOLD, domain
        );
        await expectRevert(
            () => locker.connect(executor).unlockVestedWithSignatures(
                vestLockId, recipient.address, lowCap, capSigs.addresses, capSigs.signatures
            ),
            'Vesting release with a signed cap below the vested amount',
            'Amount exceeds signed cap'
        );

        // Proper release (cap above vested) works once
        const highCap = perPeriod * 100n;
        const capSigs2 = await collectSignatures(
            'VestingUnlock', { lockId: vestLockId, recipient: recipient.address, maxAmountTokens: highCap, chainId, nonce: vnP11 },
            signers, THRESHOLD, domain
        );
        const recvBeforeP11 = await tokenP11.balanceOf(recipient.address);
        await (await locker.connect(executor).unlockVestedWithSignatures(
            vestLockId, recipient.address, highCap, capSigs2.addresses, capSigs2.signatures
        )).wait();
        const released = (await tokenP11.balanceOf(recipient.address)) - recvBeforeP11;
        assert(released >= perPeriod * 5n && released <= vested + perPeriod, `vesting released ~500 (${ethers.formatEther(released)})`);

        // Immediately claim again (same period, no time advance) → nothing vested
        const vnP11b = await locker.vestingNonce(vestLockId);
        const capSigs3 = await collectSignatures(
            'VestingUnlock', { lockId: vestLockId, recipient: recipient.address, maxAmountTokens: highCap, chainId, nonce: vnP11b },
            signers, THRESHOLD, domain
        );
        await expectRevert(
            () => locker.connect(executor).unlockVestedWithSignatures(
                vestLockId, recipient.address, highCap, capSigs3.addresses, capSigs3.signatures
            ),
            'Second vesting claim within the same period',
            'VESTING_NOT_AVAILABLE'
        );

        log(`\n📊 Adversarial checks passed: ${passed}\n`, '\x1b[1m\x1b[32m');
        reportTestResult('60-adversarial-fund-theft', true);
        logSuccess('\n✅ TEST 60 PASSED — no fund-diversion path succeeded!\n');

    } catch (error) {
        reportTestResult('60-adversarial-fund-theft', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST 60 FAILED:\n', error);
        process.exit(1);
    });
