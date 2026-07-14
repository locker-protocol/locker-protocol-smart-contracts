/**
 * Test 46: Rescue Replay Protection (shared rescueNonce)
 *
 * Token and native rescues share a single rescueNonce that is baked into every
 * rescue opKey (together with chainId). Executing ANY rescue increments it,
 * which invalidates every signature bound to the previous nonce. This test
 * verifies all the replay surfaces:
 *
 * Phases:
 *   1. Fund the Locker with a fresh mock token (twice), execute a token rescue,
 *      then REPLAY the exact same call with the SAME signatures → must revert
 *      (nonce moved → opKey differs → stale signatures rejected)
 *   2. Build + sign a fresh opKey, execute it, re-submit identical
 *      params/signatures → must revert
 *   3. 24h execution window: pre-register threshold approvals on the
 *      ValidationHandler, advance time by 86401s, then execute → "Op expired"
 *   4. Cross-type nonce sharing: sign a RESCUE_TOKEN op, then execute a
 *      RESCUE_NATIVE op first (funded via ForceSend) so rescueNonce increments;
 *      the token op with old-nonce signatures must then fail
 *
 * The test does not touch the signer set or the approvals threshold.
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
    advanceTime,
    signLockerOp,
    lockerOpKey,
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

// Collect `count` threshold signatures over the typed operation struct (M-1):
// each signer signs the decoded fields, whose hashStruct equals the on-chain opKey.
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

async function expectRevert(callFn, label, expectedSubstring = null) {
    try {
        const tx = await callFn();
        if (tx && tx.wait) await tx.wait();
    } catch (error) {
        const text = revertText(error);
        log(`  Revert: ${text.substring(0, 140)}`);
        if (expectedSubstring) {
            assert(
                text.includes(expectedSubstring),
                `${label}: expected revert containing "${expectedSubstring}", got: ${text.substring(0, 200)}`
            );
        }
        logSuccess(`${label} correctly reverted`);
        return;
    }
    throw new Error(`${label}: expected revert but call succeeded`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 46: RESCUE REPLAY PROTECTION\n', '\x1b[1m\x1b[36m');

    try {
        const deployer = await getWallet(0);
        const recipient = await getWallet(3);

        const locker = await getContract('LockerContract', 0);
        const lockerAddress = await locker.getAddress();
        const validationHandler = await getContract('ValidationHandler', 0);
        const domain = await buildDomain(lockerAddress);
        const chainId = Number((await ethers.provider.getNetwork()).chainId);

        // Live multisig configuration (earlier tests may have changed it)
        const signers = await locker.getSigners();
        const threshold = Number(await locker.approvalsThreshold());
        const executor = await ethers.getSigner(signers[0]);
        log(`  Signers: ${signers.length}, threshold: ${threshold}`);

        // Setup: deploy a fresh token (no locks can exist for it) and fund the
        // Locker twice — the second tranche guarantees a replayed transfer would
        // not fail on balance, only on replay protection.
        logSection('Setup: fund the Locker twice with a fresh mock token');
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const token = await ERC20Mock.deploy(
            'Replay Rescue Token', 'RPLY', deployer.address, ethers.parseEther('1000000'), 18
        );
        await token.waitForDeployment();
        const tokenAddress = await token.getAddress();

        const tranche = ethers.parseEther('500');
        await (await token.connect(deployer).transfer(lockerAddress, tranche)).wait();
        await (await token.connect(deployer).transfer(lockerAddress, tranche)).wait();
        assertEqual(
            await token.balanceOf(lockerAddress),
            tranche * 2n,
            'Locker funded with 1000 RPLY (two tranches)'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 1: Execute a rescue, then replay the identical call + signatures
        // ════════════════════════════════════════════════════════════════
        logPhase(1, 'Execute token rescue, then replay same call with SAME signatures');

        const amount1 = ethers.parseEther('400');
        const nonce1 = await locker.rescueNonce();
        const sigs1 = await collectSignatures(
            'RescueToken',
            { token: tokenAddress, to: recipient.address, amount: amount1, chainId, nonce: nonce1 },
            signers, threshold, domain
        );

        const recipientBefore1 = await token.balanceOf(recipient.address);
        const tx1 = await locker.connect(executor).executeRescueWithSignatures(
            tokenAddress, recipient.address, amount1, sigs1.addresses, sigs1.signatures
        );
        await tx1.wait();

        assertEqual(
            (await token.balanceOf(recipient.address)) - recipientBefore1,
            amount1,
            'First rescue delivered the tokens'
        );
        assertEqual(await locker.rescueNonce(), nonce1 + 1n, 'rescueNonce incremented by execution');

        // Replay: identical params, identical signatures. The contract
        // derives the opKey from the current nonce, so signatures bound to
        // the previous nonce cannot verify against it.
        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                tokenAddress, recipient.address, amount1, sigs1.addresses, sigs1.signatures
            ),
            'Replay of executed rescue'
        );

        assertEqual(await locker.rescueNonce(), nonce1 + 1n, 'rescueNonce unchanged by rejected replay');
        assertEqual(
            (await token.balanceOf(recipient.address)) - recipientBefore1,
            amount1,
            'No extra tokens delivered by the replay attempt'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 2: Build + sign an opKey, execute, re-submit identical payload
        // ════════════════════════════════════════════════════════════════
        logPhase(2, 'Fresh opKey: execute once, re-submit identical params/signatures');

        const amount2 = ethers.parseEther('300');
        const nonce2 = await locker.rescueNonce();

        // Build the opKey locally and cross-check the view helper
        const localOpKey2 = lockerOpKey('RescueToken', {
            token: tokenAddress, to: recipient.address, amount: amount2, chainId, nonce: nonce2
        });
        const opKey2 = await locker.getRescueTokenOpKey(tokenAddress, recipient.address, amount2);
        assertEqual(localOpKey2, opKey2, 'Local opKey matches getRescueTokenOpKey');

        const sigs2 = await collectSignatures(
            'RescueToken',
            { token: tokenAddress, to: recipient.address, amount: amount2, chainId, nonce: nonce2 },
            signers, threshold, domain
        );

        const tx2 = await locker.connect(executor).executeRescueWithSignatures(
            tokenAddress, recipient.address, amount2, sigs2.addresses, sigs2.signatures
        );
        await tx2.wait();
        assertEqual(await locker.rescueNonce(), nonce2 + 1n, 'rescueNonce incremented');
        logSuccess('Second rescue executed');

        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                tokenAddress, recipient.address, amount2, sigs2.addresses, sigs2.signatures
            ),
            'Re-submission of identical payload'
        );

        // (Former PHASE 3 removed: it pre-registered approvals through the external
        //  approve surface — approveOperationWithSignature / cleanExpiredOperation — to
        //  exercise the 24h window. That surface has been removed and
        //  batchApproveWithSignatures is now onlyLocker, so approvals can only ever be
        //  collected inside the atomic execute flow. The pre-register-then-expire path is
        //  therefore unreachable by design and no longer testable.)

        // ════════════════════════════════════════════════════════════════
        // PHASE 4: Cross-type nonce: native rescue invalidates pending token op
        // ════════════════════════════════════════════════════════════════
        logPhase(4, 'Shared nonce across types: native rescue invalidates a signed token op');

        const amount4 = ethers.parseEther('100');
        const nonce4 = await locker.rescueNonce();

        // Sign a RESCUE_TOKEN op at the CURRENT nonce (would be valid right now)
        const tokenOpKey = await locker.getRescueTokenOpKey(tokenAddress, recipient.address, amount4);
        const localTokenOpKey = lockerOpKey('RescueToken', {
            token: tokenAddress, to: recipient.address, amount: amount4, chainId, nonce: nonce4
        });
        assertEqual(localTokenOpKey, tokenOpKey, 'Token opKey bound to current nonce');
        const tokenSigs = await collectSignatures(
            'RescueToken',
            { token: tokenAddress, to: recipient.address, amount: amount4, chainId, nonce: nonce4 },
            signers, threshold, domain
        );
        log('  RESCUE_TOKEN op signed at current nonce (not yet executed)');

        // Fund the Locker with native coin and execute a RESCUE_NATIVE first
        logSection('Executing a RESCUE_NATIVE op first (shared nonce increments)');
        const nativeFund = ethers.parseEther('0.05');
        const nativeAmount = ethers.parseEther('0.02');
        const ForceSend = await ethers.getContractFactory('ForceSend');
        const forceSend = await ForceSend.connect(deployer).deploy();
        await forceSend.waitForDeployment();
        await (await forceSend.connect(deployer).forceSend(lockerAddress, { value: nativeFund })).wait();

        const nativeSigs = await collectSignatures(
            'RescueNative',
            { to: recipient.address, amount: nativeAmount, chainId, nonce: nonce4 },
            signers, threshold, domain
        );

        const txNative = await locker.connect(executor).executeRescueNativeWithSignatures(
            recipient.address, nativeAmount, nativeSigs.addresses, nativeSigs.signatures
        );
        await txNative.wait();
        assertEqual(await locker.rescueNonce(), nonce4 + 1n, 'Native rescue moved the SHARED rescueNonce');

        // The pending token op was signed for nonce N — it must now fail
        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                tokenAddress, recipient.address, amount4, tokenSigs.addresses, tokenSigs.signatures
            ),
            'Token op signed at stale nonce'
        );

        assertEqual(await locker.rescueNonce(), nonce4 + 1n, 'rescueNonce unchanged by stale token op');

        reportTestResult('46-rescue-replay', true);
        logSuccess('\n✅ TEST 46 PASSED!\n');

    } catch (error) {
        reportTestResult('46-rescue-replay', false, error.message);
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
