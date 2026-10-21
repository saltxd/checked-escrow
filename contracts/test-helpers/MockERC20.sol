// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal mintable ERC-20 used as a USDC stand-in in tests.
///      Deployed at a throwaway address and then etched onto the canonical
///      USDC address (0x3600…) via vm.etch so the contract-under-test's
///      hardcoded constant resolves to this bytecode.
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @dev Freely mintable — tests call this after etching to seed balances.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
