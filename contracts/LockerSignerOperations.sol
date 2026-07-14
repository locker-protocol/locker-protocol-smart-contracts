// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ValidationHandler.sol";
import "./SignerManager.sol";

/**
 * @title Locker Protocol — LockerSignerOperations
 * @notice Operations library for updating signer verification thresholds in the Locker Protocol.
 * @dev Manages the authorization updates, validating both direct and multi-sig signature thresholds.
 * @custom:website https://lockerprotocol.com
 */
library LockerSignerOperations {
    /// @dev EIP-712 type hash for the UpdateThreshold operation. The opKey is the hashStruct of
    ///      UpdateThreshold(uint256 newThreshold,uint256 nonce), so signers approve the decoded
    ///      fields in their wallet (which recomputes the identical hash).
    bytes32 internal constant UPDATE_THRESHOLD_TYPEHASH =
        keccak256("UpdateThreshold(uint256 newThreshold,uint256 nonce)");

    /**
     * @notice Updates the required number of approvals with signers' multi-sig signatures.
     * @dev Validates that the threshold meets minimum / maximum limits, signs the request using the nonce, and updates both Handler and Manager.
     * @param validationHandler The ValidationHandler engine.
     * @param signerManager The SignerManager storage module.
     * @param newThreshold The new approvals threshold to set.
     * @param nonce Replay protection nonce for this update operation.
     * @param signers Array of signer addresses participating in the approval.
     * @param signatures Cryptographic signatures corresponding to the signers.
     */
    function updateThresholdWithSignatures(
        ValidationHandler validationHandler,
        SignerManager signerManager,
        uint256 newThreshold,
        uint256 nonce,
        address[] calldata signers,
        bytes[] calldata signatures
    ) internal {
        uint256 minThreshold = 3; // MIN_THRESHOLD from SignerManager
        require(
            newThreshold >= minThreshold,
            "Threshold too low (minimum is 3)"
        );
        address[] memory currentSigners = signerManager.getSigners();
        uint256 maxThreshold = currentSigners.length;
        require(
            newThreshold <= maxThreshold,
            "Threshold too high (max is signer count)"
        );
        bytes32 opKey = keccak256(
            abi.encode(UPDATE_THRESHOLD_TYPEHASH, newThreshold, nonce)
        );
        _batchApprove(validationHandler, opKey, signers, signatures);
        _validateOp(validationHandler, opKey);
        validationHandler.markAsExecuted(opKey); // Mark as executed BEFORE changing threshold
        validationHandler.setThreshold(newThreshold); // Change threshold AFTER validation
    }

    /**
     * @dev Helper method to batch register signer approvals.
     */
    function _batchApprove(
        ValidationHandler validationHandler,
        bytes32 opKey,
        address[] calldata signers,
        bytes[] calldata signatures
    ) private {
        // Gas Optimisation: opKey is passed directly — no per-entry array allocation
        validationHandler.batchApproveWithSignatures(
            opKey,
            signers,
            signatures
        );
    }

    /**
     * @dev Helper method to validate if an operation meets signature threshold and timeframe constraints.
     */
    function _validateOp(
        ValidationHandler validationHandler,
        bytes32 opKey
    ) private view {
        require(
            !validationHandler.hasExecuted(opKey),
            "Operation already executed"
        );
        require(
            validationHandler.approvalsCount(opKey) >=
                validationHandler.approvalsThreshold(),
            "Insufficient approvals"
        );
        uint256 last = validationHandler.opLastApprovalTime(opKey);
        require(last != 0, "No approvals yet");
        require(
            block.timestamp <= last + 86400, // Hardcoded 24h window
            "Op expired"
        );
    }
}
