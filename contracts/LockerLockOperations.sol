// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ValidationHandler.sol";
import "./LockManager.sol";

/**
 * @title Locker Protocol — LockerLockOperations
 * @notice Library containing all logic related to lock creation, top-ups, unlocks, and token rescue operations.
 * @dev Interacts with LockManager to update state, and performs ERC-20 token transfers to/from LockerContract.
 * @custom:website https://lockerprotocol.com
 */
library LockerLockOperations {
    using SafeERC20 for IERC20;

    /// @dev EIP-712 type hash for the Unlock operation. The unlock opKey is the hashStruct of
    ///      Unlock(uint256 lockId,address to,uint256 amount,uint256 nonce), so signers approve
    ///      the decoded fields in their wallet (which recomputes the identical hash).
    bytes32 internal constant UNLOCK_TYPEHASH =
        keccak256("Unlock(uint256 lockId,address to,uint256 amount,uint256 nonce)");

    /// @notice Computes the EIP-712 hashStruct (opKey) for an Unlock operation.
    /// @dev Single source of truth shared by the on-chain executor and LockerContract's
    ///      getUnlockOpKey view, so the preview and the executed key can never drift.
    function unlockOpKey(
        uint256 lockId,
        address to,
        uint256 amount,
        uint256 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(UNLOCK_TYPEHASH, lockId, to, amount, nonce));
    }

    /**
     * @notice Top-up an existing lock with additional tokens.
     * @param lockManager The LockManager storage module.
     * @param lockerContract The address of the main Locker Contract.
     * @param lockId The unique ID of the lock to top-up.
     * @param amount The number of tokens to add (if 0, it reads the contract balance difference).
     * @param caller The address of the user adding the tokens.
     * @param paymentRef Arbitrary payment reference (order ID, product hash, etc.).
     */
    function addToLock(
        LockManager lockManager,
        address lockerContract,
        uint256 lockId,
        uint256 amount,
        address caller,
        bytes32 paymentRef
    ) internal {
        uint256 amountToAdd = _calculateAmountToAdd(
            lockManager,
            lockerContract,
            lockId,
            amount,
            caller
        );
        lockManager.addToLock(lockId, amountToAdd, caller, paymentRef);
    }

    /**
     * @dev Calculates the amount to add to the lock and transfers tokens if amount > 0.
     */
    function _calculateAmountToAdd(
        LockManager lockManager,
        address lockerContract,
        uint256 lockId,
        uint256 amount,
        address caller
    ) private returns (uint256) {
        if (amount == 0) {
            return
                _calculateAmountFromBalance(
                    lockManager,
                    lockerContract,
                    lockId
                );
        } else {
            // Get token from lock and credit the actual received amount (fee-on-transfer safe).
            LockManager.TokenLock memory lock = lockManager.getLock(lockId);
            IERC20 tok = IERC20(lock.basic.token);
            uint256 balBefore = tok.balanceOf(lockerContract);
            tok.safeTransferFrom(caller, lockerContract, amount);
            uint256 received = tok.balanceOf(lockerContract) - balBefore;
            require(received > 0, "No tokens received");
            return received;
        }
    }

    /**
     * @dev Calculates the top-up amount from the contract's actual balance compared to recorded availableAmount.
     */
    function _calculateAmountFromBalance(
        LockManager lockManager,
        address lockerContract,
        uint256 lockId
    ) private view returns (uint256) {
        LockManager.TokenLock memory existingLock = lockManager.getLock(lockId);
        require(
            existingLock.basic.token != address(0),
            "No lock exists for this lock ID"
        );

        address token = existingLock.basic.token;
        // Auto-detect (amount==0) infers the top-up from the contract's token balance,
        // which is shared across every lock of this token. It is therefore only
        // well-defined when the token has a single lock; with multiple locks the caller
        // must pass an explicit amount.
        require(
            lockManager.getTokenLocks(token).length == 1,
            "ERR_008"
        );
        uint256 contractBalance = IERC20(token).balanceOf(lockerContract);
        require(contractBalance > 0, "Contract has no balance for this token");
        require(
            contractBalance >= existingLock.basic.availableAmount,
            "Contract balance less than lock amount"
        );
        uint256 amountToAdd = contractBalance -
            existingLock.basic.availableAmount;
        require(amountToAdd > 0, "No additional amount to add");
        return amountToAdd;
    }

    /**
     * @notice Executes a multi-sig approved unlock operation with EIP-712 signatures provided in batch.
     * @param validationHandler The ValidationHandler engine.
     * @param lockManager The LockManager storage module.
     * @param lockerContract The address of the main Locker Contract.
     * @param lockId The unique ID of the lock to unlock.
     * @param to The recipient address.
     * @param amount The number of tokens to release.
     * @param signers Array of signer addresses.
     * @param signatures Array of signatures.
     * @param unlockNonce Mappings containing the next unlock nonces.
     */
    function executeUnlockWithSignatures(
        ValidationHandler validationHandler,
        LockManager lockManager,
        address lockerContract,
        uint256 lockId,
        address to,
        uint256 amount,
        address[] calldata signers,
        bytes[] calldata signatures,
        mapping(uint256 => uint256) storage unlockNonce
    ) internal {
        bytes32 opKey = _generateUnlockOpKey(lockId, to, amount, unlockNonce);
        _batchApprove(validationHandler, opKey, signers, signatures);
        _validateOp(validationHandler, opKey);
        _executeUnlock(
            validationHandler,
            lockManager,
            lockerContract,
            lockId,
            to,
            amount,
            opKey,
            unlockNonce
        );
    }

    /**
     * @dev Generates the hash identifying the unlock operation.
     */
    function _generateUnlockOpKey(
        uint256 lockId,
        address to,
        uint256 amount,
        mapping(uint256 => uint256) storage unlockNonce
    ) private view returns (bytes32) {
        return unlockOpKey(lockId, to, amount, unlockNonce[lockId]);
    }

    /**
     * @notice Rescues tokens sent to the contract by mistake, provided no lock exists for the specified token.
     * @param lockManager The LockManager storage module.
     * @param token The address of the ERC-20 token to rescue.
     * @param to The address of the recipient.
     * @param amount The quantity to rescue.
     */
    function executeRescue(
        LockManager lockManager,
        address token,
        address to,
        uint256 amount
    ) internal {
        require(amount > 0 && to != address(0), "Invalid amount or recipient");
        // Rescue should only work if NO lock exists for this token
        // Check if there are any locks for this token
        uint256[] memory lockIds = lockManager.getTokenLocks(token);
        require(
            lockIds.length == 0,
            "Lock exists for this token - use unlock instead"
        );
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @dev Helper method to batch register approvals.
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

    /**
     * @dev Helper method that performs actual unlocking, checking contract balance and sending tokens.
     */
    function _executeUnlock(
        ValidationHandler validationHandler,
        LockManager lockManager,
        address lockerContract,
        uint256 lockId,
        address to,
        uint256 amount,
        bytes32 opKey,
        mapping(uint256 => uint256) storage unlockNonce
    ) private {
        // Ordering matters: read the token address BEFORE validateAndUnlock.
        // When the last unlock empties the lock (availableAmount == 0), validateAndUnlock
        // calls _deleteLockIfEmpty which does "delete locks[lockId]", setting all fields to 0.
        // If we read the lock AFTER deletion, lock.basic.token == address(0) and transfer fails.
        LockManager.TokenLock memory lock = lockManager.getLock(lockId);
        address token = lock.basic.token;
        require(token != address(0), "No lock found for this lockId");

        // Now safe to validate and potentially delete the lock
        lockManager.validateAndUnlock(lockId, amount);
        validationHandler.markAsExecuted(opKey);

        // Use the saved token address for transfer (lock may have been deleted)
        require(
            IERC20(token).balanceOf(lockerContract) >= amount,
            "Insufficient contract balance for unlock"
        );
        IERC20(token).safeTransfer(to, amount);
        unlockNonce[lockId]++;
    }
}
