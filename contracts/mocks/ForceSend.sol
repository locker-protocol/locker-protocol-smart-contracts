// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Locker Protocol — ForceSend (test mock)
 * @notice Force-sends native coin to any address via selfdestruct, bypassing
 *         the absence of a receive/fallback function on the target.
 * @dev Test-only helper used to exercise executeRescueNativeWithSignatures.
 */
contract ForceSend {
    /**
     * @notice Self-destructs and forwards the full attached value to `target`.
     * @param target Address receiving the forced native coin.
     */
    function forceSend(address payable target) external payable {
        selfdestruct(target);
    }
}
