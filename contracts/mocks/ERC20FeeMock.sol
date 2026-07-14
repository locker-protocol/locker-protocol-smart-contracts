// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ERC20FeeMock — TEST-ONLY fee-on-transfer ERC-20
 * @notice Minimal standalone ERC-20 with two independently configurable fee modes,
 *         used by the test suite to exercise fee-on-transfer / drained-balance paths
 *         (e.g. "No tokens received", "Contract balance less than lock amount",
 *         "Contract has no balance for this token" in LockerLockOperations).
 * @dev NOT for production. Fees are settable by anyone on purpose (test convenience).
 *
 *  - receiveFeeBps: portion of the transferred `amount` burned in transit — the
 *    recipient receives amount - fee (classic deflationary token). 10000 = 100%.
 *  - senderBurnBps: EXTRA fee burned from the SENDER on top of `amount` — the
 *    recipient receives the full `amount` but the sender's balance decreases by
 *    amount + fee. This lets tests drive a holder's real balance BELOW its
 *    recorded accounting (e.g. a lock's availableAmount).
 */
contract ERC20FeeMock {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Basis points of `amount` burned in transit (recipient receives less).
    uint256 public receiveFeeBps;
    /// @notice Basis points of `amount` burned ADDITIONALLY from the sender.
    uint256 public senderBurnBps;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory name_,
        string memory symbol_,
        address initialAccount,
        uint256 initialBalance
    ) {
        name = name_;
        symbol = symbol_;
        totalSupply = initialBalance;
        balanceOf[initialAccount] = initialBalance;
        emit Transfer(address(0), initialAccount, initialBalance);
    }

    function setReceiveFeeBps(uint256 bps) external {
        require(bps <= 10000, "bps>10000");
        receiveFeeBps = bps;
    }

    function setSenderBurnBps(uint256 bps) external {
        require(bps <= 10000, "bps>10000");
        senderBurnBps = bps;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ERC20FeeMock: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ERC20FeeMock: zero to");
        uint256 extraBurn = (amount * senderBurnBps) / 10000;
        uint256 transitFee = (amount * receiveFeeBps) / 10000;
        require(
            balanceOf[from] >= amount + extraBurn,
            "ERC20FeeMock: balance"
        );

        balanceOf[from] -= amount + extraBurn;
        balanceOf[to] += amount - transitFee;
        totalSupply -= (extraBurn + transitFee);

        emit Transfer(from, to, amount - transitFee);
        if (extraBurn + transitFee > 0) {
            emit Transfer(from, address(0), extraBurn + transitFee);
        }
    }
}
