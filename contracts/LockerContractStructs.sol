// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Locker Protocol — LockerContractStructs
 * @notice Shared data structures used across the Locker Protocol smart contracts.
 * @dev Structs grouped here to prevent stack-too-deep errors and ensure clean interfaces.
 * @custom:website https://lockerprotocol.com
 */

/**
 * @notice Parameters required to create a new token lock.
 * @member token The address of the ERC-20 token being locked.
 * @member amount The quantity of tokens to lock.
 * @member lockDuration The duration (in seconds) the tokens will be locked.
 * @member pair The Uniswap V2/V3 liquidity pool address for price checking.
 * @member ethUsdPair The Chainlink or Uniswap pool address for ETH/USD price checks (if applicable).
 * @member targetPriceUSD1e18 The target price in USD (with 18 decimals) required for unlocking.
 * @member isEthPair True if the token is paired with ETH, false if paired directly with a stablecoin.
 * @member stablecoinPosition The token position (0 or 1) of the stablecoin in the pool.
 * @member priceDirection The price direction rule (0 = UPSIDE, 1 = DOWNSIDE).
 * @member vestingTokensPerPeriod The number of locked tokens released per vesting period (native token units). Disabled if 0.
 * @member vestingPeriodSeconds The length of each vesting period in seconds.
 * @member vestingAccumulate True if unclaimed vesting periods accumulate (tokensPerPeriod × elapsed periods).
 */
struct CreateLockParams {
    address token;
    uint256 amount;
    uint256 lockDuration;
    address pair;
    address ethUsdPair;
    uint256 targetPriceUSD1e18;
    bool isEthPair;
    uint8 stablecoinPosition;
    uint8 priceDirection; // 0=UPSIDE, 1=DOWNSIDE
    uint256 vestingTokensPerPeriod; // Tokens released per period (native token units), 0 = disabled
    uint256 vestingPeriodSeconds; // Period duration in seconds
    bool vestingAccumulate; // true if unclaimed periods accumulate
}

/**
 * @notice Structure containing a signer's address and their signature.
 * @member signer The address of the authorized multi-sig signer.
 * @member signature The cryptographic EIP-712 signature proof.
 */
struct SignatureParams {
    address signer;
    bytes signature;
}

/**
 * @notice Parameters required for executing a multi-sig approved token unlock.
 * @member token The address of the ERC-20 token to unlock.
 * @member recipient The address receiving the unlocked tokens.
 * @member amount The number of tokens to unlock.
 * @member unlockNonce Replay protection nonce for this specific unlock operation.
 */
struct UnlockParams {
    address token;
    address recipient;
    uint256 amount;
    uint256 unlockNonce;
}

