// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ValidationHandler.sol";

/**
 * @title Locker Protocol — SignerManager
 * @notice Contract managing the authorized list of signers and signature thresholds.
 * @dev Governs the identity storage and limits (3 to 20 signers) for the M-of-N multi-signature wallet.
 * @custom:website https://lockerprotocol.com
 */
contract SignerManager {
    /// @notice The address of the main Locker Contract.
    address public locker;
    /// @notice Reference to the ValidationHandler engine contract.
    ValidationHandler public validationHandler;

    /// @notice Mapping to check if an address is currently an authorized signer.
    mapping(address => bool) public isSigner;
    /// @notice List of all authorized signer addresses.
    address[] public signersList;

    /// @notice The minimum threshold allowed. Aligned with LockerContract/LockerSignerOperations
    /// (which enforce 3) so no path can weaken the multi-sig below the documented 3-of-N.
    uint256 public constant MIN_THRESHOLD = 3;
    /// @notice The minimum number of signers required. Aligned with LockerContract's constructor.
    uint256 public constant MIN_SIGNERS = 3;
    /// @notice The maximum number of signers allowed (20).
    uint256 public constant MAX_SIGNERS = 20;

    /// @notice Event emitted when a new signer is added.
    event SignerAdded(address indexed signer);
    /// @notice Event emitted when an existing signer is removed.
    event SignerRemoved(address indexed signer);

    /// @notice Modifier restricting function calls to the main Locker Contract.
    modifier onlyLocker() {
        require(msg.sender == locker, "Only locker allowed");
        _;
    }

    /// @notice True if the Locker Contract reference has been set.
    bool public initialized;

    /// @notice EOA that deployed this module. Only it may perform the one-time wiring, so the
    /// wiring is bound to the deployer's own transaction. Recorded as tx.origin so the check
    /// also holds when modules are deployed through a factory within the deployer's transaction.
    address public immutable deployer;

    /**
     * @notice Initializes the signer list and verifies standard constraints.
     * @param _validationHandler The address of the ValidationHandler contract.
     * @param _initialSigners Array of initial signer addresses.
     * @param _initialThreshold Number of required signatures.
     */
    constructor(
        address _validationHandler,
        address[] memory _initialSigners,
        uint256 _initialThreshold
    ) {
        deployer = tx.origin;
        require(_validationHandler != address(0), "Zero validation handler");
        require(
            _initialSigners.length >= MIN_SIGNERS &&
                _initialSigners.length <= MAX_SIGNERS,
            "Invalid signer count"
        );
        require(_initialThreshold >= MIN_THRESHOLD, "Threshold too low");
        require(
            _initialThreshold <= _initialSigners.length,
            "Threshold too high"
        );

        validationHandler = ValidationHandler(_validationHandler);

        // Initialize all signers
        for (uint256 i = 0; i < _initialSigners.length; i++) {
            address signer = _initialSigners[i];
            require(signer != address(0), "Invalid signer address");
            require(!isSigner[signer], "Duplicate signer");

            isSigner[signer] = true;
            signersList.push(signer);
            emit SignerAdded(signer);
        }

        // Note: Threshold is already set in ValidationHandler constructor
        // Cannot call setThreshold here because ValidationHandler.locker is not set yet
    }

    /**
     * @notice Configures the Locker Contract address (can only be run once).
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
    }

    /**
     * @notice Direct entrypoint for Locker Contract to remove a signer.
     * @param signer The address of the signer to remove.
     */
    function removeSignerDirect(address signer) external onlyLocker {
        isSigner[signer] = false;

        uint256 len = signersList.length;
        for (uint256 i = 0; i < len; i++) {
            if (signersList[i] == signer) {
                signersList[i] = signersList[len - 1];
                signersList.pop();
                break;
            }
        }
    }

    /**
     * @notice Direct entrypoint for Locker Contract to add a signer.
     * @param signer The address of the signer to add.
     */
    function addSignerDirect(address signer) external onlyLocker {
        require(
            signer != address(0) && !isSigner[signer],
            "Invalid signer state"
        );
        isSigner[signer] = true;
        signersList.push(signer);
    }

    /**
     * @notice Verifies if removing a signer keeps the total signers count above the minimum required.
     * @param signer The address of the signer to check.
     * @return True if signer can be removed, false otherwise.
     */
    function canRemoveSigner(address signer) external view returns (bool) {
        return isSigner[signer] && signersList.length > MIN_SIGNERS;
    }

    /**
     * @notice Returns the list of all currently authorized signers.
     * @return An array of signer addresses.
     */
    function getSigners() external view returns (address[] memory) {
        return signersList;
    }
}
