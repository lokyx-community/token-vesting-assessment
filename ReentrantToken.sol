// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IClaimable {
    function claim() external;
}

/**
 * @dev ERC-20 that attempts to reenter `claim` on transfer to a configured attacker.
 */
contract ReentrantToken is ERC20 {
    address public vesting;
    address public attacker;
    bool public attackEnabled;

    constructor() ERC20("Reentrant", "REENT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setAttack(address vesting_, address attacker_, bool enabled) external {
        vesting = vesting_;
        attacker = attacker_;
        attackEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attackEnabled && to == attacker && vesting != address(0)) {
            attackEnabled = false;
            IClaimable(vesting).claim();
        }
    }
}
