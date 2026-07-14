/**
 * Test 47: Operations surface removal + onlyLocker gating (cleanup lock-in)
 *
 * Locks in the ValidationHandler cleanup done in this cycle:
 *  - The unused multi-transaction approval surface is GONE from the ABI:
 *      approveOperation, approveOperationWithSignature, approveOperationFor,
 *      cleanExpiredOperation, validateOperation.
 *  - batchApproveWithSignatures is now onlyLocker: no third party can pre-populate
 *    approval state, so the "pre-register-then-let-expire → brick the opKey" vector
 *    is closed.
 *  - The atomic *WithSignatures flow (which calls batchApproveWithSignatures INTERNALLY,
 *    msg.sender == locker) still works for EVERY operation variant.
 *  - verifySignatureOnly (kept — used by createLockWithSignatures) still recovers and
 *    still rejects malleable / wrong-signer signatures.
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
    advanceTime,
    signLockerOp,
    lockerOpKey
} from '../core/utils.js';

const ethers = getEthers();

// secp256k1 order and n/2 for the malleability variant
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

async function main() {
    log('\n🧪 TEST 47: OPERATIONS SURFACE REMOVED + onlyLocker GATING\n', '\x1b[1m\x1b[36m');
    try {
        const [deployer, recipient, outsider] = await ethers.getSigners();
        const chainId = Number((await ethers.provider.getNetwork()).chainId);

        // 5 signer wallets (MIN_SIGNERS=3), threshold 3, + 1 spare to add later
        const signersWallets = [];
        for (let i = 0; i < 6; i++) {
            signersWallets.push(ethers.Wallet.createRandom().connect(ethers.provider));
        }
        for (const w of signersWallets) {
            await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther('1') })).wait();
        }
        const signerWallets = signersWallets.slice(0, 5);
        const signerAddresses = signerWallets.map(w => w.address);
        const spare = signersWallets[5];

        // ---- deploy fresh system (same EOA => tx.origin==deployer, wiring OK) ----
        logSection('Deploying fresh Locker system');
        const pc = await (await ethers.getContractFactory('PriceCalculator')).deploy(ethers.ZeroAddress, []);
        const vh = await (await ethers.getContractFactory('ValidationHandler')).deploy(3);
        const lm = await (await ethers.getContractFactory('LockManager')).deploy(await pc.getAddress());
        const vm = await (await ethers.getContractFactory('VestingManager')).deploy(await lm.getAddress());
        const sm = await (await ethers.getContractFactory('SignerManager')).deploy(await vh.getAddress(), signerAddresses, 3);
        const locker = await (await ethers.getContractFactory('LockerContract')).deploy(
            await vh.getAddress(), await lm.getAddress(), await sm.getAddress(), await vm.getAddress(), signerAddresses, 3
        );
        const lockerAddress = await locker.getAddress();
        const domain = { name: 'LockerContract', version: '1', chainId, verifyingContract: lockerAddress };
        logSuccess(`Locker deployed at ${lockerAddress} (5 signers, threshold 3)`);

        // helper: collect the threshold set of EIP-712 approvals over the typed op struct
        const collect = async (primaryType, message, wallets = signerWallets) => {
            const signatures = [];
            for (const w of wallets) signatures.push(await signLockerOp(w, domain, primaryType, message));
            return { addresses: wallets.map(w => w.address), signatures };
        };

        // ================================================================
        // PHASE 1: Removed functions are absent from the ABI
        // ================================================================
        logPhase(1, 'Removed operation-approval surface is gone from the ABI');
        for (const fn of ['approveOperation', 'approveOperationFor', 'approveOperationWithSignature', 'cleanExpiredOperation', 'validateOperation']) {
            assert(vh[fn] === undefined, `${fn} must NOT exist on ValidationHandler`);
            logSuccess(`ValidationHandler.${fn} removed`);
        }
        // Kept internals/entrypoints must still be present
        assert(typeof vh.batchApproveWithSignatures === 'function', 'batchApproveWithSignatures must still exist');
        assert(typeof vh.verifySignatureOnly === 'function', 'verifySignatureOnly must still exist');
        assert(typeof vh.markAsExecuted === 'function', 'markAsExecuted must still exist');
        logSuccess('batchApproveWithSignatures / verifySignatureOnly / markAsExecuted still present');
        // OperationExpired event removed
        assert(vh.interface.fragments.every(f => f.name !== 'OperationExpired'), 'OperationExpired event must be removed');
        logSuccess('OperationExpired event removed');

        // ================================================================
        // PHASE 2: batchApproveWithSignatures is onlyLocker
        // ================================================================
        logPhase(2, 'batchApproveWithSignatures rejects any non-locker caller');
        // Fund the unlock lock first so we have a real opKey with valid signatures.
        const tokA = await (await ethers.getContractFactory('ERC20Mock')).deploy('A', 'A', signerWallets[0].address, ethers.parseEther('1000'), 18);
        await (await tokA.connect(signerWallets[0]).approve(lockerAddress, ethers.parseEther('1000'))).wait();
        await (await locker.connect(signerWallets[0]).createLock({
            token: await tokA.getAddress(), amount: ethers.parseEther('1000'), lockDuration: 0,
            pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress, targetPriceUSD1e18: 0,
            isEthPair: false, stablecoinPosition: 0, priceDirection: 0,
            vestingTokensPerPeriod: 0, vestingPeriodSeconds: 0, vestingAccumulate: false
        })).wait();
        const unlockKey = await locker.getUnlockOpKey(1n, recipient.address, ethers.parseEther('500'));
        const unlockSigs = await collect('Unlock', {
            lockId: 1n, to: recipient.address, amount: ethers.parseEther('500'),
            nonce: await locker.unlockNonce(1n)
        });
        // Even with a full, VALID set of signatures, an external caller is rejected on ACCESS,
        // not on signature validity — proving the gate, not a bad-sig accident.
        let blocked = false;
        try {
            await vh.connect(deployer).batchApproveWithSignatures(unlockKey, unlockSigs.addresses, unlockSigs.signatures);
        } catch (e) {
            blocked = e.message.includes('Only locker allowed');
        }
        assert(blocked, 'External batchApproveWithSignatures must revert with "Only locker allowed"');
        logSuccess('External batchApproveWithSignatures → "Only locker allowed" (brick vector closed)');
        // And approvals were NOT registered as a side effect
        assertEqual(await vh.approvalsCount(unlockKey), 0n, 'No approvals registered by the blocked external call');

        // ================================================================
        // PHASE 3: EVERY atomic variant still works (internal batchApprove path)
        // ================================================================
        logPhase(3, 'All atomic *WithSignatures variants still succeed');

        // 3a — executeUnlockWithSignatures
        const balU0 = await tokA.balanceOf(recipient.address);
        await (await locker.executeUnlockWithSignatures(1n, recipient.address, ethers.parseEther('500'), unlockSigs.addresses, unlockSigs.signatures)).wait();
        assertEqual((await tokA.balanceOf(recipient.address)) - balU0, ethers.parseEther('500'), '3a unlock released 500 A');

        // 3b — executeRescueWithSignatures (token with no lock)
        const tokC = await (await ethers.getContractFactory('ERC20Mock')).deploy('C', 'C', deployer.address, ethers.parseEther('100'), 18);
        await (await tokC.transfer(lockerAddress, ethers.parseEther('100'))).wait();
        const rescueSigs = await collect('RescueToken', {
            token: await tokC.getAddress(), to: recipient.address, amount: ethers.parseEther('100'),
            chainId, nonce: await locker.rescueNonce()
        });
        const balC0 = await tokC.balanceOf(recipient.address);
        await (await locker.executeRescueWithSignatures(await tokC.getAddress(), recipient.address, ethers.parseEther('100'), rescueSigs.addresses, rescueSigs.signatures)).wait();
        assertEqual((await tokC.balanceOf(recipient.address)) - balC0, ethers.parseEther('100'), '3b token rescue moved 100 C');

        // 3c — executeRescueNativeWithSignatures (force-sent native)
        const forceSend = await (await ethers.getContractFactory('ForceSend')).deploy();
        await (await forceSend.forceSend(lockerAddress, { value: ethers.parseEther('0.5') })).wait();
        const nativeSigs = await collect('RescueNative', {
            to: recipient.address, amount: ethers.parseEther('0.5'),
            chainId, nonce: await locker.rescueNonce()
        });
        const natBal0 = await ethers.provider.getBalance(recipient.address);
        await (await locker.executeRescueNativeWithSignatures(recipient.address, ethers.parseEther('0.5'), nativeSigs.addresses, nativeSigs.signatures)).wait();
        assertEqual((await ethers.provider.getBalance(recipient.address)) - natBal0, ethers.parseEther('0.5'), '3c native rescue moved 0.5 ETH');

        // 3d — unlockVestedWithSignatures (time-locked, no price pair → priceOk false)
        const tokB = await (await ethers.getContractFactory('ERC20Mock')).deploy('B', 'B', signerWallets[0].address, ethers.parseEther('500'), 18);
        await (await tokB.connect(signerWallets[0]).approve(lockerAddress, ethers.parseEther('500'))).wait();
        await (await locker.connect(signerWallets[0]).createLock({
            token: await tokB.getAddress(), amount: ethers.parseEther('500'), lockDuration: 365 * 24 * 3600,
            pair: ethers.ZeroAddress, ethUsdPair: ethers.ZeroAddress, targetPriceUSD1e18: 0,
            isEthPair: false, stablecoinPosition: 0, priceDirection: 0,
            vestingTokensPerPeriod: ethers.parseEther('100'), vestingPeriodSeconds: 3600, vestingAccumulate: false
        })).wait();
        const vLock = 2n;
        await advanceTime(3600);
        const vestSigs = await collect('VestingUnlock', {
            lockId: vLock, recipient: recipient.address, maxAmountTokens: ethers.parseEther('100'),
            chainId, nonce: await locker.vestingNonce(vLock)
        });
        const balB0 = await tokB.balanceOf(recipient.address);
        await (await locker.unlockVestedWithSignatures(vLock, recipient.address, ethers.parseEther('100'), vestSigs.addresses, vestSigs.signatures)).wait();
        assertEqual((await tokB.balanceOf(recipient.address)) - balB0, ethers.parseEther('100'), '3d vesting released 100 B');

        // 3e — updateThresholdWithSignatures (3 → 4)
        const thrSigs = await collect('UpdateThreshold', { newThreshold: 4, nonce: await locker.thresholdNonce() });
        await (await locker.updateThresholdWithSignatures(4, thrSigs.addresses, thrSigs.signatures)).wait();
        assertEqual(await locker.approvalsThreshold(), 4n, '3e threshold updated to 4');

        // 3f — batchUpdateSignersWithSignatures (add the spare signer; now needs 4 sigs)
        const rm = [];
        const add = [spare.address];
        const batchSigs = await collect('BatchUpdateSigners', {
            signersToRemove: rm, signersToAdd: add, nonce: await locker.batchUpdateSignersNonce()
        }); // all 5 sign; threshold 4 satisfied
        const before = (await locker.getSigners()).length;
        await (await locker.batchUpdateSignersWithSignatures(rm, add, batchSigs.addresses, batchSigs.signatures)).wait();
        assertEqual((await locker.getSigners()).length, before + 1, '3f batch update added a signer');
        assert(await locker.isSigner(spare.address), 'spare signer is now registered');

        // ================================================================
        // PHASE 4: verifySignatureOnly (kept) accepts valid, rejects tampered
        // ================================================================
        logPhase(4, 'verifySignatureOnly still recovers and rejects malleable / wrong-signer');
        // Probe over a real typed op (its hashStruct is the opKey the contract binds).
        const probeMsg = { newThreshold: 3, nonce: 1n };
        const probeKey = lockerOpKey('UpdateThreshold', probeMsg);
        const goodSig = await signLockerOp(signerWallets[0], domain, 'UpdateThreshold', probeMsg);
        // valid → no revert (view call)
        await vh.verifySignatureOnly(probeKey, signerWallets[0].address, goodSig);
        logSuccess('verifySignatureOnly accepts a valid signature');
        // malleable (upper-half s) → ERR_006
        const s = BigInt('0x' + goodSig.substring(66, 130));
        const flippedS = (N - s).toString(16).padStart(64, '0');
        const vByte = parseInt(goodSig.substring(130, 132), 16);
        const flippedV = (vByte === 27 ? 28 : 27).toString(16).padStart(2, '0');
        const malleable = goodSig.substring(0, 66) + flippedS + flippedV;
        let mall = false;
        try { await vh.verifySignatureOnly(probeKey, signerWallets[0].address, malleable); }
        catch (e) { mall = e.message.includes('ERR_006'); }
        assert(mall, 'malleable signature must be rejected with ERR_006');
        logSuccess('verifySignatureOnly rejects a malleable (upper-half s) signature: ERR_006');
        // wrong signer (valid sig, but not a registered signer) → "Not authorized signer"
        let wrong = false;
        const strangerSig = await signLockerOp(ethers.Wallet.createRandom(), domain, 'UpdateThreshold', probeMsg);
        try { await vh.verifySignatureOnly(probeKey, outsider.address, strangerSig); }
        catch (e) { wrong = e.message.includes('Not authorized signer') || e.message.includes('INV_SIG'); }
        assert(wrong, 'non-signer must be rejected');
        logSuccess('verifySignatureOnly rejects a non-signer');

        logSuccess('\n🎉 TEST 47 PASSED: cleanup locked in — surface removed, gating enforced, all atomic variants OK\n');
        reportTestResult('47-operations-surface-removed', true);
    } catch (error) {
        reportTestResult('47-operations-surface-removed', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => { console.error('\n❌ TEST FAILED:\n', error); process.exit(1); });
