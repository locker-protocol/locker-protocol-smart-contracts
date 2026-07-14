// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../FullMath.sol";

/**
 * @title Locker Protocol — FullMathMock (test mock)
 * @notice Thin wrapper exposing the internal FullMath.mulDiv library function
 *         so tests can exercise its revert paths and exact boundary values.
 * @dev Test-only helper — never deployed to production.
 */
contract FullMathMock {
    /**
     * @notice Computes floor(a * b / denominator) via FullMath.mulDiv.
     * @param a The first operand
     * @param b The second operand
     * @param denominator The divisor
     * @return result The full-precision result
     */
    function mulDiv(
        uint256 a,
        uint256 b,
        uint256 denominator
    ) public pure returns (uint256 result) {
        return FullMath.mulDiv(a, b, denominator);
    }
}
