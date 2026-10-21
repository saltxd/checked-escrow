// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CheckedEscrow
/// @notice USDC escrow contract where a checker resolves release/refund outcomes.
contract CheckedEscrow {
    using SafeERC20 for IERC20;

    /// @notice Arc USDC token contract (6 decimals).
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);

    /// @notice Escrow lifecycle state.
    enum State {
        Active,
        Released,
        Refunded
    }

    /// @notice A single escrow record.
    /// @param buyer The account that deposited USDC.
    /// @param seller The account to be paid on release.
    /// @param amount The escrowed amount in USDC base units (6 decimals).
    /// @param deadline Unix timestamp after which buyer may self-refund.
    /// @param state Current escrow state.
    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint64 deadline;
        State state;
    }

    /// @notice Address authorized to release/refund escrows at any time.
    address public immutable checker;

    /// @notice Number of created escrows; also the next escrow id.
    uint256 public escrowCount;

    /// @notice Escrow storage by id.
    mapping(uint256 => Escrow) public escrows;

    /// @notice Pull-payment credits accumulated for each recipient.
    mapping(address => uint256) public credits;

    error ZeroAddress();
    error ZeroAmount();
    error DeadlineInPast();
    error NotChecker();
    error EscrowNotActive(uint256 id);
    error InvalidVerdict();
    error NotAuthorized();
    error NoCredits();

    /// @notice Emitted when a new escrow is funded.
    /// @param id Escrow id.
    /// @param buyer Depositing buyer.
    /// @param seller Seller to be paid on release.
    /// @param amount Escrow amount in USDC base units.
    /// @param deadline Unix timestamp after which buyer may self-refund.
    event Deposited(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint64 deadline
    );

    /// @notice Emitted when checker releases escrow to seller credits.
    /// @param id Escrow id.
    /// @param verdict Verdict string (must be "pay").
    /// @param reportUrl Checker report URL.
    event Released(uint256 indexed id, string verdict, string reportUrl);

    /// @notice Emitted when escrow is refunded to buyer credits.
    /// @param id Escrow id.
    /// @param reason Refund reason string.
    event Refunded(uint256 indexed id, string reason);

    /// @notice Emitted when an account withdraws credited USDC.
    /// @param recipient Credit recipient.
    /// @param amount Amount withdrawn in USDC base units.
    event Withdrawn(address indexed recipient, uint256 amount);

    /// @notice Initializes the escrow checker.
    /// @param checker_ Address authorized to release/refund escrows.
    constructor(address checker_) {
        if (checker_ == address(0)) revert ZeroAddress();
        checker = checker_;
    }

    /// @notice Deposits USDC into a new escrow.
    /// @param seller Seller who will receive funds on release.
    /// @param amount Amount of USDC (6 decimals) to escrow.
    /// @param deadline Unix timestamp by which seller must be approved, or buyer can self-refund after.
    /// @return id Newly created escrow id.
    function deposit(address seller, uint256 amount, uint64 deadline) external returns (uint256 id) {
        if (seller == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        USDC.safeTransferFrom(msg.sender, address(this), amount);

        id = escrowCount;
        escrowCount = id + 1;

        escrows[id] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            deadline: deadline,
            state: State.Active
        });

        emit Deposited(id, msg.sender, seller, amount, deadline);
    }

    /// @notice Releases an active escrow to seller credits.
    /// @dev Only checker may call; verdict must be exactly "pay".
    /// @param id Escrow id.
    /// @param verdict Checker verdict string.
    /// @param reportUrl Checker report URL.
    function release(uint256 id, string calldata verdict, string calldata reportUrl) external {
        if (msg.sender != checker) revert NotChecker();

        Escrow storage escrow = escrows[id];
        if (escrow.state != State.Active) revert EscrowNotActive(id);
        if (keccak256(bytes(verdict)) != keccak256(bytes("pay"))) revert InvalidVerdict();

        escrow.state = State.Released;
        credits[escrow.seller] += escrow.amount;

        emit Released(id, verdict, reportUrl);
    }

    /// @notice Refunds an active escrow to buyer credits.
    /// @dev Checker may refund at any time; buyer may refund only after deadline.
    /// @param id Escrow id.
    /// @param reason Refund reason string.
    function refund(uint256 id, string calldata reason) external {
        Escrow storage escrow = escrows[id];
        if (escrow.state != State.Active) revert EscrowNotActive(id);

        if (msg.sender != checker) {
            bool buyerAfterDeadline = msg.sender == escrow.buyer && block.timestamp > escrow.deadline;
            if (!buyerAfterDeadline) revert NotAuthorized();
        }

        escrow.state = State.Refunded;
        credits[escrow.buyer] += escrow.amount;

        emit Refunded(id, reason);
    }

    /// @notice Withdraws accumulated USDC credits for the caller.
    /// @dev Uses checks-effects-interactions by zeroing credits before transfer.
    function withdraw() external {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NoCredits();

        credits[msg.sender] = 0;
        USDC.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }
}
