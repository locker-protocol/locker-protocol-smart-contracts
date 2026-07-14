// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../FullMath.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title Locker Protocol — MockUniswapV3Pool
 * @notice Mock Uniswap V3 Pool contract used for testing price oracle math.
 * @custom:website https://lockerprotocol.com
 */
contract MockUniswapV3Pool {
    /// @notice Address of token0 in the pool.
    address public token0;
    /// @notice Address of token1 in the pool.
    address public token1;

    /// @dev Internal square root price of the pool.
    uint160 private sqrtPriceX96;
    /// @dev Internal active pool tick.
    int24 private tick;
    /// @dev Internal index tracking observation history.
    uint16 private observationIndex;
    /// @dev Internal current cardinality limit of observations.
    uint16 private observationCardinality;
    /// @dev Internal next cardinality target.
    uint16 private observationCardinalityNext;
    /// @dev Internal pool fee settings.
    uint8 private feeProtocol;
    /// @dev Internal reentrancy protection status lock.
    bool private unlocked;

    /// @dev Internal liquidity value storage.
    uint128 private liquidityValue;

    /**
     * @notice Initializes token addresses and default observation configurations.
     * @param _token0 Address of token0.
     * @param _token1 Address of token1.
     */
    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
        unlocked = true;
        observationCardinality = 1;
        observationCardinalityNext = 1;
        liquidityValue = 1e18;
    }

    /**
     * @notice Returns pool slot0 configuration metrics.
     */
    function slot0() external view returns (
        uint160 _sqrtPriceX96,
        int24 _tick,
        uint16 _observationIndex,
        uint16 _observationCardinality,
        uint16 _observationCardinalityNext,
        uint8 _feeProtocol,
        bool _unlocked
    ) {
        return (
            sqrtPriceX96,
            tick,
            observationIndex,
            observationCardinality,
            observationCardinalityNext,
            feeProtocol,
            unlocked
        );
    }

    /**
     * @notice Returns pool liquidity.
     */
    function liquidity() external view returns (uint128) {
        return liquidityValue;
    }

    /**
     * @notice Direct setter overriding slot0 square root price.
     * @param _sqrtPriceX96 The new square root price.
     */
    function setSqrtPriceX96(uint160 _sqrtPriceX96) external {
        sqrtPriceX96 = _sqrtPriceX96;
        tick = 0;
    }

    /**
     * @notice Sets exchange price for token0 in terms of token1.
     * @dev Calculates the Q192 ratio to compute the square root price, adjusting for token decimals.
     * @param P1e18 Target price of token0 in terms of token1 (1e18 precision).
     */
    function setPriceToken0InToken1(uint256 P1e18) external {
        require(P1e18 > 0, "PRICE_ZERO");

        uint8 d0 = IERC20Metadata(token0).decimals();
        uint8 d1 = IERC20Metadata(token1).decimals();

        uint256 Q192 = 2**192;
        uint256 factor0 = 10 ** uint256(d0);
        uint256 factor1 = 10 ** uint256(d1);

        // priceX192 = P1e18 * factor1 * Q192 / (1e18 * factor0)
        // Split calculations to prevent potential math overflows:
        // 1. temp = mulDiv(Q192, factor1, factor0)
        // 2. priceX192 = mulDiv(P1e18, temp, 1e18)
        uint256 temp = FullMath.mulDiv(Q192, factor1, factor0);
        uint256 priceX192 = FullMath.mulDiv(P1e18, temp, 1e18);

        sqrtPriceX96 = uint160(_sqrt(priceX192));
        tick = 0;
    }

    /**
     * @notice Sets exchange price for token1 in terms of token0.
     * @dev Computes the inverse price ratio and calculates slot0 square root price.
     * @param P1e18 Target price of token1 in terms of token0 (1e18 precision).
     */
    function setPriceToken1InToken0(uint256 P1e18) external {
        require(P1e18 > 0, "PRICE_ZERO");

        uint8 d0 = IERC20Metadata(token0).decimals();
        uint8 d1 = IERC20Metadata(token1).decimals();

        uint256 Q192 = 2**192;
        uint256 factor0 = 10 ** uint256(d0);
        uint256 factor1 = 10 ** uint256(d1);

        // priceX192 = ( (1/P) * factor1/factor0 ) * Q192
        // priceX192 = mulDiv(1e18, Q192 * factor1, P1e18 * factor0)
        uint256 numerator = Q192 * factor1;
        uint256 denominator = P1e18 * factor0;
        uint256 priceX192 = FullMath.mulDiv(1e18, numerator, denominator);

        sqrtPriceX96 = uint160(_sqrt(priceX192));
        tick = 0;
    }

    /**
     * @notice Direct setter overriding pool active liquidity.
     * @param _liquidity New active liquidity.
     */
    function setLiquidity(uint128 _liquidity) external {
        liquidityValue = _liquidity;
    }

    /**
     * @notice High level mock helper setting a specific token's price.
     * @param token Address of the token.
     * @param priceInOtherToken1e18 Target price (1e18 precision).
     */
    function setPriceForToken(address token, uint256 priceInOtherToken1e18) external {
        if (token == token0) {
            this.setPriceToken0InToken1(priceInOtherToken1e18);
        } else if (token == token1) {
            this.setPriceToken1InToken0(priceInOtherToken1e18);
        }
    }

    /**
     * @dev Standard Babylonian integer square root calculation helper.
     */
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}

