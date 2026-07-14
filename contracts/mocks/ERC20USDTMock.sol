// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Locker Protocol — ERC20USDTMock
 * @notice Mock ERC-20 token simulating USDT behavior (non-standard transfer returns, special allowance mechanics).
 * @dev Specifically tests safeTransfer and safeApprove logic.
 * @custom:website https://lockerprotocol.com
 */
contract ERC20USDTMock {
    /// @notice Token name.
    string public name;
    /// @notice Token symbol.
    string public symbol;
    /// @notice Token decimals.
    uint8 public decimals;
    /// @notice Total supply of mock tokens.
    uint256 public totalSupply;
    
    /// @notice Maps account address to its token balance.
    mapping(address => uint256) public balanceOf;
    /// @notice Maps owner to spender allowed token amounts.
    mapping(address => mapping(address => uint256)) public allowance;
    
    /// @notice Emitted when tokens are transferred.
    event Transfer(address indexed from, address indexed to, uint256 value);
    /// @notice Emitted when a spender is approved.
    event Approval(address indexed owner, address indexed spender, uint256 value);
    
    /**
     * @notice Initializes token metadata and mints initial balances.
     * @param _name Token name.
     * @param _symbol Token symbol.
     * @param initialAccount Account receiving the initial tokens.
     * @param initialBalance Amount of tokens minted.
     */
    constructor(string memory _name, string memory _symbol, address initialAccount, uint256 initialBalance) {
        name = _name;
        symbol = _symbol;
        decimals = 18;
        totalSupply = initialBalance;
        balanceOf[initialAccount] = initialBalance;
        emit Transfer(address(0), initialAccount, initialBalance);
    }
    
    /**
     * @notice Transfers tokens to a recipient.
     * @dev Does not return a boolean value to mimic non-standard USDT transfer behavior.
     * @param _to Recipient address.
     * @param _value Number of tokens.
     */
    function transfer(address _to, uint256 _value) public {
        require(balanceOf[msg.sender] >= _value, "Insufficient balance");
        require(_to != address(0), "Invalid address");
        
        balanceOf[msg.sender] -= _value;
        balanceOf[_to] += _value;
        
        emit Transfer(msg.sender, _to, _value);
    }
    
    /**
     * @notice Transfers tokens from owner to recipient on behalf of owner.
     * @dev Does not return a boolean value to mimic non-standard USDT transferFrom behavior.
     * @param _from Owner address.
     * @param _to Recipient address.
     * @param _value Number of tokens.
     */
    function transferFrom(address _from, address _to, uint256 _value) public {
        require(balanceOf[_from] >= _value, "Insufficient balance");
        require(allowance[_from][msg.sender] >= _value, "Insufficient allowance");
        require(_to != address(0), "Invalid address");
        
        balanceOf[_from] -= _value;
        balanceOf[_to] += _value;
        allowance[_from][msg.sender] -= _value;
        
        emit Transfer(_from, _to, _value);
    }
    
    /**
     * @notice Approves a spender.
     * @dev Mimics USDT behaviour: reverts if trying to change allowance from non-zero to non-zero.
     * @param _spender Spender address.
     * @param _value Number of tokens.
     */
    function approve(address _spender, uint256 _value) public {
        require(_value == 0 || allowance[msg.sender][_spender] == 0, 
            "USDT: Cannot change non-zero allowance. Set to 0 first.");
        
        allowance[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
    }
    
    /**
     * @notice Mints new tokens (used for testing).
     * @param _to Recipient address.
     * @param _value Number of tokens.
     */
    function mint(address _to, uint256 _value) public {
        totalSupply += _value;
        balanceOf[_to] += _value;
        emit Transfer(address(0), _to, _value);
    }
}

