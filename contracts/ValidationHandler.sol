// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Locker Protocol — ILockerContractForValidation
 * @notice Simplified interface of LockerContract used internally to query SignerManager.
 * @custom:website https://lockerprotocol.com
 */
interface ILockerContractForValidation {
    /**
     * @notice Returns the address of the SignerManager contract.
     */
    function signerManager() external view returns (address);
}

/**
 * @title Locker Protocol — ISignerManager
 * @notice Interface definition for the SignerManager module.
 * @custom:website https://lockerprotocol.com
 */
interface ISignerManager {
    /**
     * @notice Checks if an address is registered as an authorized signer.
     * @param signer The address to verify.
     * @return True if the address is a signer, false otherwise.
     */
    function isSigner(address signer) external view returns (bool);
}

/**
 * @title Locker Protocol — ValidationHandler
 * @notice Smart contract responsible for validating EIP-712 signatures and tracking multi-sig approvals.
 * @dev Replay protection is enforced by tracking executed operation keys. Signatures are verified using assembly-optimized recovery.
 *
 *      SIGNED MESSAGE — `opKey` IS the EIP-712 hashStruct of the concrete operation.
 *      Every caller (LockerContract and its libraries) builds `opKey` as
 *      keccak256(abi.encode(<OP>_TYPEHASH, <real fields...>)) for a typed struct such as
 *      Unlock(uint256 lockId,address to,uint256 amount,uint256 nonce). ValidationHandler
 *      therefore signs `keccak256(0x1901 ‖ DOMAIN_SEPARATOR ‖ opKey)` WITHOUT re-wrapping,
 *      so a signer's wallet renders the decoded fields and recomputes the same hash
 *      (eth_signTypedData_v4). This removes the previous blind-signing of an opaque
 *      ApproveOperation(bytes32 opKey). Uniqueness across operation types is preserved by
 *      the distinct per-operation type hashes; replay protection by the per-op nonces still
 *      embedded in each struct.
 * @custom:website https://lockerprotocol.com
 */
