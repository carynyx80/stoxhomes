// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test stablecoin (BSC USDT uses 18 decimals). Anyone can mint — testnet only.
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock Tether USD", "USDT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
