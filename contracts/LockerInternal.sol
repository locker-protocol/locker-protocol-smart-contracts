// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ValidationHandler.sol";

/**
 * @title Locker Protocol — LockerInternal
 * @notice Internal helper functions for managing administrative operations.
 * @dev Handles operations validation and batch approval executions.
 * @custom:website https://lockerprotocol.com
 */
library LockerInternal {
    /**
     * @notice Validates whether a multi-sig operation has collected enough approvals and is within the 24-hour execution window.
     * @dev Reverts if the operation is already executed, has insufficient approvals, or has expired.
     * @param validationHandler The ValidationHandler module.
     * @param opKey The unique hash identifying the operation.
     */
    function validateOp(
        ValidationHandler validationHandler,
        bytes32 opKey
    ) internal view {
        require(!validationHandler.hasExecuted(opKey), "Op already executed");
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

    /**
     * @notice Batch registers multiple signer approvals and signatures for an operation key.
     * @dev Directly forwards signatures validation to ValidationHandler.
     * @param validationHandler The ValidationHandler module.
     * @param opKey The unique hash identifying the operation.
     * @param signers Array of signer addresses.
     * @param signatures Array of cryptographic signature bytes corresponding to the signers.
     */
    function batchApprove(
        ValidationHandler validationHandler,
        bytes32 opKey,
        address[] calldata signers,
        bytes[] calldata signatures
    ) internal {
        // Gas Optimisation: opKey is passed directly — no per-entry array allocation
        validationHandler.batchApproveWithSignatures(
            opKey,
            signers,
            signatures
        );
    }
}
