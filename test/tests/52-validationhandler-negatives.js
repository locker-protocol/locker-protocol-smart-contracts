/**
 * Test 52: ValidationHandler — Negative Paths & Exact Revert Reasons
 *
 * Exhaustive negative coverage of the CURRENT (refactored) ValidationHandler:
 * - constructor 'Threshold too low'
 * - onlyLocker on batchApproveWithSignatures → 'Only locker allowed'
 * - onlyLocker on setThreshold / bumpConfigEpoch / markAsExecuted → 'Only locker allowed'
 *   (F2 hardening: the former "locker OR signerManager" surface was removed, so every
 *    non-locker caller — signer EOA, stranger, wired or unwired instance — gets the
 *    same 'Only locker allowed'; the signerManager lookup / catch branches are gone)
 * - ERR_001 / ERR_002 / ERR_004 / ERR_005 via impersonated LockerContract
 * - ERR_003 is OBSOLETE: double approval is now an idempotent silent skip
 * - markAsExecuted 'Not validated' + 'Already executed'
 * - batchApproveWithSignatures 'Array length mismatch'
 * - verifySignatureOnly: 'Not authorized signer' (non-signer) and 'INV_SIG'
 *   (authorized signer, signature over different content)
 * - _isSigner false branches: locker==0, signerManager()==0 (mock), catch (revert)
 * - Neutral getters: hasExecuted, opLastApprovalTime, getCachedChainId,
 *   initialized, DOMAIN_SEPARATOR, configEpoch/hasApproved epoch semantics
 *
 * NOTE: approveOperationFor and cleanExpiredOperation were removed from the
 * contract; their absence from the ABI is asserted below.
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

// Decode a raw Error(string) revert payload when the node did not render the reason
// (e.g. Hardhat "couldn't infer the reason" on some impersonated-sender calls — the
// ABI-encoded reason is still present in the error's nested `data` fields, whose exact
// location differs between the in-process EVM and the JSON-RPC transport).
function findRevertData(obj, depth = 0) {
    if (obj == null || depth > 6) return null;
    if (typeof obj === 'string') {
        const m = obj.match(/0x08c379a0[0-9a-fA-F]+/);
        return m ? m[0] : null;
    }
    if (typeof obj !== 'object') return null;
    for (const key of ['data', 'error', 'info', 'payload', 'body', 'shortMessage', 'message']) {
        try {
            const found = findRevertData(obj[key], depth + 1);
            if (found) return found;
        } catch { /* ignore exotic getters */ }
    }
    return null;
}

function decodeRevertReason(e) {
    const data = findRevertData(e);
    if (data) {
        try {
            return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
        } catch { /* fall through */ }
    }
    return null;
}

// Assert that a promise (tx, view call or deployment) reverts with the EXACT reason substring
async function expectRevert(promiseOrFn, expectedReason, label) {
    try {
        const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
        const res = await p;
        if (res && typeof res.wait === 'function') await res.wait();
        throw new Error(`NO_REVERT:${label}`);
    } catch (e) {
        if (e.message.startsWith('NO_REVERT:')) {
            throw new Error(`${label}: expected revert '${expectedReason}' but call succeeded`);
        }
        const decoded = decodeRevertReason(e);
        assert(
            e.message.includes(expectedReason) || (decoded !== null && decoded.includes(expectedReason)),
            `${label}: expected revert reason '${expectedReason}' but got: ${e.message}` +
            (decoded !== null ? ` (decoded reason: '${decoded}')` : '')
        );
        logSuccess(`${label} → reverted with '${expectedReason}'`);
    }
}

// Each probe opKey is the EIP-712 hashStruct of a distinct real typed op (UpdateThreshold
// with a unique nonce), so signLockerOp produces a signature the ValidationHandler accepts
// (its digest = _hashTypedDataV4(opKey)). The message is stashed so `sign` (below) can
// re-sign the exact struct for a given opKey. The VH treats opKey as opaque bytes32, so the
// chosen op type/fields are irrelevant to what is being asserted.
const _probeMsgByKey = new Map();
function opKeyOf(tag, n) {
    const message = { newThreshold: 3, nonce: BigInt(n) };
    const key = lockerOpKey('UpdateThreshold', message);
    _probeMsgByKey.set(key, message);
    return key;
}

