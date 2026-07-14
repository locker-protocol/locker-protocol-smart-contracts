/**
 * Test 45: Native Coin Rescue via Multisig (executeRescueNativeWithSignatures)
 *
 * The LockerContract has NO receive/fallback function, so native coin can only
 * land on it by force (selfdestruct). This test force-feeds ETH to the Locker
 * via the ForceSend mock, then verifies that the multisig native rescue path
 * works and that all its guards hold.
 *
 * Phases:
 *   1. Locker native balance starts at 0; ForceSend 0.5 ETH; verify balance
 *   2. Multisig native rescue of 0.3 ETH — verify recipient delta,
 *      ExecutedRescueNative event and rescueNonce increment
 *   3. Rejection: insufficient signatures (threshold - 1)
 *   4. Rejection: signature from a non-signer wallet
 *   5. Rejection: amount greater than contract balance ("Insufficient native balance")
 *   6. Rejection: zero recipient ("Invalid amount or recipient")
 */

import {
    getContract,
    getWallet,
    logPhase,
    logSuccess,
    log,
    assert,
    assertEqual,
    reportTestResult,
    getEthers,
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
    log('\n🧪 TEST 45: NATIVE COIN RESCUE VIA MULTISIG\n', '\x1b[1m\x1b[36m');

    try {
        const funder = await getWallet(0);
        const recipient = await getWallet(6);

        const locker = await getContract('LockerContract', 0);
        const lockerAddress = await locker.getAddress();
        const domain = await buildDomain(lockerAddress);
        const chainId = Number((await ethers.provider.getNetwork()).chainId);

        // Live multisig configuration (earlier tests may have changed it)
        const signers = await locker.getSigners();
        const threshold = Number(await locker.approvalsThreshold());
        const executor = await ethers.getSigner(signers[0]);
        log(`  Signers: ${signers.length}, threshold: ${threshold}`);

        // ════════════════════════════════════════════════════════════════
        // PHASE 1: Force-feed native coin to the Locker (it has no receive())
        // ════════════════════════════════════════════════════════════════
        logPhase(1, 'Force-send 0.5 ETH to the Locker via ForceSend (selfdestruct)');

        const balanceBefore = await ethers.provider.getBalance(lockerAddress);
        log(`  Locker native balance before: ${ethers.formatEther(balanceBefore)} ETH`);
        assertEqual(balanceBefore, 0n, 'Locker starts with zero native balance');

        const fundAmount = ethers.parseEther('0.5');
        const ForceSend = await ethers.getContractFactory('ForceSend');
        const forceSend = await ForceSend.connect(funder).deploy();
        await forceSend.waitForDeployment();

        await (await forceSend.connect(funder).forceSend(lockerAddress, { value: fundAmount })).wait();

        const balanceAfterFunding = await ethers.provider.getBalance(lockerAddress);
        assertEqual(balanceAfterFunding, fundAmount, 'Locker received the force-sent ETH');
        logSuccess('0.5 ETH force-sent to the Locker');

        // ════════════════════════════════════════════════════════════════
        // PHASE 2: Multisig native rescue — happy path
        // ════════════════════════════════════════════════════════════════
        logPhase(2, 'Multisig native rescue of 0.3 ETH — must succeed');

        const rescueAmount = ethers.parseEther('0.3');
        const nonceBefore = await locker.rescueNonce();
        log(`  rescueNonce before: ${nonceBefore}`);

        // Build the RescueNative message and cross-check its hashStruct opKey
        // against the contract view helper.
        const message = { to: recipient.address, amount: rescueAmount, chainId, nonce: nonceBefore };
        const localOpKey = lockerOpKey('RescueNative', message);
        const contractOpKey = await locker.getRescueNativeOpKey(recipient.address, rescueAmount);
        assertEqual(localOpKey, contractOpKey, 'Local opKey matches getRescueNativeOpKey');

        const { addresses, signatures } =
            await collectSignatures(signers, threshold, domain, 'RescueNative', message);
        log(`  Collected ${signatures.length}/${threshold} signatures`);

        // Recipient does not send the tx, so its balance delta is exact
        const recipientBefore = await ethers.provider.getBalance(recipient.address);

        const tx = await locker.connect(executor).executeRescueNativeWithSignatures(
            recipient.address, rescueAmount, addresses, signatures
        );
        const receipt = await tx.wait();

        const recipientAfter = await ethers.provider.getBalance(recipient.address);
        assertEqual(recipientAfter - recipientBefore, rescueAmount, 'Recipient received the rescued ETH');

        const lockerBalanceAfterRescue = await ethers.provider.getBalance(lockerAddress);
        assertEqual(lockerBalanceAfterRescue, fundAmount - rescueAmount, 'Locker native balance reduced');

        const rescueEvent = findEvent(receipt, locker.interface, 'ExecutedRescueNative');
        assert(rescueEvent !== null, 'ExecutedRescueNative event must be emitted');
        assertEqual(rescueEvent.args.to, recipient.address, 'Event recipient');
        assertEqual(rescueEvent.args.amount, rescueAmount, 'Event amount');

        const nonceAfter = await locker.rescueNonce();
        assertEqual(nonceAfter, nonceBefore + 1n, 'rescueNonce incremented');
        logSuccess('Native rescue executed, event emitted, nonce incremented');

        // ════════════════════════════════════════════════════════════════
        // PHASE 3: Rejection — insufficient signatures (threshold - 1)
        // ════════════════════════════════════════════════════════════════
        logPhase(3, 'Rejection: insufficient signatures (threshold - 1)');

        const shortAmount = ethers.parseEther('0.05');
        const shortNonce = await locker.rescueNonce();
        const shortMessage = { to: recipient.address, amount: shortAmount, chainId, nonce: shortNonce };
        const short = await collectSignatures(signers, threshold - 1, domain, 'RescueNative', shortMessage);
        log(`  Providing ${short.signatures.length}/${threshold} signatures`);

        await expectRevert(
            () => locker.connect(executor).executeRescueNativeWithSignatures(
                recipient.address, shortAmount, short.addresses, short.signatures
            ),
            'Insufficient signatures',
            'Insufficient approvals'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 4: Rejection — signature from a non-signer wallet
        // ════════════════════════════════════════════════════════════════
        logPhase(4, 'Rejection: signature from a non-signer wallet');

        const intruderAmount = ethers.parseEther('0.07');
        const intruderNonce = await locker.rescueNonce();
        const intruderMessage = { to: recipient.address, amount: intruderAmount, chainId, nonce: intruderNonce };
        const nonSigner = await findNonSignerWallet(signers);
        log(`  Non-signer wallet: ${nonSigner.address}`);

        // threshold - 1 valid signatures + 1 signature from the intruder
        const partial = await collectSignatures(signers, threshold - 1, domain, 'RescueNative', intruderMessage);
        const intruderSig = await signLockerOp(nonSigner, domain, 'RescueNative', intruderMessage);
        const mixedAddresses = [...partial.addresses, nonSigner.address];
        const mixedSignatures = [...partial.signatures, intruderSig];

        await expectRevert(
            () => locker.connect(executor).executeRescueNativeWithSignatures(
                recipient.address, intruderAmount, mixedAddresses, mixedSignatures
            ),
            'Non-signer signature'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 5: Rejection — amount greater than contract balance
        // ════════════════════════════════════════════════════════════════
        logPhase(5, 'Rejection: rescue amount exceeds Locker native balance');

        const currentBalance = await ethers.provider.getBalance(lockerAddress);
        const excessiveAmount = currentBalance + ethers.parseEther('10');
        log(`  Locker balance: ${ethers.formatEther(currentBalance)} ETH, requesting ${ethers.formatEther(excessiveAmount)} ETH`);

        const excessiveNonce = await locker.rescueNonce();
        const excessiveMessage = { to: recipient.address, amount: excessiveAmount, chainId, nonce: excessiveNonce };
        const excessive = await collectSignatures(signers, threshold, domain, 'RescueNative', excessiveMessage);

        await expectRevert(
            () => locker.connect(executor).executeRescueNativeWithSignatures(
                recipient.address, excessiveAmount, excessive.addresses, excessive.signatures
            ),
            'Over-balance rescue',
            'Insufficient native balance'
        );

        // ════════════════════════════════════════════════════════════════
        // PHASE 6: Rejection — zero recipient
        // ════════════════════════════════════════════════════════════════
        logPhase(6, 'Rejection: zero recipient address');

        const zeroAmount = ethers.parseEther('0.01');
        const zeroNonce = await locker.rescueNonce();
        const zeroMessage = { to: ethers.ZeroAddress, amount: zeroAmount, chainId, nonce: zeroNonce };
        const zero = await collectSignatures(signers, threshold, domain, 'RescueNative', zeroMessage);

        await expectRevert(
            () => locker.connect(executor).executeRescueNativeWithSignatures(
                ethers.ZeroAddress, zeroAmount, zero.addresses, zero.signatures
            ),
            'Zero-recipient rescue',
            'Invalid amount or recipient'
        );

        // Nonce must not have moved during any of the rejected attempts
        const nonceFinal = await locker.rescueNonce();
        assertEqual(nonceFinal, nonceAfter, 'rescueNonce unchanged by rejected attempts');

        reportTestResult('45-rescue-native', true);
        logSuccess('\n✅ TEST 45 PASSED!\n');

    } catch (error) {
        reportTestResult('45-rescue-native', false, error.message);
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
