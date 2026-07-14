// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ValidationHandler.sol";
import "./LockManager.sol";
import "./SignerManager.sol";
import "./LockerSignerOperations.sol";
import "./LockerLockOperations.sol";
import "./LockerInternal.sol";
import "./LockerContractStructs.sol";
import "./VestingManager.sol";

/**
 * @title Locker Protocol — LockerContract
 * @notice Central orchestrator and entry point for the Locker Protocol vault infrastructure.
 * @dev Delegates storage management to LockManager/SignerManager and signature checking to ValidationHandler.
 * @custom:website https://lockerprotocol.com
 */
contract LockerContract is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Error thrown when caller is not an authorized signer.
    error NotSigner();

    /// @notice Reference to the ValidationHandler engine contract.
    ValidationHandler public validationHandler;
    /// @notice Reference to the LockManager contract.
    LockManager public lockManager;
    /// @notice Reference to the SignerManager contract.
    SignerManager public signerManager;
    /// @notice Reference to the VestingManager contract.
    VestingManager public vestingManager;

    /// @notice Per-lockId nonce tracking for unlock operations to prevent replays.
    mapping(uint256 => uint256) public unlockNonce;
    /// @notice Per-lockId nonce tracking for vesting releases, kept separate from unlockNonce
    /// so that a vesting release cannot invalidate prepared multi-sig unlock signatures
    /// (and vice-versa).
    mapping(uint256 => uint256) public vestingNonce;
    /// @notice Global nonce tracking for createLockWithSignatures operations.
    uint256 public createLockNonce;

    /// @notice Replay protection nonces for administrative multi-sig operations.
    uint256 public batchUpdateSignersNonce;
    uint256 public thresholdNonce;
    /// @notice Replay protection nonce shared by token and native rescue operations.
    uint256 public rescueNonce;

    // ─── EIP-712 operation type hashes ───────────────────────────────────────
    // Each opKey is the hashStruct of one of these typed operations, so signers approve
    // human-readable fields in their wallet (not an opaque hash) and the wallet recomputes
    // the identical hash. Field order here MUST match the abi.encode(...) order below.
    /// @dev keccak256("RescueToken(address token,address to,uint256 amount,uint256 chainId,uint256 nonce)")
    bytes32 private constant RESCUE_TOKEN_TYPEHASH =
        keccak256("RescueToken(address token,address to,uint256 amount,uint256 chainId,uint256 nonce)");
    /// @dev keccak256("RescueNative(address to,uint256 amount,uint256 chainId,uint256 nonce)")
    bytes32 private constant RESCUE_NATIVE_TYPEHASH =
        keccak256("RescueNative(address to,uint256 amount,uint256 chainId,uint256 nonce)");
    /// @dev keccak256("VestingUnlock(uint256 lockId,address recipient,uint256 maxAmountTokens,uint256 chainId,uint256 nonce)")
    bytes32 private constant VESTING_UNLOCK_TYPEHASH =
        keccak256("VestingUnlock(uint256 lockId,address recipient,uint256 maxAmountTokens,uint256 chainId,uint256 nonce)");
    /// @dev keccak256("BatchUpdateSigners(address[] signersToRemove,address[] signersToAdd,uint256 nonce)")
    bytes32 private constant BATCH_UPDATE_SIGNERS_TYPEHASH =
        keccak256("BatchUpdateSigners(address[] signersToRemove,address[] signersToAdd,uint256 nonce)");
    /// @dev keccak256("CreateLock(address token,uint256 amount,uint256 lockDuration,address pair,address ethUsdPair,uint256 targetPriceUSD1e18,bool isEthPair,uint8 stablecoinPosition,uint8 priceDirection,uint256 vestingTokensPerPeriod,uint256 vestingPeriodSeconds,bool vestingAccumulate,uint256 nonce,address signer)")
    bytes32 private constant CREATE_LOCK_TYPEHASH =
        keccak256("CreateLock(address token,uint256 amount,uint256 lockDuration,address pair,address ethUsdPair,uint256 targetPriceUSD1e18,bool isEthPair,uint8 stablecoinPosition,uint8 priceDirection,uint256 vestingTokensPerPeriod,uint256 vestingPeriodSeconds,bool vestingAccumulate,uint256 nonce,address signer)");

    /// @notice Emitted when tokens are unlocked.
    event ExecutedUnlock(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    /// @notice Emitted when an operation key is approved.
    event OperationApproved(bytes32 indexed opKey);
    /// @notice Emitted when emergency token rescue is executed.
    event ExecutedRescue(address indexed token, address indexed to, uint256 amount);
    /// @notice Emitted when emergency native coin rescue is executed.
    event ExecutedRescueNative(address indexed to, uint256 amount);
    /// @notice Emitted when a new signer is added.
    event SignerAdded(address indexed signer);
    /// @notice Emitted when a signer is removed.
    event SignerRemoved(address indexed signer);

    /// @notice Restricts access to authorized signers.
    modifier onlySigner() {
        if (!signerManager.isSigner(msg.sender)) revert NotSigner();
        _;
    }

    /**
     * @notice Initializes modules, configures administrative roles and constraints.
     * @param _validationHandler ValidationHandler engine address.
     * @param _lockManager LockManager storage address.
     * @param _signerManager SignerManager address.
     * @param _vestingManager VestingManager address.
     * @param _initialSigners Array of initial signer addresses.
     * @param _initialThreshold Required signatures count.
     */
    constructor(
        address _validationHandler,
        address _lockManager,
        address _signerManager,
        address _vestingManager,
        address[] memory _initialSigners,
        uint256 _initialThreshold
    ) {
        require(
            _validationHandler != address(0) &&
                _lockManager != address(0) &&
                _signerManager != address(0) &&
                _vestingManager != address(0),
            "Invalid contract addresses"
        );
        require(
            _initialSigners.length >= 3 && _initialSigners.length <= 20,
            "Invalid signers count (must be 3-20)"
        );
        require(
            _initialThreshold >= 3 &&
                _initialThreshold <= _initialSigners.length,
            "Invalid threshold"
        );

        validationHandler = ValidationHandler(_validationHandler);
        lockManager = LockManager(_lockManager);
        signerManager = SignerManager(_signerManager);
        vestingManager = VestingManager(_vestingManager);

        // Wire each module to this contract. Calls are direct so that if a module is
        // already initialized the deployment reverts instead of continuing in a
        // partially-wired state.
        validationHandler.setLocker(address(this));
        lockManager.setLocker(address(this));
        signerManager.setLocker(address(this));
        vestingManager.setLocker(address(this));

        // Confirm every module points back to this contract before completing setup.
        require(
            validationHandler.locker() == address(this) &&
                lockManager.locker() == address(this) &&
                signerManager.locker() == address(this) &&
                vestingManager.locker() == address(this),
            "ERR_007"
        );
    }

    /**
     * @notice Updates the signature approvals threshold count.
     * @param newThreshold The new threshold count.
     * @param signers Array of signer addresses approving the update.
     * @param signatures Corresponding signatures.
     */
    function updateThresholdWithSignatures(
        uint256 newThreshold,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external nonReentrant {
        LockerSignerOperations.updateThresholdWithSignatures(
            validationHandler,
            signerManager,
            newThreshold,
            thresholdNonce,
            signers,
            signatures
        );
        thresholdNonce++;
        // Governance changed: invalidate every pending approval. In-flight operations must
        // have their signatures re-submitted under the new configuration.
        validationHandler.bumpConfigEpoch();
    }

    /**
     * @dev Validates batch signers update parameters to keep constraints intact.
     */
    function _validateBatchUpdate(
        address[] memory toRemove,
        address[] memory toAdd
    ) private view {
        uint256 currentCount = signerManager.getSigners().length;
        uint256 newCount = currentCount - toRemove.length + toAdd.length;

        require(newCount >= 3, "Final count below minimum");
        // Enforce the documented 3–20 invariant on the upper bound too: neither
        // addSignerDirect nor this validator otherwise caps growth, so successive batch
        // updates could push the signer set past MAX_SIGNERS.
        require(
            newCount <= signerManager.MAX_SIGNERS(),
            "Final count above maximum"
        );

        uint256 threshold = validationHandler.approvalsThreshold();
        require(newCount >= threshold, "Count below threshold");

        for (uint256 i = 0; i < toRemove.length; i++) {
            require(signerManager.isSigner(toRemove[i]), "Signer not found");
            // Reject duplicates in toRemove. removeSignerDirect is idempotent, so a
            // repeated address shrinks the set by fewer entries than toRemove.length
            // implies, making newCount above under-count the real post-update size (a
            // legitimate update could then be wrongly rejected). Symmetric with the
            // toAdd de-duplication below.
            for (uint256 j = i + 1; j < toRemove.length; j++) {
                require(toRemove[i] != toRemove[j], "Duplicate removal detected");
            }
        }

        for (uint256 i = 0; i < toAdd.length; i++) {
            require(toAdd[i] != address(0), "Cannot add zero address");
            for (uint256 j = i + 1; j < toAdd.length; j++) {
                require(toAdd[i] != toAdd[j], "Duplicate signer detected");
            }
            if (signerManager.isSigner(toAdd[i])) {
                bool isBeingRemoved = false;
                for (uint256 k = 0; k < toRemove.length; k++) {
                    if (toAdd[i] == toRemove[k]) {
                        isBeingRemoved = true;
                        break;
                    }
                }
                require(isBeingRemoved, "Signer already exists");
            }
        }
    }

    /**
     * @notice Batch updates signers lists (add/remove) via multi-sig signatures validation.
     * @param signersToRemove Array of signer addresses to remove.
     * @param signersToAdd Array of signer addresses to add.
     * @param signers Array of signer addresses approving the batch update.
     * @param signatures Corresponding signatures.
     */
    function batchUpdateSignersWithSignatures(
        address[] calldata signersToRemove,
        address[] calldata signersToAdd,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external nonReentrant {
        require(
            signersToRemove.length > 0 || signersToAdd.length > 0,
            "No signers provided"
        );
        _validateBatchUpdate(signersToRemove, signersToAdd);
        // EIP-712 BatchUpdateSigners: the two address[] fields are encoded as the keccak of
        // their 32-byte-padded elements (abi.encodePacked pads array elements), matching the
        // EIP-712 array-member encoding so the wallet recomputes the same hashStruct.
        bytes32 opKey = keccak256(
            abi.encode(
                BATCH_UPDATE_SIGNERS_TYPEHASH,
                keccak256(abi.encodePacked(signersToRemove)),
                keccak256(abi.encodePacked(signersToAdd)),
                batchUpdateSignersNonce
            )
        );
        require(opKey != bytes32(0), "OpKey is zero");

        LockerInternal.batchApprove(
            validationHandler,
            opKey,
            signers,
            signatures
        );
        LockerInternal.validateOp(validationHandler, opKey);
        for (uint256 i = 0; i < signersToRemove.length; i++) {
            signerManager.removeSignerDirect(signersToRemove[i]);
            emit SignerRemoved(signersToRemove[i]);
        }
        for (uint256 i = 0; i < signersToAdd.length; i++) {
            signerManager.addSignerDirect(signersToAdd[i]);
            emit SignerAdded(signersToAdd[i]);
        }
        validationHandler.markAsExecuted(opKey);
        batchUpdateSignersNonce++;
        // Governance changed: invalidate every pending approval, so a removed signer's
        // previously registered approvals can never satisfy a future quorum. In-flight
        // operations must have their signatures re-submitted (isSigner is re-checked).
        validationHandler.bumpConfigEpoch();
    }

    /**
     * @notice Creates a new token lock using caller resources. Restricts execution to authorized signers.
     * @param params CreateLockParams structure defining constraints.
     */
    function createLock(
        CreateLockParams calldata params
    ) external nonReentrant onlySigner {
        require(params.amount > 0, "Lock amount must be greater than 0");
        // Credit the actual received amount, not the requested amount, so fee-on-transfer /
        // deflationary tokens cannot record more than was delivered and drift the accounting
        // of sibling locks of the same token.
        IERC20 tok = IERC20(params.token);
        uint256 balBefore = tok.balanceOf(address(this));
        tok.safeTransferFrom(msg.sender, address(this), params.amount);
        uint256 received = tok.balanceOf(address(this)) - balBefore;
        require(received > 0, "No tokens received");

        uint256 lockId = lockManager.createLock(
            params.token,
            received,
            params.lockDuration,
            params.pair,
            params.ethUsdPair,
            params.targetPriceUSD1e18,
            params.isEthPair,
            params.stablecoinPosition,
            params.priceDirection
        );

        vestingManager.initializeVesting(
            lockId,
            params.vestingTokensPerPeriod,
            params.vestingPeriodSeconds,
            params.vestingAccumulate
        );
    }

    /**
     * @notice Creates a new lock utilizing offline EIP-712 signature credentials.
     * @param lockParams CreateLockParams structure.
     * @param sigParams SignatureParams structure.
     */
    function createLockWithSignatures(
        CreateLockParams calldata lockParams,
        SignatureParams calldata sigParams
    ) external nonReentrant {
        require(lockParams.amount > 0, "Lock amount must be greater than 0");
        if (!signerManager.isSigner(sigParams.signer)) revert NotSigner();

        // createLockNonce is a single global counter shared by every creation. This is
        // intentional: the signature is produced and submitted in the same operation (never
        // pre-signed offline for later submission), so a concurrent creation advancing the
        // counter cannot invalidate a prepared signature in practice. createLock only ever
        // DEPOSITS funds (pulled from msg.sender), so even a stale-nonce collision is a
        // harmless re-sign, never a loss of funds.
        uint256 currentNonce = createLockNonce++;
        uint256 lockId;
        {
            bytes32 opKey = keccak256(
                abi.encode(
                    CREATE_LOCK_TYPEHASH,
                    lockParams.token,
                    lockParams.amount,
                    lockParams.lockDuration,
                    lockParams.pair,
                    lockParams.ethUsdPair,
                    lockParams.targetPriceUSD1e18,
                    lockParams.isEthPair,
                    lockParams.stablecoinPosition,
                    lockParams.priceDirection,
                    lockParams.vestingTokensPerPeriod,
                    lockParams.vestingPeriodSeconds,
                    lockParams.vestingAccumulate,
                    currentNonce,
                    sigParams.signer
                )
            );

            validationHandler.verifySignatureOnly(
                opKey,
                sigParams.signer,
                sigParams.signature
            );
        }

        // Credit actual received amount (fee-on-transfer safe accounting).
        IERC20 tok = IERC20(lockParams.token);
        uint256 balBefore = tok.balanceOf(address(this));
        tok.safeTransferFrom(msg.sender, address(this), lockParams.amount);
        uint256 received = tok.balanceOf(address(this)) - balBefore;
        require(received > 0, "No tokens received");

        lockId = lockManager.createLock(
            lockParams.token,
            received,
            lockParams.lockDuration,
            lockParams.pair,
            lockParams.ethUsdPair,
            lockParams.targetPriceUSD1e18,
            lockParams.isEthPair,
            lockParams.stablecoinPosition,
            lockParams.priceDirection
        );

        vestingManager.initializeVesting(
            lockId,
            lockParams.vestingTokensPerPeriod,
            lockParams.vestingPeriodSeconds,
            lockParams.vestingAccumulate
        );
    }

    /**
     * @dev Validates basic constraints for unlocking.
     */
    function _validateUnlockRequest(
        uint256 lockId,
        uint256 amount
    ) private view {
        LockManager.TokenLock memory lock = lockManager.getLock(lockId);
        require(
            lock.basic.token != address(0),
            "No lock found for this lockId"
        );
        require(
            lock.basic.availableAmount >= amount,
            "Insufficient available amount in lock"
        );
        require(
            IERC20(lock.basic.token).balanceOf(address(this)) >= amount,
            "Insufficient contract balance"
        );
    }

    /**
     * @notice Top-up an existing lock with additional tokens.
     * @dev Explicit-amount top-ups (amount > 0) stay permissionless — that is the
     *      payment / escrow use case. The amount == 0 "auto-detect from balance" path,
     *      however, credits any stray balance sitting on the contract to this lock,
     *      which would let an unprivileged caller reclassify otherwise-rescueable stray
     *      funds as locked. That path is therefore restricted to authorized signers.
     * @param lockId Lock ID.
     * @param amount Tokens count to add. 0 = auto-detect from the contract balance (signers only).
     * @param paymentRef Arbitrary payment reference (order ID, product hash, etc.). Pass bytes32(0) if unused.
     */
    function addToLock(uint256 lockId, uint256 amount, bytes32 paymentRef) external nonReentrant {
        if (amount == 0 && !signerManager.isSigner(msg.sender)) {
            revert NotSigner();
        }
        LockerLockOperations.addToLock(
            lockManager,
            address(this),
            lockId,
            amount,
            msg.sender,
            paymentRef
        );
    }

    /**
     * @notice Executes a multi-sig approved unlock operation with EIP-712 signatures provided in batch.
     * @dev Fee-on-transfer note: `amount` is what leaves the contract (and is debited from
     *      the lock's availableAmount). With a deflationary token the recipient receives
     *      amount - fee; signers approve the debited amount, not the net received amount.
     * @param lockId Lock ID.
     * @param to Recipient address.
     * @param amount Tokens count to release.
     * @param signers Array of signer addresses.
     * @param signatures Corresponding signatures.
     */
    function executeUnlockWithSignatures(
        uint256 lockId,
        address to,
        uint256 amount,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external nonReentrant {
        // Consistency with rescue/vesting flows: reject a zero recipient or zero amount
        // up-front (defence in depth on top of the M-of-N signers' own diligence).
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");
        _validateUnlockRequest(lockId, amount);

        LockerLockOperations.executeUnlockWithSignatures(
            validationHandler,
            lockManager,
            address(this),
            lockId,
            to,
            amount,
            signers,
            signatures,
            unlockNonce
        );
        LockManager.TokenLock memory lock = lockManager.getLock(lockId);
        emit ExecutedUnlock(lock.basic.token, to, amount);
    }

    /**
     * @notice Rescues tokens sent to the contract by mistake, provided no lock exists for the specified token.
     * @dev Requires the full M-of-N signer threshold — the same authority as
     *      executeUnlockWithSignatures. The opKey binds token, recipient, amount, chainId
     *      and rescueNonce so signatures cannot be replayed or redirected.
     * @param token Address of the token to rescue.
     * @param to Recipient address.
     * @param amount Amount to rescue.
     * @param signers Array of signer addresses approving the rescue.
     * @param signatures Corresponding EIP-712 signatures.
     */
    function executeRescueWithSignatures(
        address token,
        address to,
        uint256 amount,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external nonReentrant {
        bytes32 opKey = keccak256(
            abi.encode(
                RESCUE_TOKEN_TYPEHASH,
                token,
                to,
                amount,
                block.chainid,
                rescueNonce
            )
        );
        LockerInternal.batchApprove(validationHandler, opKey, signers, signatures);
        LockerInternal.validateOp(validationHandler, opKey);
        // Effects before interactions: consume the approval and bump the nonce BEFORE the
        // token transfer, so a token with transfer callbacks (ERC-777 style) can never
        // observe a validated-but-unconsumed operation. Mirrors the native rescue flow.
        validationHandler.markAsExecuted(opKey);
        rescueNonce++;
        LockerLockOperations.executeRescue(lockManager, token, to, amount);
        emit ExecutedRescue(token, to, amount);
    }

    /**
     * @notice Rescues native coin force-sent to the contract (e.g. via selfdestruct).
     * @dev The contract has no receive/fallback, so native coin can only arrive by force.
     *      Requires the full M-of-N signer threshold, same as token rescue.
     * @param to Recipient address.
     * @param amount Amount of native coin to rescue.
     * @param signers Array of signer addresses approving the rescue.
     * @param signatures Corresponding EIP-712 signatures.
     */
    function executeRescueNativeWithSignatures(
        address to,
        uint256 amount,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external nonReentrant {
        require(amount > 0 && to != address(0), "Invalid amount or recipient");
        require(address(this).balance >= amount, "Insufficient native balance");
        bytes32 opKey = keccak256(
            abi.encode(
                RESCUE_NATIVE_TYPEHASH,
                to,
                amount,
                block.chainid,
                rescueNonce
            )
        );
        LockerInternal.batchApprove(validationHandler, opKey, signers, signatures);
        LockerInternal.validateOp(validationHandler, opKey);
        validationHandler.markAsExecuted(opKey);
        rescueNonce++;
        (bool success, ) = to.call{value: amount}("");
        require(success, "Native transfer failed");
        emit ExecutedRescueNative(to, amount);
    }

    /**
     * @notice Returns details of a specific lock.
     */
    function locks(
        uint256 lockId
    ) external view returns (LockManager.TokenLock memory) {
        return lockManager.getLock(lockId);
    }

    /**
     * @notice Returns validation indicators and progresses for a lock.
     */
    function getLockStatus(
        uint256 lockId
    ) external view returns (LockManager.LockStatus memory) {
        return lockManager.getLockStatus(lockId);
    }

    /**
     * @notice Returns list of all signers.
     */
    function getSigners() external view returns (address[] memory) {
        return signerManager.getSigners();
    }

    /**
     * @notice Checks if an address is registered as an authorized signer.
     */
    function isSigner(address account) external view returns (bool) {
        return signerManager.isSigner(account);
    }

    /**
     * @notice Returns array of unique tokens with active locks.
     */
    function getLockedTokens() external view returns (address[] memory) {
        return lockManager.getLockedTokens();
    }

    /**
     * @notice Returns approvals threshold.
     */
    function approvalsThreshold() external view returns (uint256) {
        return validationHandler.approvalsThreshold();
    }

    /**
     * @notice Counts collected approvals.
     */
    function approvalsCount(bytes32 opKey) external view returns (uint256) {
        return validationHandler.approvalsCount(opKey);
    }

    /**
     * @notice Checks if a signer approved an operation key.
     */
    function hasApproved(
        bytes32 opKey,
        address signer
    ) external view returns (bool) {
        return validationHandler.hasApproved(opKey, signer);
    }

    /**
     * @notice Generates unique operation hash for proposed unlocks.
     */
    function getUnlockOpKey(
        uint256 lockId,
        address to,
        uint256 amount
    ) external view returns (bytes32) {
        return
            LockerLockOperations.unlockOpKey(
                lockId,
                to,
                amount,
                unlockNonce[lockId]
            );
    }

    /**
     * @notice Generates unique operation hash for proposed token rescues.
     */
    function getRescueTokenOpKey(
        address token,
        address to,
        uint256 amount
    ) external view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    RESCUE_TOKEN_TYPEHASH,
                    token,
                    to,
                    amount,
                    block.chainid,
                    rescueNonce
                )
            );
    }

    /**
     * @notice Generates unique operation hash for proposed native coin rescues.
     */
    function getRescueNativeOpKey(
        address to,
        uint256 amount
    ) external view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    RESCUE_NATIVE_TYPEHASH,
                    to,
                    amount,
                    block.chainid,
                    rescueNonce
                )
            );
    }

    /**
     * @notice Calculates the currently vested and withdrawable token amount.
     */
    function calculateVestedAmount(
        uint256 lockId
    ) external view returns (uint256 amountTokens) {
        return vestingManager.calculateVestedAmount(lockId);
    }

    /**
     * @notice Returns vesting config structure for a lock.
     */
    function getVestingConfig(
        uint256 lockId
    ) external view returns (VestingManager.VestingConfig memory) {
        return vestingManager.getVestingConfig(lockId);
    }

    /**
     * @notice Releases vested tokens utilizing EIP-712 signatures.
     * @dev Releasing vested funds requires the full M-of-N signer threshold — the same
     *      authority as executeUnlockWithSignatures. maxAmountTokens is bound into
     *      the signed opKey so every signer commits to a per-release token ceiling, and the
     *      post-check enforces it on-chain (defends against the accumulated amount growing
     *      between signature collection and execution). Claims are all-or-nothing: if the
     *      vested amount exceeds the signed ceiling the release reverts, it is never split.
     * @param lockId Lock ID.
     * @param recipient Destination address.
     * @param maxAmountTokens Maximum number of tokens the signers authorize for this release.
     * @param signers Array of signer addresses approving the release.
     * @param signatures Corresponding EIP-712 signatures.
     */
    function unlockVestedWithSignatures(
        uint256 lockId,
        address recipient,
        uint256 maxAmountTokens,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        require(maxAmountTokens > 0, "Invalid max amount");

        uint256 currentNonce = vestingNonce[lockId];

        // opKey binds: operation, lockId, recipient, MAX token amount, chainId, nonce.
        // No single signer is embedded — the M-of-N threshold below is the authority.
        bytes32 opKey = keccak256(
            abi.encode(
                VESTING_UNLOCK_TYPEHASH,
                lockId,
                recipient,
                maxAmountTokens,
                block.chainid,
                currentNonce
            )
        );

        LockerInternal.batchApprove(validationHandler, opKey, signers, signatures);
        LockerInternal.validateOp(validationHandler, opKey);

        uint256 amountTokens = vestingManager.unlockVested(lockId);
        // Enforce the signed ceiling. A revert here rolls back the lastWithdrawalTime update
        // performed inside unlockVested, so no state is consumed when the cap is exceeded.
        require(amountTokens <= maxAmountTokens, "Amount exceeds signed cap");

        address token = lockManager.unlockVestedAmount(lockId, amountTokens);

        // Permanent replay guard (in addition to vestingNonce) for this opKey.
        validationHandler.markAsExecuted(opKey);
        vestingNonce[lockId]++;

        IERC20(token).safeTransfer(recipient, amountTokens);
    }
}
