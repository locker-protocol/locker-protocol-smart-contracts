// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FullMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title Locker Protocol — IUniswapV2Pair
 * @notice Interface for querying Uniswap V2 liquidity pool tokens and reserves.
 * @custom:website https://lockerprotocol.com
 */
interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/**
 * @title Locker Protocol — IUniswapV3Pool
 * @notice Interface for querying Uniswap V3 pool configuration, token addresses, and slot0 pricing state.
 * @custom:website https://lockerprotocol.com
 */
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function liquidity() external view returns (uint128);
}

/**
 * @title Locker Protocol — PriceCalculator
 * @notice Oracle price query calculator fetching rates from Uniswap V2 and V3 pools.
 * @dev Computes token pricing in USD by resolving native asset exchange rates (WETH) or direct stablecoin pairs.
 *
 *      SECURITY — SPOT PRICES, NOT A TRUSTLESS ORACLE. All reads are live pool state
 *      (getReserves() on V2, slot0() on V3) with no TWAP: the reported price can be moved
 *      within a single block (e.g. flash loans) to satisfy or defeat a price target.
 *      This is acceptable in the Locker Protocol because no funds ever move on a price
 *      condition alone — every release still requires the M-of-N signer threshold. Price
 *      conditions are a business-rule gate layered on top of the multi-sig, and signers
 *      MUST independently verify market conditions before signing: an on-chain
 *      "target price reached" must never be treated as authoritative by itself.
 * @custom:website https://lockerprotocol.com
 */
