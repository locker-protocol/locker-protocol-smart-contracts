/**
 * Test 64: Permissionless top-up boundary (audit A3 / C1 / C2)
 *
 * `addToLock` is deliberately permissionless for an EXPLICIT amount (the payment/escrow use
 * case): anyone can add funds to any lock. The `amount == 0` "auto-detect from balance" path,
 * however, reclassifies stray contract balance as locked and is therefore restricted to
 * signers. This test pins both halves of that boundary, plus the O(1) closure (C1: history is
 * retained after a lock is emptied, so a permissionless top-up can never weaponise an
 * unbounded history wipe).
 *
 *   1. A non-signer, non-creator third party tops up someone else's lock (amount > 0) → OK.
 *   2. The same third party calling the amount == 0 path → reverts NotSigner.
 *   3. A signer can use amount == 0 to absorb stray balance into the (single) lock.
 *   4. After a full unlock the lock record is cleared but its history is retained (C1).
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
import { expectRevert, collectSignatures } from '../core/regression-helpers.js';

const ethers = getEthers();

function makeParams(token, amount) {
    return {
        token, amount, lockDuration: 0,
        pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress, targetPriceUSD1e18: 0,
        isEthPair: false, stablecoinPosition: 2, priceDirection: 0,
        vestingTokensPerPeriod: 0, vestingPeriodSeconds: 0, vestingAccumulate: false
    };
}

async function main() {
    log('\n🧪 TEST 64: PERMISSIONLESS TOP-UP BOUNDARY\n', '\x1b[1m\x1b[36m');

    try {
        loadSharedState();
        const locker = await getContract('LockerContract', 0);
        const lockManager = await getContract('LockManager', 0);
        const lockerAddress = await locker.getAddress();

        const executor = await getWallet(0);   // signer + creator
        const thirdParty = await getWallet(7);  // NOT a signer, NOT the creator
        const recipient = await getWallet(8);
        const signers = await locker.getSigners();
        const threshold = Number(await locker.approvalsThreshold());
        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        const domain = lockerDomain(lockerAddress, chainId);

        // Sanity: the third party is genuinely unprivileged.
        assert((await locker.isSigner(thirdParty.address)) === false, 'third party is not a signer');

        logSection('Deploy a plain token and create a single lock');
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock', executor);
        const token = await ERC20Mock.deploy('Topup Token', 'TOP', executor.address, ethers.parseEther('1000000'), 18);
        await token.waitForDeployment();
        const tokenAddr = await token.getAddress();

        const base = ethers.parseEther('1000');
        await (await token.connect(executor).approve(lockerAddress, base)).wait();
        const lockId = await lockManager.nextLockId();
        await (await locker.connect(executor).createLock(makeParams(tokenAddr, base))).wait();
        assertEqual((await lockManager.getLock(lockId)).basic.availableAmount, base, 'lock created with 1000');

        // ── (1) Permissionless explicit top-up by a third party ──────────────
        logPhase(1, 'A non-signer third party tops up someone else\'s lock (amount > 0)');
        const topUp = ethers.parseEther('500');
        await (await token.connect(executor).transfer(thirdParty.address, topUp)).wait();
        await (await token.connect(thirdParty).approve(lockerAddress, topUp)).wait();
        await (await locker.connect(thirdParty).addToLock(lockId, topUp, ethers.ZeroHash)).wait();
        assertEqual((await lockManager.getLock(lockId)).basic.availableAmount, base + topUp,
            'availableAmount increased by the third party top-up');
        assert(Number(await lockManager.getLockHistoryCount(lockId)) >= 1, 'top-up recorded in history');

        // ── (2) The amount == 0 auto-detect path is signer-only ──────────────
        logPhase(2, 'The amount == 0 auto-detect path is refused to a non-signer');
        // Some Hardhat/ethers combos decode the custom error name, others only surface its
        // 4-byte selector — accept either.
        const notSignerSelector = ethers.id('NotSigner()').slice(0, 10);
        await expectRevert(
            () => locker.connect(thirdParty).addToLock(lockId, 0, ethers.ZeroHash),
            'Third party calling addToLock(amount == 0)',
            ['NotSigner', notSignerSelector]
        );

        // ── (3) A signer can absorb stray balance via amount == 0 ────────────
        logPhase(3, 'A signer absorbs stray balance into the single lock via amount == 0');
        const stray = ethers.parseEther('250');
        await (await token.connect(executor).transfer(lockerAddress, stray)).wait(); // stray, unaccounted
        const availBefore = (await lockManager.getLock(lockId)).basic.availableAmount;
        await (await locker.connect(executor).addToLock(lockId, 0, ethers.ZeroHash)).wait();
        assertEqual((await lockManager.getLock(lockId)).basic.availableAmount, availBefore + stray,
            'signer auto-detect absorbed the stray balance');

        // ── (4) Full unlock clears the record but retains history (C1) ───────
        logPhase(4, 'Full unlock clears the lock record but retains its history (O(1) closure)');
        const total = (await lockManager.getLock(lockId)).basic.availableAmount;
        const nonce = await locker.unlockNonce(lockId);
        const sigs = await collectSignatures(
            'Unlock', { lockId, to: recipient.address, amount: total, nonce },
            signers, threshold, domain
        );
        await (await locker.connect(executor).executeUnlockWithSignatures(
            lockId, recipient.address, total, sigs.addresses, sigs.signatures
        )).wait();
        assertEqual((await lockManager.getLock(lockId)).basic.token, ethers.ZeroAddress, 'lock record cleared');
        assert(Number(await lockManager.getLockHistoryCount(lockId)) >= 1, 'history retained after closure (C1)');

        log('\n📊 Permissionless top-up boundary regression passed\n', '\x1b[1m\x1b[32m');
        reportTestResult('64-permissionless-topup', true);
        logSuccess('\n✅ TEST 64 PASSED — explicit top-up permissionless, amount==0 signer-only\n');
    } catch (error) {
        reportTestResult('64-permissionless-topup', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST 64 FAILED:\n', error);
        process.exit(1);
    });
