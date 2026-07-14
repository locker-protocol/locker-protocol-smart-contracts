// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Locker Protocol — ERC20MockWithDecimals
 * @notice Mock ERC-20 token specifically designed to verify custom decimals validation in testing.
 * @custom:website https://lockerprotocol.com
 */
contract ERC20MockWithDecimals is ERC20 {
    /// @dev Internal custom decimal points variable.
    uint8 private _customDecimals;

    /**
     * @notice Initializes token metadata, custom decimals, and mints initial balances.
     * @param name Token name.
     * @param symbol Token symbol.
     * @param initialAccount Account receiving the minted tokens.
     * @param initialBalance Quantity of tokens to mint.
     * @param decimals_ Custom decimal points.
     */
    constructor(
        string memory name,
        string memory symbol,
        address initialAccount,
        uint256 initialBalance,
        uint8 decimals_
    ) ERC20(name, symbol) {
        _customDecimals = decimals_;
        _mint(initialAccount, initialBalance);
    }

    /**
     * @notice Returns custom token decimals.
     */
    function decimals() public view virtual override returns (uint8) {
        return _customDecimals;
    }
}

