/**
 * Test 06: Token Rescue via Multisig (executeRescueWithSignatures)
 *
 * The contract has no owner role: rescuing tokens accidentally sent to the
 * LockerContract requires the full M-of-N signer threshold (EIP-712 signatures),
 * exactly like unlocks. The opKey binds token, recipient, amount, chainId and
 * the shared rescueNonce so signatures cannot be replayed or redirected.
 *
 * Phases:
 *   1. Deploy a fresh mock token and "accidentally" transfer some to the Locker
 *   2. Build the opKey (cross-checked against getRescueTokenOpKey), collect
 *      threshold signatures, execute the rescue, verify balance + event + nonce
 *   3. Rejection: insufficient signatures (threshold - 1) must revert
 *   4. Rejection: signature from a non-signer wallet must revert
 *   5. Rejection: signatures bound to a different amount (opKey mismatch) must revert
 *   6. Guard: rescue of a token that has active locks must revert ("Lock exists")
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
    PRICE_DIRECTION,
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

async function collectSignatures(message, signerAddresses, count, domain) {
    const signatures = [];
    const addresses = [];
    for (let i = 0; i < count && i < signerAddresses.length; i++) {
        const wallet = await ethers.getSigner(signerAddresses[i]);
        signatures.push(await signLockerOp(wallet, domain, 'RescueToken', message));
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

async function findNonSignerWallet(currentSigners) {
    const all = await ethers.getSigners();
    const lower = currentSigners.map((a) => a.toLowerCase());
    for (const wallet of all) {
        if (!lower.includes(wallet.address.toLowerCase())) return wallet;
    }
    throw new Error('No non-signer wallet available');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    log('\n🧪 TEST 06: TOKEN RESCUE VIA MULTISIG\n', '\x1b[1m\x1b[36m');

    try {
        const state = loadSharedState();

        const deployer = await getWallet(0);
        const recipient = await getWallet(2);

        const locker = await getContract('LockerContract', 0);
        const lockerAddress = await locker.getAddress();
        const domain = await buildDomain(lockerAddress);
        const chainId = Number((await ethers.provider.getNetwork()).chainId);

        // Always read live multisig configuration (earlier tests may change it)
        const signers = await locker.getSigners();
        const threshold = Number(await locker.approvalsThreshold());
        log(`  Signers: ${signers.length}, threshold: ${threshold}`);

        // ════════════════════════════════════════════════════════════════
        // PHASE 1: Deploy a fresh token and send some to the Locker by mistake
        // ════════════════════════════════════════════════════════════════
        logPhase(1, 'Deploy fresh token and "accidentally" send it to the Locker');

        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const token = await ERC20Mock.deploy(
            'Rescue Test Token', 'RSCU', deployer.address, ethers.parseEther('1000000'), 18
        );
        await token.waitForDeployment();
        const tokenAddress = await token.getAddress();
        log(`  Fresh token: ${tokenAddress}`);

        const strandedAmount = ethers.parseEther('1000');
        await (await token.connect(deployer).transfer(lockerAddress, strandedAmount)).wait();

        const lockerTokenBalance = await token.balanceOf(lockerAddress);
        assertEqual(lockerTokenBalance, strandedAmount, 'Locker holds the stranded tokens');
        logSuccess('Fresh token deployed, 1000 RSCU stranded on the Locker');

        // ════════════════════════════════════════════════════════════════
        // PHASE 2: Multisig rescue — happy path
        // ════════════════════════════════════════════════════════════════
        logPhase(2, 'Multisig rescue (threshold signatures) — must succeed');

        const rescueAmount = ethers.parseEther('500');
        const nonceBefore = await locker.rescueNonce();
        log(`  rescueNonce before: ${nonceBefore}`);

        // Build opKey locally (EIP-712 hashStruct) and cross-check against the view helper
        const rescueMessage = {
            token: tokenAddress, to: recipient.address, amount: rescueAmount,
            chainId, nonce: nonceBefore
        };
        const localOpKey = lockerOpKey('RescueToken', rescueMessage);
        const contractOpKey = await locker.getRescueTokenOpKey(
            tokenAddress, recipient.address, rescueAmount
        );
        assertEqual(localOpKey, contractOpKey, 'Local opKey matches getRescueTokenOpKey');

        const { addresses, signatures } =
            await collectSignatures(rescueMessage, signers, threshold, domain);
        log(`  Collected ${signatures.length}/${threshold} signatures`);

        const recipientBefore = await token.balanceOf(recipient.address);

        const executor = await ethers.getSigner(signers[0]);
        const tx = await locker.connect(executor).executeRescueWithSignatures(
            tokenAddress, recipient.address, rescueAmount, addresses, signatures
        );
        const receipt = await tx.wait();

        const recipientAfter = await token.balanceOf(recipient.address);
        assertEqual(recipientAfter - recipientBefore, rescueAmount, 'Recipient received the rescued tokens');

        const rescueEvent = findEvent(receipt, locker.interface, 'ExecutedRescue');
        assert(rescueEvent !== null, 'ExecutedRescue event must be emitted');
        assertEqual(rescueEvent.args.token, tokenAddress, 'Event token');
        assertEqual(rescueEvent.args.to, recipient.address, 'Event recipient');
        assertEqual(rescueEvent.args.amount, rescueAmount, 'Event amount');

        const nonceAfter = await locker.rescueNonce();
        assertEqual(nonceAfter, nonceBefore + 1n, 'rescueNonce incremented');
        logSuccess('Multisig rescue executed, event emitted, nonce incremented');

        // ════════════════════════════════════════════════════════════════
        // PHASE 3: Rejection — insufficient signatures (threshold - 1)
        // ════════════════════════════════════════════════════════════════
        logPhase(3, 'Rejection: insufficient signatures (threshold - 1)');

        const shortAmount = ethers.parseEther('100');
        const shortMessage = {
            token: tokenAddress, to: recipient.address, amount: shortAmount,
            chainId, nonce: await locker.rescueNonce()
        };
        const short = await collectSignatures(shortMessage, signers, threshold - 1, domain);
        log(`  Providing ${short.signatures.length}/${threshold} signatures`);

        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                tokenAddress, recipient.address, shortAmount, short.addresses, short.signatures
            ),
            'Insufficient signatures',
            'Insufficient approvals'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 4: Rejection — signature from a non-signer wallet
        // ════════════════════════════════════════════════════════════════
        logPhase(4, 'Rejection: signature from a non-signer wallet');

        const intruderAmount = ethers.parseEther('150');
        const intruderMessage = {
            token: tokenAddress, to: recipient.address, amount: intruderAmount,
            chainId, nonce: await locker.rescueNonce()
        };
        const nonSigner = await findNonSignerWallet(signers);
        log(`  Non-signer wallet: ${nonSigner.address}`);

        // threshold - 1 valid signatures + 1 signature from the intruder
        const partial = await collectSignatures(intruderMessage, signers, threshold - 1, domain);
        const intruderSig = await signLockerOp(nonSigner, domain, 'RescueToken', intruderMessage);
        const mixedAddresses = [...partial.addresses, nonSigner.address];
        const mixedSignatures = [...partial.signatures, intruderSig];

        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                tokenAddress, recipient.address, intruderAmount, mixedAddresses, mixedSignatures
            ),
            'Non-signer signature'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 5: Rejection — signatures bound to different parameters
        // ════════════════════════════════════════════════════════════════
        logPhase(5, 'Rejection: signatures signed for a different amount (opKey mismatch)');

        const signedAmount = ethers.parseEther('200');
        const submittedAmount = ethers.parseEther('250'); // different → different opKey
        const signedMessage = {
            token: tokenAddress, to: recipient.address, amount: signedAmount,
            chainId, nonce: await locker.rescueNonce()
        };
        const mismatch = await collectSignatures(signedMessage, signers, threshold, domain);
        log(`  Signed for ${ethers.formatEther(signedAmount)}, submitting ${ethers.formatEther(submittedAmount)}`);

        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                tokenAddress, recipient.address, submittedAmount, mismatch.addresses, mismatch.signatures
            ),
            'OpKey-mismatched signatures'
        );

        // No tokens must have left the contract during phases 3-5
        const lockerBalanceAfterRejections = await token.balanceOf(lockerAddress);
        assertEqual(
            lockerBalanceAfterRejections,
            strandedAmount - rescueAmount,
            'Locker balance untouched by rejected attempts'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 6: Guard — token with active locks cannot be rescued
        // ════════════════════════════════════════════════════════════════
        logPhase(6, 'Guard: rescue of a token that has active locks must revert');

        const lockManagerAddress = await locker.lockManager();
        const lockManager = await ethers.getContractAt('LockManager', lockManagerAddress);

        let guardToken = state.contracts.TestToken;
        let guardLocks = await lockManager.getTokenLocks(guardToken);
        log(`  TestToken active locks: ${guardLocks.length}`);

        if (guardLocks.length === 0) {
            // Fall back: create a small lock on the fresh token so the guard can be exercised
            logSection('TestToken has no locks — creating a small lock on the fresh token');
            guardToken = tokenAddress;

            const lockAmount = ethers.parseEther('100');
            await (await token.connect(deployer).approve(lockerAddress, lockAmount)).wait();

            const createLockParams = {
                token: guardToken,
                amount: lockAmount,
                lockDuration: 3600,
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
            await (await locker.connect(deployer).createLock(createLockParams)).wait();

            guardLocks = await lockManager.getTokenLocks(guardToken);
            log(`  Fresh token active locks: ${guardLocks.length}`);
        }

        assert(guardLocks.length > 0, 'Guard token must have at least one active lock');

        const guardAmount = ethers.parseEther('1');
        const guardMessage = {
            token: guardToken, to: recipient.address, amount: guardAmount,
            chainId, nonce: await locker.rescueNonce()
        };
        const guard = await collectSignatures(guardMessage, signers, threshold, domain);

        await expectRevert(
            () => locker.connect(executor).executeRescueWithSignatures(
                guardToken, recipient.address, guardAmount, guard.addresses, guard.signatures
            ),
            'Rescue of locked token',
            'Lock exists for this token'
        );

        reportTestResult('06-lock-rescue', true);
        logSuccess('\n✅ TEST 06 PASSED!\n');

    } catch (error) {
        reportTestResult('06-lock-rescue', false, error.message);
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
