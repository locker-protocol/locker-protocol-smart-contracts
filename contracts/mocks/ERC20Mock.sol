// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Locker Protocol — ERC20Mock
 * @notice Mock ERC-20 token used for local testing and simulation of custom decimals.
 * @custom:website https://lockerprotocol.com
 */
contract ERC20Mock is ERC20 {
    /// @dev Internal decimal scale of the mock token.
    uint8 private _decimals;

    /**
     * @notice Initializes token metadata and mints initial balances.
     * @param name Token name.
     * @param symbol Token symbol.
     * @param initialAccount Account receiving the minted tokens.
     * @param initialBalance Quantity of tokens to mint.
     * @param decimals_ Custom decimal points.
     */
    constructor(string memory name, string memory symbol, address initialAccount, uint256 initialBalance, uint8 decimals_)
        ERC20(name, symbol)
    {
        _decimals = decimals_;
        _mint(initialAccount, initialBalance);
    }

    /**
     * @notice Returns custom token decimals.
     */
    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }
}