contract ValidationHandler {
    /// @notice The address of the main Locker Contract.
    address public locker;

    /// @notice Cached EIP-712 domain separator to optimize gas for signatures validation.
    bytes32 private _CACHED_DOMAIN_SEPARATOR;
    /// @notice The chain ID on which the domain separator was cached.
    uint256 private immutable _CACHED_CHAIN_ID;
    
    /// @notice The constant EIP-712 type hash for the domain separator structure.
    bytes32 private constant _TYPE_HASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    /**
     * @notice Packed data structure storing approval statistics.
     * @member approvalsCount Number of collected approvals for the operation.
     * @member lastApprovalTime Timestamp of the most recent approval (for expiration checking).
     * @member epoch Governance epoch the approvals were collected under. Approvals from an
     *         older epoch no longer count (see configEpoch).
     */
    struct OperationData {
        uint16 approvalsCount;
        uint40 lastApprovalTime;
        uint32 epoch;
    }

    /// @dev Maps operation key hash to its packed validation data.
    mapping(bytes32 => OperationData) private _operations;

    /// @dev Maps opKey => signer => (epoch + 1) at which the signer approved (0 = never).
    /// Epoch-tagged so that a governance change instantly invalidates every recorded
    /// approval without having to iterate storage.
    mapping(bytes32 => mapping(address => uint256)) private _approvalEpochPlusOne;
    /// @dev Maps operation key hash to true permanently to prevent replay attacks.
    /// This is the single source of truth for "already executed" (queryable via hasExecuted()).
    mapping(bytes32 => bool) private everExecuted;

    /// @notice The current threshold count of signatures required to validate operations.
    uint256 public approvalsThreshold;

    /// @notice Governance epoch. Incremented by the Locker after every signer-set or
    /// threshold change; approvals registered under an older epoch stop counting, so any
    /// in-flight operation must have its signatures re-submitted after a governance change.
    /// Re-registration re-checks isSigner, so a signer removed in the meantime is rejected
    /// and can no longer contribute to any pending quorum.
    uint256 public configEpoch;

    /**
     * @notice Checks if a signer's approval for an operation is registered AND still current
     *         (i.e. was recorded under the present governance epoch).
     * @param opKey The operation hash.
     * @param signer The signer address.
     * @return True if the approval counts toward the threshold.
     */
    function hasApproved(bytes32 opKey, address signer) public view returns (bool) {
        return _approvalEpochPlusOne[opKey][signer] == configEpoch + 1;
    }

    /**
     * @notice Public getter to retrieve approvals count for an operation.
     * @dev Returns 0 when the recorded approvals belong to a previous governance epoch.
     * @param opKey The operation hash.
     * @return The number of approvals still counting toward the threshold.
     */
    function approvalsCount(bytes32 opKey) public view returns (uint256) {
        OperationData memory opData = _operations[opKey];
        return opData.epoch == uint32(configEpoch) ? opData.approvalsCount : 0;
    }

    /**
     * @notice Public getter to retrieve last approval timestamp for an operation.
     * @param opKey The operation hash.
     * @return The last approval timestamp.
     */
    function opLastApprovalTime(bytes32 opKey) public view returns (uint256) {
        return _operations[opKey].lastApprovalTime;
    }

    /// @notice Event emitted when a signer approves a multi-sig operation.
    event OperationApproved(bytes32 indexed opKey, address indexed signer);
    /// @notice Event emitted when a multi-sig operation has been successfully marked as executed.
    event OperationExecuted(bytes32 indexed opKey);

    /// @notice Modifier restricting function calls to the main Locker Contract.
    /// @dev setThreshold / bumpConfigEpoch / markAsExecuted are all part of the Locker's
    ///      atomic approve+validate+execute flow, so the Locker is the only legitimate
    ///      caller. The SignerManager never calls into ValidationHandler, so no broader
    ///      "locker OR signer manager" surface is exposed.
    modifier onlyLocker() {
        require(msg.sender == locker, "Only locker allowed");
        _;
    }

    /// @notice True if the Locker Contract address has been set.
    bool public initialized;

    /// @notice EOA that deployed this module. Only it may perform the one-time wiring, so the
    /// wiring is bound to the deployer's own transaction. Recorded as tx.origin so the check
    /// also holds when modules are deployed through a factory within the deployer's transaction.
    address public immutable deployer;

    /**
     * @notice Initializes the approvals threshold and caches the current chain ID.
     * @param _initialThreshold Number of approvals required to validate operations.
     */
    constructor(uint256 _initialThreshold) {
        require(_initialThreshold >= 3, "Threshold too low");
        deployer = tx.origin;
        approvalsThreshold = _initialThreshold;
        _CACHED_CHAIN_ID = block.chainid;
    }

    /**
     * @notice Sets the Locker Contract address and computes/caches the domain separator.
     * @dev Wiring is performed by the LockerContract constructor, so msg.sender is the
     *      locker itself — tx.origin authenticates that the transaction was initiated by
     *      the module's deployer (deploy-time only; the check is moot once initialized).
     * @param _locker The Locker Contract address.
     */
    function setLocker(address _locker) external {
        // solhint-disable-next-line avoid-tx-origin
        require(tx.origin == deployer, "Only deployer");
        require(!initialized && _locker != address(0), "Already initialized");
        locker = _locker;
        initialized = true;
        _CACHED_DOMAIN_SEPARATOR = _computeDomainSeparator();
    }

    /**
     * @dev Queries signer status from SignerManager through LockerContract.
     */
    function _isSigner(address signer) internal view returns (bool) {
        if (locker == address(0)) return false;

        try ILockerContractForValidation(locker).signerManager() returns (
            address signerManager
        ) {
            if (signerManager == address(0)) return false;
            return ISignerManager(signerManager).isSigner(signer);
        } catch {
            return false;
        }
    }

    /**
     * @notice Sets a new required approval threshold (called from Locker Contract only).
     * @param newThreshold The new approvals threshold count.
     */
    function setThreshold(uint256 newThreshold) external onlyLocker {
        approvalsThreshold = newThreshold;
    }

    /**
     * @notice Advances the governance epoch, instantly invalidating every pending approval.
     * @dev Called by the Locker after any signer-set or threshold change. Signatures already
     *      collected off-chain stay cryptographically valid but must be re-submitted to
     *      count again — re-registration re-checks signer status under the new configuration.
     */
    function bumpConfigEpoch() external onlyLocker {
        configEpoch++;
    }

    /**
     * @dev Computes the domain separator according to EIP-712 standard.
     */
    function _computeDomainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _TYPE_HASH,
                    keccak256(bytes("LockerContract")),
                    keccak256(bytes("1")),
                    block.chainid,
                    locker
                )
            );
    }

    /**
     * @notice Returns the EIP-712 Domain Separator. Re-calculates if chain ID changes.
     * @return The 32-byte domain separator hash.
     */
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            block.chainid == _CACHED_CHAIN_ID
                ? _CACHED_DOMAIN_SEPARATOR
                : _computeDomainSeparator();
    }

    /**
     * @notice Returns the cached chain ID.
     */
    function getCachedChainId() public view returns (uint256) {
        return _CACHED_CHAIN_ID;
    }

    /**
     * @dev Internal helper recovering signer address from EIP-712 signature using optimized assembly.
     */
    function _recoverSignerOptimized(
        bytes32 opKey,
        bytes calldata signature
    ) internal view returns (address) {
        // Reject malformed signatures before the fixed-offset assembly read.
        require(signature.length == 65, "ERR_006B: Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }

        // EIP-2: Reject malleable signatures (s must be in lower half of curve order)
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "ERR_006: Invalid signature 's' value"
        );

        // Accept both the {27,28} and the raw {0,1} yParity encodings — some signers emit
        // the latter — then reject anything else so a malformed v cannot silently make
        // ecrecover return address(0) and fall through to the recovered == signer check.
        // This does not widen malleability: (r,s) already uniquely determines the signer,
        // approvals are idempotent per (opKey, signer), and everExecuted blocks replay.
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "ERR_006C: Invalid signature 'v' value");

        // `opKey` is already the EIP-712 hashStruct of the concrete operation (built by the
        // caller from the real fields), so it is bound directly under the domain separator
        // with no ApproveOperation re-wrap — the signer's wallet computes the identical hash.
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), opKey)
        );

        return ecrecover(digest, v, r, s);
    }

    /**
     * @dev Loads operation data, resetting the counters when the stored approvals were
     *      collected under a previous governance epoch (they no longer count).
     */
    function _loadCurrentEpochData(
        bytes32 opKey
    ) private view returns (OperationData memory opData) {
        opData = _operations[opKey];
        if (opData.epoch != uint32(configEpoch)) {
            opData = OperationData({
                approvalsCount: 0,
                lastApprovalTime: 0,
                epoch: uint32(configEpoch)
            });
        }
    }

    /**
     * @dev Tags the signer's approval with the current epoch and persists the counters.
     */
    function _registerApproval(
        bytes32 opKey,
        address signer,
        OperationData memory opData
    ) private {
        _approvalEpochPlusOne[opKey][signer] = configEpoch + 1;

        _operations[opKey] = OperationData({
            approvalsCount: opData.approvalsCount + 1,
            lastApprovalTime: uint40(block.timestamp),
            epoch: uint32(configEpoch)
        });
    }

    /**
     * @notice Marks an operation key as executed to prevent replay, resetting the validation struct to save gas.
     * @param opKey The operation hash.
     */
    function markAsExecuted(bytes32 opKey) external onlyLocker {
        require(!everExecuted[opKey], "Already executed");
        // Epoch-aware count: approvals from a previous governance epoch cannot execute.
        require(
            approvalsCount(opKey) >= approvalsThreshold,
            "Not validated"
        );

        everExecuted[opKey] = true; // Permanent anti-replay
        delete _operations[opKey]; // Gas refund

        emit OperationExecuted(opKey);
    }

    /**
     * @dev Internal verification and approval registration using cryptographic signatures.
     */
    function _approveOperationWithSignature(
        bytes32 opKey,
        address signer,
        bytes calldata signature
    ) internal {
        require(_isSigner(signer), "ERR_001: Not authorized signer");
        require(!everExecuted[opKey], "ERR_002: Operation already executed");

        OperationData memory opData = _loadCurrentEpochData(opKey);
        // Idempotent: if this signer already approved this opKey (under the current
        // governance epoch), skip silently instead of reverting, so re-submitting the same
        // signature is a no-op rather than a failure.
        if (opData.approvalsCount != 0 && hasApproved(opKey, signer)) {
            return;
        }

        address recovered = _recoverSignerOptimized(opKey, signature);
        require(recovered != address(0), "ERR_004: Signature recovery failed");
        require(recovered == signer, "ERR_005: Invalid signature");

        _registerApproval(opKey, signer, opData);

        emit OperationApproved(opKey, signer);
    }

    /**
     * @notice Verifies signature credentials for an operation key without saving any approval state.
     * @dev Used for single-signature operations (e.g. initial setup) that bypass the threshold logic.
     * @param opKey The operation hash.
     * @param signer The signer address to verify.
     * @param signature The EIP-712 signature payload.
     */
    function verifySignatureOnly(
        bytes32 opKey,
        address signer,
        bytes calldata signature
    ) external view {
        require(_isSigner(signer), "Not authorized signer");

        address recovered = _recoverSignerOptimized(opKey, signature);
        if (recovered != signer) revert("INV_SIG");
    }

    /**
     * @notice Registers multiple signer approvals for an operation key in one call.
     * @dev Restricted to the Locker Contract: approvals are only ever collected as part of
     *      the atomic approve+validate+execute flow (executeUnlock / rescue / vesting /
     *      governance). Gating this to onlyLocker means the operation-approval state can
     *      never be pre-populated from outside that flow, so an operation cannot be bricked
     *      by a third party pre-registering-then-letting-expire a set of signatures.
     * @param opKey The operation hash.
     * @param signers Array of signer addresses.
     * @param signatures Array of signatures.
     */
    function batchApproveWithSignatures(
        bytes32 opKey,
        address[] calldata signers,
        bytes[] calldata signatures
    ) external onlyLocker {
        uint256 len = signers.length;
        require(len == signatures.length, "Array length mismatch");

        for (uint256 i = 0; i < len; i++) {
            _approveOperationWithSignature(opKey, signers[i], signatures[i]);
        }
    }

    /**
     * @notice Read-only check to see if an operation key has ever been executed.
     * @param opKey The operation hash.
     * @return True if operation was executed, false otherwise.
     */
    function hasExecuted(bytes32 opKey) external view returns (bool) {
        return everExecuted[opKey];
    }
}
