// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockBrokenPool (tests only)
 * @notice Drives PriceCalculator's try-V2/catch-V3 helpers (getPairTokens,
 *         validatePairContainsToken, validateEthUsdPair) into their V3 catch
 *         branches. The V2 and V3 pool interfaces share the exact same
 *         token0()/token1() ABI (same selector, same return type), so a normal
 *         mock can never fail the V2 attempt yet succeed on the V3 retry.
 *
 *         This mock discriminates the two attempts by forwarded gas:
 *         - The first call (the V2 `try`) arrives with plenty of gas: it burns
 *           almost all forwarded gas down to ~15k, then reverts. Per EIP-150
 *           the caller retained only 1/64 of its gas, so after the refund of
 *           the unburned remainder it holds roughly L/64 + 15k.
 *         - The second call (the V3 retry in the `catch`) therefore arrives
 *           well under V2_GAS_CEILING and succeeds.
 *
 *         Call the PriceCalculator helper with an explicit low gas limit
 *         (e.g. { gasLimit: 1_000_000 }) so the retry lands under the ceiling:
 *         first call entry gas ~960k > 150k (reverts), retry entry gas
 *         ~30k * 63/64 < 150k (succeeds).
 */
contract MockBrokenPool {
    address private immutable _token0Addr;
    address private immutable _token1Addr;

    /// @notice Calls entering with more gas than this are treated as the V2 attempt and revert.
    uint256 public constant V2_GAS_CEILING = 150000;

    constructor(address t0, address t1) {
        _token0Addr = t0;
        _token1Addr = t1;
    }

    function token0() external view returns (address) {
        if (gasleft() > V2_GAS_CEILING) {
            // Burn nearly all forwarded gas, then revert with data derived
            // from the burn accumulator so the loop cannot be optimized away.
            assembly {
                let acc := 0
                for {} gt(gas(), 15000) {} {
                    mstore(0, acc)
                    acc := keccak256(0, 32)
                }
                mstore(0, acc)
                revert(0, 32)
            }
        }
        return _token0Addr;
    }

    function token1() external view returns (address) {
        return _token1Addr;
    }
}