async function main() {
    log('\n🧪 TEST 52: VALIDATIONHANDLER NEGATIVE PATHS\n', '\x1b[1m\x1b[36m');

    try {
        const allSigners = await ethers.getSigners();
        const deployer = allSigners[0];
        const outsider = allSigners[1];

        // Offline wallets: 5 authorized signers + 1 non-signer (sign only, no funds needed)
        const signerWallets = [];
        for (let i = 0; i < 5; i++) {
            signerWallets.push(ethers.Wallet.createRandom());
        }
        const signerAddresses = signerWallets.map(w => w.address);
        const nonSignerWallet = ethers.Wallet.createRandom();

        // ========================================
        // PHASE 1: constructor 'Threshold too low'
        // ========================================
        logPhase(1, "constructor: 'Threshold too low'");

        const VH = await ethers.getContractFactory('ValidationHandler');
        await expectRevert(
            VH.deploy(2),
            'Threshold too low',
            'ValidationHandler.deploy(threshold=2)'
        );
        await expectRevert(
            VH.deploy(0),
            'Threshold too low',
            'ValidationHandler.deploy(threshold=0)'
        );

        // ========================================
        // PHASE 2: Deploy the full wired stack (fresh, isolated from shared state)
        // ========================================
        logPhase(2, 'Deploy wired stack');

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

        const SM = await ethers.getContractFactory('SignerManager');
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
        logSuccess(`Wired stack deployed — LockerContract at ${lockerAddress}`);

        const chainId = Number((await ethers.provider.getNetwork()).chainId);
        const domain = {
            name: 'LockerContract',
            version: '1',
            chainId,
            verifyingContract: lockerAddress
        };
        const sign = (wallet, opKey) => signLockerOp(wallet, domain, 'UpdateThreshold', _probeMsgByKey.get(opKey));

        // ========================================
        // PHASE 3: Neutral getters on the wired instance
        // ========================================
        logPhase(3, 'Neutral getters (wired instance)');

        assert(await vh.initialized() === true, 'initialized must be true after wiring');
        logSuccess('initialized == true');

        assertEqual(await vh.getCachedChainId(), chainId, 'getCachedChainId');

        const expectedDomainSeparator = ethers.TypedDataEncoder.hashDomain(domain);
        assertEqual(await vh.DOMAIN_SEPARATOR(), expectedDomainSeparator, 'DOMAIN_SEPARATOR matches EIP-712 domain hash');

        assertEqual(await vh.configEpoch(), 0n, 'configEpoch starts at 0');
        assertEqual(await vh.approvalsThreshold(), 3n, 'approvalsThreshold');

        // Removed functions must be gone from the ABI
        assert(vh.approveOperationFor === undefined, 'approveOperationFor must not exist (removed)');
        assert(vh.cleanExpiredOperation === undefined, 'cleanExpiredOperation must not exist (removed)');
        logSuccess('Obsolete functions approveOperationFor / cleanExpiredOperation absent from ABI');

        // ========================================
        // PHASE 4: Modifier rejections by strangers (wired instance)
        // ========================================
        logPhase(4, 'Access control rejections (wired instance)');

        const anyKey = opKeyOf('VH52_ANY', 0);
        const outsiderSig = await sign(signerWallets[0], anyKey);

        // onlyLocker on batchApproveWithSignatures
        await expectRevert(
            vh.connect(outsider).batchApproveWithSignatures(anyKey, [signerAddresses[0]], [outsiderSig]),
            'Only locker allowed',
            'batchApproveWithSignatures by non-locker'
        );
        // 'Only locker allowed' comes from the onlyLocker modifier: outsider != locker.
        // Hardening F2: setThreshold / bumpConfigEpoch / markAsExecuted are now onlyLocker
        // (the former "locker OR signerManager" surface was removed), so every non-locker
        // caller — signer EOA or stranger — gets the same 'Only locker allowed'.
        await expectRevert(
            vh.connect(outsider).setThreshold(5),
            'Only locker allowed',
            'setThreshold by stranger (wired)'
        );
        await expectRevert(
            vh.connect(outsider).bumpConfigEpoch(),
            'Only locker allowed',
            'bumpConfigEpoch by stranger (wired)'
        );
        await expectRevert(
            vh.connect(outsider).markAsExecuted(anyKey),
            'Only locker allowed',
            'markAsExecuted by stranger (wired)'
        );

        // ========================================
        // PHASE 5: Signature negatives via impersonated LockerContract
        // ========================================
        logPhase(5, 'ERR_00x paths via impersonated LockerContract');

        await ethers.provider.send('hardhat_impersonateAccount', [lockerAddress]);
        await ethers.provider.send('hardhat_setBalance', [lockerAddress, '0x' + (10n ** 20n).toString(16)]);
        const lockerSigner = await ethers.getSigner(lockerAddress);
        logSuccess(`Impersonating LockerContract ${lockerAddress}`);

        const opKeyPending = opKeyOf('VH52_PENDING', 1);
        const opKeyExec = opKeyOf('VH52_EXEC', 2);

        // --- ERR_001: approval for a non-signer address ---
        const nonSignerSig = await sign(nonSignerWallet, opKeyPending);
        await expectRevert(
            vh.connect(lockerSigner).batchApproveWithSignatures(opKeyPending, [nonSignerWallet.address], [nonSignerSig]),
            'ERR_001: Not authorized signer',
            'ERR_001 non-signer approval'
        );

        // --- ERR_006C: invalid v byte. F5 v-normalization accepts only {0,1,27,28};
        //     v=26 (0x1a) normalizes to 53 and is rejected BEFORE ecrecover. ---
        const badVSig = '0x' + '11'.repeat(32) + '00'.repeat(31) + '01' + '1a'; // r=0x11.., s=1, v=26
        await expectRevert(
            vh.connect(lockerSigner).batchApproveWithSignatures(opKeyPending, [signerAddresses[0]], [badVSig]),
            'ERR_006C',
            'ERR_006C invalid v byte (v=26 rejected by the v-normalization)'
        );

        // --- ERR_004: recovery to address(0) with a VALID v but an unrecoverable (r,s):
        //     r = 0 makes ecrecover return address(0) (still reachable after F5). ---
        const unrecoverableSig = '0x' + '00'.repeat(32) + '00'.repeat(31) + '01' + '1b'; // r=0, s=1, v=27
        await expectRevert(
            vh.connect(lockerSigner).batchApproveWithSignatures(opKeyPending, [signerAddresses[0]], [unrecoverableSig]),
            'ERR_004: Signature recovery failed',
            'ERR_004 unrecoverable signature (r=0 → ecrecover 0)'
        );

        // --- ERR_005: AUTHORIZED signer, but signature over a DIFFERENT opKey ---
        const sigOverOtherKey = await sign(signerWallets[0], opKeyOf('VH52_OTHER', 3));
        await expectRevert(
            vh.connect(lockerSigner).batchApproveWithSignatures(opKeyPending, [signerAddresses[0]], [sigOverOtherKey]),
            'ERR_005: Invalid signature',
            'ERR_005 signature of another message (recovered != signer)'
        );

        // --- 'Array length mismatch' ---
        const sigP0 = await sign(signerWallets[0], opKeyPending);
        await expectRevert(
            vh.connect(lockerSigner).batchApproveWithSignatures(
                opKeyPending,
                [signerAddresses[0], signerAddresses[1]],
                [sigP0]
            ),
            'Array length mismatch',
            'batchApproveWithSignatures arrays of different lengths'
        );

        // --- Register 2/3 approvals on opKeyPending (below threshold) ---
        const sigP1 = await sign(signerWallets[1], opKeyPending);
        await (await vh.connect(lockerSigner).batchApproveWithSignatures(
            opKeyPending, [signerAddresses[0], signerAddresses[1]], [sigP0, sigP1]
        )).wait();
        assertEqual(await vh.approvalsCount(opKeyPending), 2n, 'approvalsCount(pending) == 2');
        assert(await vh.hasApproved(opKeyPending, signerAddresses[0]), 'hasApproved(signer0) must be true');
        assert((await vh.opLastApprovalTime(opKeyPending)) > 0n, 'opLastApprovalTime must be set after approval');
        logSuccess('opLastApprovalTime > 0 after approvals');

        // --- markAsExecuted 'Not validated' (2 approvals < threshold 3) ---
        await expectRevert(
            vh.connect(lockerSigner).markAsExecuted(opKeyPending),
            'Not validated',
            'markAsExecuted below threshold'
        );

        // --- ERR_003 OBSOLETE: double approval is an idempotent silent skip ---
        await (await vh.connect(lockerSigner).batchApproveWithSignatures(
            opKeyPending, [signerAddresses[0]], [sigP0]
        )).wait();
        assertEqual(await vh.approvalsCount(opKeyPending), 2n, 'double approval skipped silently (count unchanged)');
        logSuccess("ERR_003 'Signer already approved' is obsolete — re-approval no longer reverts");

        // --- Full quorum on opKeyExec then markAsExecuted ---
        const execSigs = [];
        for (let i = 0; i < 3; i++) execSigs.push(await sign(signerWallets[i], opKeyExec));
        await (await vh.connect(lockerSigner).batchApproveWithSignatures(
            opKeyExec, signerAddresses.slice(0, 3), execSigs
        )).wait();
        assertEqual(await vh.approvalsCount(opKeyExec), 3n, 'approvalsCount(exec) == 3');

        await (await vh.connect(lockerSigner).markAsExecuted(opKeyExec)).wait();
        assert(await vh.hasExecuted(opKeyExec) === true, 'hasExecuted must be true after execution');
        logSuccess('hasExecuted == true after markAsExecuted');
        assertEqual(await vh.approvalsCount(opKeyExec), 0n, 'operation struct deleted (count reset to 0)');
        assertEqual(await vh.opLastApprovalTime(opKeyExec), 0n, 'opLastApprovalTime reset after execution');

        // --- markAsExecuted 'Already executed' ---
        await expectRevert(
            vh.connect(lockerSigner).markAsExecuted(opKeyExec),
            'Already executed',
            'markAsExecuted replay'
        );

        // --- ERR_002: approving an already executed operation ---
        const sigE0Fresh = await sign(signerWallets[0], opKeyExec);
        await expectRevert(
            vh.connect(lockerSigner).batchApproveWithSignatures(opKeyExec, [signerAddresses[0]], [sigE0Fresh]),
            'ERR_002: Operation already executed',
            'ERR_002 approval of executed op'
        );

        // --- bumpConfigEpoch by the locker invalidates pending approvals ---
        await (await vh.connect(lockerSigner).bumpConfigEpoch()).wait();
        assertEqual(await vh.configEpoch(), 1n, 'configEpoch bumped to 1');
        assertEqual(await vh.approvalsCount(opKeyPending), 0n, 'stale-epoch approvals no longer count');
        assert(!(await vh.hasApproved(opKeyPending, signerAddresses[0])), 'hasApproved false after epoch bump');
        logSuccess('Epoch bump invalidates pending approvals');

        await ethers.provider.send('hardhat_stopImpersonatingAccount', [lockerAddress]);
        logSuccess('Stopped impersonating LockerContract');

        // ========================================
        // PHASE 6: verifySignatureOnly negatives
        // ========================================
        logPhase(6, 'verifySignatureOnly');

        const opKeyV = opKeyOf('VH52_VIEW', 4);

        // Sanity: valid signature from authorized signer passes
        const validSig = await sign(signerWallets[0], opKeyV);
        await vh.verifySignatureOnly(opKeyV, signerAddresses[0], validSig);
        logSuccess('verifySignatureOnly accepts a valid signature (sanity)');

        // INV_SIG: AUTHORIZED signer but signature over another opKey (recovered != signer)
        // (test 18 used a non-signer which tripped isSigner first — this hits the INV_SIG branch)
        const sigWrongContent = await sign(signerWallets[0], opKeyOf('VH52_VIEW_OTHER', 5));
        await expectRevert(
            vh.verifySignatureOnly(opKeyV, signerAddresses[0], sigWrongContent),
            'INV_SIG',
            'verifySignatureOnly authorized signer, wrong content'
        );

        // Non-signer trips the isSigner gate first
        const nonSignerValidSig = await sign(nonSignerWallet, opKeyV);
        await expectRevert(
            vh.verifySignatureOnly(opKeyV, nonSignerWallet.address, nonSignerValidSig),
            'Not authorized signer',
            'verifySignatureOnly non-signer'
        );

        // ========================================
        // PHASE 7: _isSigner false branches on fresh instances
        // ========================================
        logPhase(7, '_isSigner false branches (fresh instances)');

        // 7a. Unwired instance: locker == address(0)
        const vhUnwired = await VH.deploy(3);
        await vhUnwired.waitForDeployment();
        assert(await vhUnwired.initialized() === false, 'fresh instance must not be initialized');
        logSuccess('initialized == false on fresh instance');

        await expectRevert(
            vhUnwired.verifySignatureOnly(opKeyV, signerAddresses[0], validSig),
            'Not authorized signer',
            '_isSigner false branch: locker == address(0)'
        );
        await expectRevert(
            vhUnwired.connect(outsider).setThreshold(5),
            'Only locker allowed',
            'setThreshold on unwired instance (locker == 0)'
        );
        await expectRevert(
            vhUnwired.connect(outsider).bumpConfigEpoch(),
            'Only locker allowed',
            'bumpConfigEpoch on unwired instance (locker == 0)'
        );

        // 7b. Locker without signerManager(): call reverts → catch branch
        const ERC20Mock = await ethers.getContractFactory('ERC20Mock');
        const dummyToken = await ERC20Mock.deploy('Dummy', 'DMY', deployer.address, 1000n, 18);
        await dummyToken.waitForDeployment();

        const vhBadLocker = await VH.deploy(3);
        await vhBadLocker.waitForDeployment();
        await (await vhBadLocker.connect(deployer).setLocker(await dummyToken.getAddress())).wait();
        assert(await vhBadLocker.initialized() === true, 'vhBadLocker must be initialized');

        await expectRevert(
            vhBadLocker.verifySignatureOnly(opKeyV, signerAddresses[0], validSig),
            'Not authorized signer',
            '_isSigner catch branch: locker.signerManager() reverts'
        );
        // F2: setThreshold is onlyLocker now — an outsider is rejected before any
        // signerManager() lookup, so the former 'Manager fetch failed' catch branch is
        // unreachable and every non-locker caller gets 'Only locker allowed'.
        await expectRevert(
            vhBadLocker.connect(outsider).setThreshold(5),
            'Only locker allowed',
            'setThreshold by outsider (locker without signerManager())'
        );

        // 7c. Locker whose signerManager() returns address(0) — mock runtime code
        //     0x60206000f3 = PUSH1 0x20 PUSH1 0x00 RETURN → returns 32 zero bytes for any call
        const mockLockerAddr = ethers.getAddress('0x00000000000000000000000000000000000c0de0');
        await ethers.provider.send('hardhat_setCode', [mockLockerAddr, '0x60206000f3']);

        const vhZeroSM = await VH.deploy(3);
        await vhZeroSM.waitForDeployment();
        await (await vhZeroSM.connect(deployer).setLocker(mockLockerAddr)).wait();

        await expectRevert(
            vhZeroSM.verifySignatureOnly(opKeyV, signerAddresses[0], validSig),
            'Not authorized signer',
            '_isSigner false branch: signerManager() == address(0)'
        );
        await expectRevert(
            vhZeroSM.connect(outsider).setThreshold(5),
            'Only locker allowed',
            'setThreshold by outsider (onlyLocker, signerManager() == 0 is irrelevant now)'
        );

        logSuccess('\n🎉 TEST 52 PASSED: ValidationHandler negative paths fully covered!\n');
        reportTestResult('52-validationhandler-negatives', true);

    } catch (error) {
        reportTestResult('52-validationhandler-negatives', false, error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ TEST FAILED:\n', error);
        process.exit(1);
    });
