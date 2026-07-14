// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Locker Protocol — MockUniswapV2Pair
 * @notice Mock Uniswap V2 Pair contract used for testing price oracle math.
 * @custom:website https://lockerprotocol.com
 */
contract MockUniswapV2Pair {
    /// @notice Address of token0 in the pair.
    address public token0;
    /// @notice Address of token1 in the pair.
    address public token1;
    
    /// @dev Internal reserve size of token0.
    uint112 private reserve0;
    /// @dev Internal reserve size of token1.
    uint112 private reserve1;
    /// @dev Last reserve update block timestamp.
    uint32 private blockTimestampLast;

    /**
     * @notice Initializes token addresses and default timestamp.
     * @param _token0 Address of token0.
     * @param _token1 Address of token1.
     */
    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
        blockTimestampLast = uint32(block.timestamp);
    }

    /**
     * @notice Returns pool reserves.
     * @return _reserve0 Reserves of token0.
     * @return _reserve1 Reserves of token1.
     * @return _blockTimestampLast Timestamp of last update.
     */
    function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    /**
     * @notice Direct helper to override pool reserves during testing.
     * @param _reserve0 New reserve0 size.
     * @param _reserve1 New reserve1 size.
     */
    function setReserves(uint112 _reserve0, uint112 _reserve1) external {
        reserve0 = _reserve0;
        reserve1 = _reserve1;
        blockTimestampLast = uint32(block.timestamp);
    }
    
    /**
     * @notice Calculates and adjusts pool reserves to mock specific token pricing.
     * @dev Uses a fixed base reserve for one token, adjusting the other according to the target price.
     * @param token Address of the token to price.
     * @param priceInOtherToken1e18 Target price in terms of the other token (1e18 precision).
     */
    function setPriceForToken(address token, uint256 priceInOtherToken1e18) external {
        require(token == token0 || token == token1, "INVALID_TOKEN");
        
        uint112 baseReserve = 1000000 * 1e18; // 1M tokens base reserve to keep liquidity
        
        if (token == token0) {
            reserve0 = uint112(baseReserve);
            reserve1 = uint112((priceInOtherToken1e18 * baseReserve) / 1e18);
        } else {
            reserve1 = uint112(baseReserve);
            reserve0 = uint112((priceInOtherToken1e18 * baseReserve) / 1e18);
        }
        
        blockTimestampLast = uint32(block.timestamp);
    }
}