contract PriceCalculator {
    /// @notice Custom WETH contract address registry mapping. Immutable after deployment.
    mapping(address => bool) public customWETHAddresses;
    /// @notice Chain-specific default WETH address.
    address public wethAddress;

    /**
     * @notice Configures the default WETH address and the immutable custom WETH list.
     * @param _wethAddress Default WETH address (zero address defaults to Ethereum mainnet).
     * @param _customWETHAddresses Chain-specific alternative WETH addresses accepted in validation checks.
     */
    constructor(address _wethAddress, address[] memory _customWETHAddresses) {
        wethAddress = _wethAddress;
        for (uint256 i = 0; i < _customWETHAddresses.length; i++) {
            require(
                _customWETHAddresses[i] != address(0),
                "Zero custom WETH address"
            );
            customWETHAddresses[_customWETHAddresses[i]] = true;
        }
    }

    /**
     * @notice Queries exchange price from a liquidity pool, attempting V2 first then V3.
     * @param pair Address of the pool/pair contract.
     * @param token Address of the base token being priced.
     * @return The exchange price normalized to 18 decimals (1e18).
     */
    function getPriceFromPair(
        address pair,
        address token
    ) public view returns (uint256) {
        try this._getPriceFromV2Pair(pair, token) returns (uint256 price) {
            return price;
        } catch {
            try this._getPriceFromV3Pool(pair, token) returns (uint256 price) {
                return price;
            } catch {
                revert("PAIR");
            }
        }
    }

    /**
     * @notice Queries exchange price from Uniswap V2 Pair.
     * @dev Normalizes native token decimals differences into a standardized 18 decimal scale.
     * @param pair Address of the Uniswap V2 Pair contract.
     * @param token Address of the base token being priced.
     * @return price Exchange price in 18 decimals format.
     */
    function _getPriceFromV2Pair(
        address pair,
        address token
    ) external view returns (uint256) {
        IUniswapV2Pair p = IUniswapV2Pair(pair);
        (uint112 r0, uint112 r1, ) = p.getReserves();
        require(r0 > 0 && r1 > 0, "No liquidity");

        address token0 = p.token0();
        address token1 = p.token1();

        uint8 decimals0 = IERC20Metadata(token0).decimals();
        uint8 decimals1 = IERC20Metadata(token1).decimals();

        if (token == token0) {
            // Price = token1 / token0
            if (decimals0 == decimals1) {
                return (uint256(r1) * 1e18) / uint256(r0);
            } else if (decimals0 > decimals1) {
                uint256 adjustment = 10 ** (decimals0 - decimals1);
                return (uint256(r1) * adjustment * 1e18) / uint256(r0);
            } else {
                uint256 adjustment = 10 ** (decimals1 - decimals0);
                return (uint256(r1) * 1e18) / (uint256(r0) * adjustment);
            }
        } else if (token == token1) {
            // Price = token0 / token1
            if (decimals0 == decimals1) {
                return (uint256(r0) * 1e18) / uint256(r1);
            } else if (decimals1 > decimals0) {
                uint256 adjustment = 10 ** (decimals1 - decimals0);
                return (uint256(r0) * adjustment * 1e18) / uint256(r1);
            } else {
                uint256 adjustment = 10 ** (decimals0 - decimals1);
                return (uint256(r0) * 1e18) / (uint256(r1) * adjustment);
            }
        } else {
            revert("PAIR");
        }
    }

    /**
     * @notice Step 3 of V3 price calculation: adjusts raw ratio for token decimals differences.
     * @param rawRatioX18 The raw ratio scaled to 1e18.
     * @param decimals0 The decimals of token0.
     * @param decimals1 The decimals of token1.
     * @return Adjusted price scaled by 1e18.
     */
    function v3_step3_applyDecimals(
        uint256 rawRatioX18,
        uint8 decimals0,
        uint8 decimals1
    ) public pure returns (uint256) {
        uint256 factor0 = 10 ** uint256(decimals0);
        uint256 factor1 = 10 ** uint256(decimals1);
        return FullMath.mulDiv(rawRatioX18, factor0, factor1);
    }

    /**
     * @notice Queries exchange price from Uniswap V3 Pool.
     * @dev Processes ticks using FullMath library to compute precise pricing ratios.
     * @param pool Address of the Uniswap V3 Pool contract.
     * @param token Address of the base token being priced.
     * @return price Exchange price in 18 decimals format.
     */
    function _getPriceFromV3Pool(
        address pool,
        address token
    ) public view returns (uint256) {
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        (uint160 sqrtPriceX96, , , , , , ) = p.slot0();
        require(sqrtPriceX96 > 0, "No liquidity");

        address token0 = p.token0();
        address token1 = p.token1();

        uint8 decimals0 = IERC20Metadata(token0).decimals();
        uint8 decimals1 = IERC20Metadata(token1).decimals();

        uint256 Q96 = 2 ** 96;

        if (token == token0) {
            // Price = token1 / token0
            // Split scaling by Q192 into two Q96 steps to prevent overflow
            uint256 intermediate = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96);
            uint256 rawRatioX18 = FullMath.mulDiv(intermediate, 1e18, Q96);
            return v3_step3_applyDecimals(rawRatioX18, decimals0, decimals1);
        } else if (token == token1) {
            // Price = token0 / token1 (inverse ratio)
            // Split scaling by Q192 into two Q96 steps to prevent overflow
            uint256 intermediate = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96);
            uint256 rawInvX18 = FullMath.mulDiv(1e18, Q96, intermediate);
            return
                FullMath.mulDiv(
                    rawInvX18,
                    10 ** uint256(decimals1),
                    10 ** uint256(decimals0)
                );
        } else {
            revert("PAIR");
        }
    }

    /**
     * @notice Helper returning the token0 and token1 addresses for a pool (works on V2 and V3).
     * @param pair Pool address.
     * @return token0 Address of token0.
     * @return token1 Address of token1.
     */
    function getPairTokens(
        address pair
    ) public view returns (address token0, address token1) {
        try IUniswapV2Pair(pair).token0() returns (address t0) {
            token0 = t0;
            token1 = IUniswapV2Pair(pair).token1();
        } catch {
            token0 = IUniswapV3Pool(pair).token0();
            token1 = IUniswapV3Pool(pair).token1();
        }
    }

    /**
     * @notice Helper verifying which token in a pair corresponds to WETH.
     * @param token0 Address of token0.
     * @param token1 Address of token1.
     * @return wethToken The address corresponding to the WETH token.
     */
    function identifyWETH(
        address token0,
        address token1
    ) public view returns (address wethToken) {
        if (isWETH(token0)) {
            return token0;
        } else if (isWETH(token1)) {
            return token1;
        } else {
            revert("NO_WETH");
        }
    }

    /**
     * @notice Helper validating that stablecoinPosition represents a valid slot choice.
     * @param stablecoinPosition The position selection (1 = token0, 2 = token1).
     */
    function validateStablecoinPosition(uint8 stablecoinPosition) public pure {
        require(stablecoinPosition <= 2, "Invalid stablecoin position");
        require(stablecoinPosition > 0, "Stablecoin required");
    }

    /**
     * @notice Applies stablecoin 1:1 pricing logic to calculate exchange rate.
     * @param rawPrice The raw token pair exchange price.
     * @param token Address of the token.
     * @param token0 Address of token0 in the pair.
     * @param token1 Address of token1 in the pair.
     * @param stablecoinPosition Position code of the stablecoin.
     * @return The normalized price.
     */
    function applyStablecoinLogic(
        uint256 rawPrice,
        address token,
        address token0,
        address token1,
        uint8 stablecoinPosition
    ) public pure returns (uint256) {
        if (stablecoinPosition == 1) {
            require(token == token0 || token == token1, "PAIR");
            if (token == token0) return 1e18;
            return rawPrice;
        } else if (stablecoinPosition == 2) {
            require(token == token0 || token == token1, "PAIR");
            if (token == token1) return 1e18;
            return rawPrice;
        } else {
            revert("INV_STABLECOIN_POS");
        }
    }

    /**
     * @notice Calculates the token price in USD.
     * @dev If isEthPair is true, routes through WETH/USD intermediate exchange rate.
     * @param tokenPair Address of the token pool.
     * @param token Address of the token to price.
     * @param usdPair Intermediate WETH/USD pool address (if routing through WETH).
     * @param isEthPair True if pricing routes through WETH intermediate rate.
     * @param stablecoinPosition Slot index indicating the stablecoin's position.
     * @return The calculated price in USD.
     */
    function getPriceUSD(
        address tokenPair,
        address token,
        address usdPair,
        bool isEthPair,
        uint8 stablecoinPosition
    ) external view returns (uint256) {
        if (isEthPair) {
            uint256 priceInETH = getPriceFromPair(tokenPair, token);
            (address usdToken0, address usdToken1) = getPairTokens(usdPair);
            address wethToken = identifyWETH(usdToken0, usdToken1);

            if (token == wethToken) {
                return getPriceFromPair(usdPair, token);
            }

            uint256 ethPriceUSD = getPriceFromPair(usdPair, wethToken);
            return (priceInETH * ethPriceUSD) / 1e18;
        } else {
            address pairToUse = (usdPair != address(0)) ? usdPair : tokenPair;
            uint256 priceInUSD = getPriceFromPair(pairToUse, token);

            (address token0, address token1) = getPairTokens(pairToUse);

            validateStablecoinPosition(stablecoinPosition);
            return
                applyStablecoinLogic(
                    priceInUSD,
                    token,
                    token0,
                    token1,
                    stablecoinPosition
                );
        }
    }

    /**
     * @notice Calculations wrapper catching pricing exceptions and returning a fallback status flag.
     */
    function getPriceUSDWithFallback(
        address tokenPair,
        address token,
        address usdPair,
        bool isEthPair,
        uint8 stablecoinPosition
    ) external view returns (bool success, uint256 priceUSD) {
        try
            this.getPriceUSD(
                tokenPair,
                token,
                usdPair,
                isEthPair,
                stablecoinPosition
            )
        returns (uint256 price) {
            return (true, price);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Returns the default WETH address.
     */
    function getWETHAddress() public view returns (address) {
        if (wethAddress != address(0)) {
            return wethAddress;
        }
        return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    }

    /**
     * @notice Checks if an address corresponds to WETH.
     * @param t Address to verify.
     * @return True if address is WETH, false otherwise.
     */
    function isWETH(address t) public view returns (bool) {
        if (wethAddress != address(0) && t == wethAddress) {
            return true;
        }

        if (
            t == 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 || // Ethereum mainnet WETH
            t == 0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6 || // Goerli testnet WETH
            t == 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619 || // Polygon bridged WETH
            t == 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 || // Arbitrum WETH
            t == 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c || // BSC WBNB
            t == 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 || // Polygon WMATIC / WPOL
            t == 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7 || // Avalanche WAVAX
            t == 0x4200000000000000000000000000000000000006 || // Optimism / Base WETH
            t == 0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f || // Linea WETH
            t == 0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91 || // zkSync WETH
            t == 0x2170Ed0880ac9A755fd29B2688956BD959F933F8 || // BSC bridged WETH (Binance-Peg ETH)
            t == 0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB    // Avalanche bridged WETH (WETH.e)
        ) {
            return true;
        }

        return customWETHAddresses[t];
    }

    /**
     * @notice Validates that a pool actually contains the specified token.
     */
    function validatePairContainsToken(
        address pair,
        address token
    ) external view {
        try IUniswapV2Pair(pair).token0() returns (address token0) {
            address token1 = IUniswapV2Pair(pair).token1();
            require(token0 == token || token1 == token, "Invalid pair");
        } catch {
            address token0 = IUniswapV3Pool(pair).token0();
            address token1 = IUniswapV3Pool(pair).token1();
            require(token0 == token || token1 == token, "Invalid pair");
        }
    }

    /**
     * @notice Validates that the ETH/USD intermediate pool contains WETH.
     */
    function validateEthUsdPair(address pair) external view {
        try IUniswapV2Pair(pair).token0() returns (address token0) {
            address token1 = IUniswapV2Pair(pair).token1();
            require(isWETH(token0) || isWETH(token1), "Invalid pair");
        } catch {
            address token0 = IUniswapV3Pool(pair).token0();
            address token1 = IUniswapV3Pool(pair).token1();
            require(isWETH(token0) || isWETH(token1), "Invalid pair");
        }
    }
}
