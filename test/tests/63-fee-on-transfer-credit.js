/**
 * Test 63: Fee-on-transfer credit accounting (audit A2 / M-1)
 *
 * The M-1 fix credits the ACTUAL received amount (balance delta), not the requested amount,
 * on every deposit path. The existing suite only covers the 100%-fee revert ("No tokens
 * received"). This test covers the substantive case: a PARTIAL fee-on-transfer token must be
 * recorded at what actually arrived, so sibling locks of the same token can never over-account.
 *
 *   1. createLock a deflationary token (10% transit fee) → availableAmount == received (90%),
 *      NOT the requested amount.
 *   2. A permissionless top-up of the same token is likewise credited at the received amount.
 *   3. An M-of-N unlock of the full recorded balance succeeds (the contract holds exactly it).
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
    lockerDomain,
    getEthers
} from '../core/utils.js';
import { collectSignatures } from '../core/regression-helpers.js';

const ethers = getEthers();

// makeParams for a plain time-unlockable lock (no price pair, immediately unlockable).
function makeParams(token, amount) {
    return {
        token, amount, lockDuration: 0,
        pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress, targetPriceUSD1e18: 0,
        isEthPair: false, stablecoinPosition: 2, priceDirection: 0,
        vestingTokensPerPeriod: 0, vestingPeriodSeconds: 0, vestingAccumulate: false
    };
}

async function main() {
    log('\n🧪 TEST 63: FEE-ON-TRANSFER CREDIT ACCOUNTING\n', '\x1b[1m\x1b[36m');

    try {
        loadSharedState();
        const locker = await getContract('LockerContract', 0);
        const lockManager = await getContract('LockManager', 0);
        const lockerAddress = await locker.getAddress();

        const executor = await getWallet(0);   // signer (onlySigner createLock)
        const recipient = await getWallet(8);
        const signers = await locker.getSigners();
        const threshold = Number(await locker.approvalsThreshold());
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        const domain = lockerDomain(lockerAddress, chainId);

        // ── Deploy a 10%-fee deflationary token, held by the creator ──────────
        logSection('Deploy a 10% fee-on-transfer token');
        const FeeToken = await ethers.getContractFactory('ERC20FeeMock', executor);
        const feeToken = await FeeToken.deploy('Fee Token', 'FEE', executor.address, ethers.parseEther('1000000'));
        await feeToken.waitForDeployment();
        await (await feeToken.setReceiveFeeBps(1000)).wait(); // 10% burned in transit
        const feeAddr = await feeToken.getAddress();

        // ── createLock credits the RECEIVED amount, not the requested amount ──
        logPhase(1, 'createLock records the actual received amount (90%)');
        const requested = ethers.parseEther('10000');
        const expectedReceived = requested * 9000n / 10000n; // 10% fee → 9000 received
        await (await feeToken.connect(executor).approve(lockerAddress, requested)).wait();
        const lockId = await lockManager.nextLockId();
        await (await locker.connect(executor).createLock(makeParams(feeAddr, requested))).wait();

        const lockAfterCreate = await lockManager.getLock(lockId);
        assertEqual(lockAfterCreate.basic.availableAmount, expectedReceived,
            'availableAmount == received (90%), not the requested amount');
        assertEqual(await feeToken.balanceOf(lockerAddress), expectedReceived,
            'contract balance matches the recorded amount exactly');

        // ── A top-up of the same token is also credited at the received amount ─
        // (The permissionless third-party top-up property is covered by test 64 with a
        //  plain token; here the focus is purely the fee-adjusted CREDIT accounting.)
        logPhase(2, 'Top-up credited at the received amount');
        const topReq = ethers.parseEther('2000');
        const topReceived = topReq * 9000n / 10000n; // 1800
        await (await feeToken.connect(executor).approve(lockerAddress, topReq)).wait();
        await (await locker.connect(executor).addToLock(lockId, topReq, ethers.ZeroHash)).wait();

        const expectedTotal = expectedReceived + topReceived;
        assertEqual((await lockManager.getLock(lockId)).basic.availableAmount, expectedTotal,
            'availableAmount reflects both received amounts (no over-accounting)');
        assertEqual(await feeToken.balanceOf(lockerAddress), expectedTotal,
            'contract balance still matches recorded amount exactly');

        // ── M-of-N unlock of the full recorded balance succeeds ──────────────
        logPhase(3, 'M-of-N unlock of the full recorded balance succeeds');
        const nonce = await locker.unlockNonce(lockId);
        const sigs = await collectSignatures(
            'Unlock', { lockId, to: recipient.address, amount: expectedTotal, nonce },
            signers, threshold, domain
        );
        await (await locker.connect(executor).executeUnlockWithSignatures(
            lockId, recipient.address, expectedTotal, sigs.addresses, sigs.signatures
        )).wait();
        // Recipient nets expectedTotal minus the 10% out-transfer fee; the lock is emptied.
        assertEqual((await lockManager.getLock(lockId)).basic.availableAmount, 0n, 'lock fully drained');
        assert((await feeToken.balanceOf(recipient.address)) > 0n, 'recipient received the (net-of-fee) tokens');

        log('\n📊 Fee-on-transfer credit regression passed\n', '\x1b[1m\x1b[32m');
        reportTestResult('63-fee-on-transfer-credit', true);
        logSuccess('\n✅ TEST 63 PASSED — deposits credit the real received amount\n');
    } catch (error) {
        reportTestResult('63-fee-on-transfer-credit', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST 63 FAILED:\n', error);
        process.exit(1);
    });
