// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CheckedEscrow} from "../CheckedEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @dev Full unit-test suite for CheckedEscrow.
///
///      USDC is hardcoded in the contract as a `constant` at
///      0x3600000000000000000000000000000000000000.  We deploy a MockERC20
///      at a throwaway address, then copy its runtime bytecode onto the
///      canonical USDC address with vm.etch.  After etch the canonical
///      address has the MockERC20 code but *empty* storage (vm.etch does not
///      copy storage), so we seed all balances via mint() on the rebound handle.
contract CheckedEscrowTest is Test {
    // ── canonical Arc USDC address ─────────────────────────────────────────
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    // ── actors ─────────────────────────────────────────────────────────────
    address internal checker = makeAddr("checker");
    address internal buyer   = makeAddr("buyer");
    address internal seller  = makeAddr("seller");
    address internal stranger = makeAddr("stranger");

    // ── system under test ──────────────────────────────────────────────────
    CheckedEscrow internal escrow;
    MockERC20     internal usdc;          // handle bound to USDC_ADDR after etch

    // ── helpers ────────────────────────────────────────────────────────────
    uint256 internal constant AMOUNT   = 500e6;  // 500 USDC (6 dec)
    uint64  internal constant DEADLINE = 7 days; // relative; added to block.ts in setUp

    // ── setUp ──────────────────────────────────────────────────────────────

    function setUp() public {
        // 1. Deploy a fresh mock at a throwaway address.
        MockERC20 template = new MockERC20("Mock USDC", "mUSDC", 6);

        // 2. Copy its *runtime* bytecode onto the canonical USDC constant.
        vm.etch(USDC_ADDR, address(template).code);

        // 3. Bind the canonical address with the mock type and seed balances.
        usdc = MockERC20(USDC_ADDR);
        usdc.mint(buyer, 10_000e6);

        // 4. Deploy the contract under test — its USDC constant now has code.
        escrow = new CheckedEscrow(checker);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Approve + deposit from buyer; returns the new escrow id.
    function _deposit(uint256 amount, uint64 relDeadline) internal returns (uint256 id) {
        uint64 dl = uint64(block.timestamp) + relDeadline;
        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        id = escrow.deposit(seller, amount, dl);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1.  deposit — happy path
    // ─────────────────────────────────────────────────────────────────────────

    function test_Deposit_HappyPath() public {
        uint64 dl = uint64(block.timestamp) + DEADLINE;

        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);

        // Declare the expected Deposited event AFTER approve so the ERC-20
        // Approval event doesn't get matched instead.
        vm.expectEmit(true, true, true, true, address(escrow));
        emit CheckedEscrow.Deposited(0, buyer, seller, AMOUNT, dl);

        uint256 id = escrow.deposit(seller, AMOUNT, dl);
        vm.stopPrank();

        // id starts at 0.
        assertEq(id, 0, "first id should be 0");
        assertEq(escrow.escrowCount(), 1, "escrowCount should be 1");

        // Escrow fields.
        (
            address eBuyer,
            address eSeller,
            uint256 eAmount,
            uint64  eDeadline,
            CheckedEscrow.State eState
        ) = escrow.escrows(0);

        assertEq(eBuyer,  buyer,  "escrow.buyer mismatch");
        assertEq(eSeller, seller, "escrow.seller mismatch");
        assertEq(eAmount, AMOUNT, "escrow.amount mismatch");
        assertEq(eDeadline, dl,   "escrow.deadline mismatch");
        assertEq(uint8(eState), uint8(CheckedEscrow.State.Active), "escrow.state should be Active");

        // USDC transferred from buyer to escrow contract.
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT, "contract USDC balance mismatch");
        assertEq(usdc.balanceOf(buyer), 10_000e6 - AMOUNT, "buyer USDC balance mismatch");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2.  release — happy path (checker, verdict "pay")
    // ─────────────────────────────────────────────────────────────────────────

    function test_Release_HappyPath() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit CheckedEscrow.Released(id, "pay", "https://report.example");

        vm.prank(checker);
        escrow.release(id, "pay", "https://report.example");

        // State must be Released.
        (,,,, CheckedEscrow.State eState) = escrow.escrows(id);
        assertEq(uint8(eState), uint8(CheckedEscrow.State.Released), "state should be Released");

        // credits[seller] == AMOUNT.
        assertEq(escrow.credits(seller), AMOUNT, "seller credits mismatch");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3.  release — non-checker must revert NotChecker()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Release_NotChecker_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.prank(stranger);
        vm.expectRevert(CheckedEscrow.NotChecker.selector);
        escrow.release(id, "pay", "https://report.example");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4.  release — verdict != "pay" must revert InvalidVerdict()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Release_InvalidVerdict_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.prank(checker);
        vm.expectRevert(CheckedEscrow.InvalidVerdict.selector);
        escrow.release(id, "hold", "https://report.example");
    }

    function test_Release_EmptyVerdict_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.prank(checker);
        vm.expectRevert(CheckedEscrow.InvalidVerdict.selector);
        escrow.release(id, "", "https://report.example");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5.  double release — must revert EscrowNotActive(id)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Release_DoubleRelease_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.prank(checker);
        escrow.release(id, "pay", "https://report.example");

        // Second release on an already-Released escrow must revert.
        vm.prank(checker);
        vm.expectRevert(
            abi.encodeWithSelector(CheckedEscrow.EscrowNotActive.selector, id)
        );
        escrow.release(id, "pay", "https://report.example");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6.  refund by buyer BEFORE deadline — must revert NotAuthorized()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Refund_BuyerBeforeDeadline_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        // Still before deadline.
        vm.prank(buyer);
        vm.expectRevert(CheckedEscrow.NotAuthorized.selector);
        escrow.refund(id, "impatient buyer");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7.  refund by buyer AFTER deadline — happy path
    // ─────────────────────────────────────────────────────────────────────────

    function test_Refund_BuyerAfterDeadline_HappyPath() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        // Advance time past the deadline.
        vm.warp(block.timestamp + DEADLINE + 1);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit CheckedEscrow.Refunded(id, "expired");

        vm.prank(buyer);
        escrow.refund(id, "expired");

        (,,,, CheckedEscrow.State eState) = escrow.escrows(id);
        assertEq(uint8(eState), uint8(CheckedEscrow.State.Refunded), "state should be Refunded");

        assertEq(escrow.credits(buyer), AMOUNT, "buyer credits mismatch");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8.  refund by checker — happy path (before deadline)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Refund_ByChecker_HappyPath() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit CheckedEscrow.Refunded(id, "checker decision");

        vm.prank(checker);
        escrow.refund(id, "checker decision");

        (,,,, CheckedEscrow.State eState) = escrow.escrows(id);
        assertEq(uint8(eState), uint8(CheckedEscrow.State.Refunded), "state should be Refunded");

        assertEq(escrow.credits(buyer), AMOUNT, "buyer credits mismatch after checker refund");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9.  withdraw — happy path (seller after release)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Withdraw_SellerAfterRelease_HappyPath() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.prank(checker);
        escrow.release(id, "pay", "https://report.example");

        // Seller's pre-withdraw balance.
        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit CheckedEscrow.Withdrawn(seller, AMOUNT);

        vm.prank(seller);
        escrow.withdraw();

        // credits cleared.
        assertEq(escrow.credits(seller), 0, "seller credits should be 0 after withdraw");

        // USDC landed in seller's wallet.
        assertEq(usdc.balanceOf(seller), sellerBefore + AMOUNT, "seller USDC balance mismatch");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. withdraw with zero credits — must revert NoCredits()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Withdraw_NoCredits_Reverts() public {
        vm.prank(stranger);
        vm.expectRevert(CheckedEscrow.NoCredits.selector);
        escrow.withdraw();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 11. deposit with zero amount — must revert ZeroAmount()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Deposit_ZeroAmount_Reverts() public {
        uint64 dl = uint64(block.timestamp) + DEADLINE;
        vm.prank(buyer);
        vm.expectRevert(CheckedEscrow.ZeroAmount.selector);
        escrow.deposit(seller, 0, dl);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 12. deposit with zero seller — must revert ZeroAddress()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Deposit_ZeroSeller_Reverts() public {
        uint64 dl = uint64(block.timestamp) + DEADLINE;
        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert(CheckedEscrow.ZeroAddress.selector);
        escrow.deposit(address(0), AMOUNT, dl);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 13. deposit with deadline in past — must revert DeadlineInPast()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Deposit_DeadlineInPast_Reverts() public {
        // Warp forward so we can provide a deadline that is in the past.
        vm.warp(1_000_000);
        uint64 pastDeadline = uint64(block.timestamp) - 1;

        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert(CheckedEscrow.DeadlineInPast.selector);
        escrow.deposit(seller, AMOUNT, pastDeadline);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 14. constructor with zero checker address — must revert ZeroAddress()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Constructor_ZeroChecker_Reverts() public {
        vm.expectRevert(CheckedEscrow.ZeroAddress.selector);
        new CheckedEscrow(address(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 15. refund on already-Refunded escrow — must revert EscrowNotActive(id)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Refund_AlreadyRefunded_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.prank(checker);
        escrow.refund(id, "first refund");

        vm.prank(checker);
        vm.expectRevert(
            abi.encodeWithSelector(CheckedEscrow.EscrowNotActive.selector, id)
        );
        escrow.refund(id, "second refund");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 16. refund on Released escrow — must revert EscrowNotActive(id)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Refund_AfterRelease_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        vm.prank(checker);
        escrow.release(id, "pay", "url");

        vm.prank(checker);
        vm.expectRevert(
            abi.encodeWithSelector(CheckedEscrow.EscrowNotActive.selector, id)
        );
        escrow.refund(id, "too late");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 17. stranger cannot refund at any time — must revert NotAuthorized()
    // ─────────────────────────────────────────────────────────────────────────

    function test_Refund_Stranger_Reverts() public {
        uint256 id = _deposit(AMOUNT, DEADLINE);

        // Even after deadline, a non-buyer/non-checker should be rejected.
        vm.warp(block.timestamp + DEADLINE + 1);

        vm.prank(stranger);
        vm.expectRevert(CheckedEscrow.NotAuthorized.selector);
        escrow.refund(id, "hack attempt");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 18. multiple deposits — escrowCount increments, ids are sequential
    // ─────────────────────────────────────────────────────────────────────────

    function test_MultipleDeposits_EscrowCountIncrements() public {
        uint256 id0 = _deposit(100e6, DEADLINE);
        uint256 id1 = _deposit(200e6, DEADLINE);
        uint256 id2 = _deposit(300e6, DEADLINE);

        assertEq(id0, 0, "first id");
        assertEq(id1, 1, "second id");
        assertEq(id2, 2, "third id");
        assertEq(escrow.escrowCount(), 3, "escrowCount should be 3");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 19. credits accumulate across multiple releases before single withdraw
    // ─────────────────────────────────────────────────────────────────────────

    function test_Credits_Accumulate() public {
        uint256 id0 = _deposit(100e6, DEADLINE);
        uint256 id1 = _deposit(200e6, DEADLINE);

        vm.startPrank(checker);
        escrow.release(id0, "pay", "url0");
        escrow.release(id1, "pay", "url1");
        vm.stopPrank();

        assertEq(escrow.credits(seller), 300e6, "accumulated credits should be 300 USDC");

        vm.prank(seller);
        escrow.withdraw();

        assertEq(escrow.credits(seller), 0, "credits should be zero after withdraw");
        assertEq(usdc.balanceOf(seller), 300e6, "seller should hold 300 USDC");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 20. fuzz: deposit amount, release, withdraw — conservation of value
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_Deposit_Release_Withdraw_ConservesValue(uint256 amount) public {
        // Bound to [1, 10_000e6] to stay within seeded buyer balance.
        amount = bound(amount, 1, 10_000e6);

        usdc.mint(buyer, amount); // ensure buyer has enough regardless of prior tests

        uint256 buyerBefore   = usdc.balanceOf(buyer);
        uint256 contractBefore = usdc.balanceOf(address(escrow));
        uint256 sellerBefore  = usdc.balanceOf(seller);

        uint64 dl = uint64(block.timestamp) + DEADLINE;
        vm.startPrank(buyer);
        usdc.approve(address(escrow), amount);
        uint256 id = escrow.deposit(seller, amount, dl);
        vm.stopPrank();

        // After deposit: buyer lost `amount`, contract gained `amount`.
        assertEq(usdc.balanceOf(buyer),           buyerBefore   - amount, "buyer after deposit");
        assertEq(usdc.balanceOf(address(escrow)), contractBefore + amount, "contract after deposit");

        vm.prank(checker);
        escrow.release(id, "pay", "url");

        // After release: contract balance unchanged (credits not yet withdrawn).
        assertEq(usdc.balanceOf(address(escrow)), contractBefore + amount, "contract after release");
        assertEq(escrow.credits(seller), amount, "seller credits after release");

        vm.prank(seller);
        escrow.withdraw();

        // After withdraw: contract returned to original, seller gained `amount`.
        assertEq(usdc.balanceOf(address(escrow)), contractBefore, "contract after withdraw");
        assertEq(usdc.balanceOf(seller),          sellerBefore + amount, "seller after withdraw");
        assertEq(escrow.credits(seller),          0, "seller credits cleared");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 21. fuzz: deadline exactly at block.timestamp must revert DeadlineInPast
    // ─────────────────────────────────────────────────────────────────────────

    function testFuzz_Deposit_DeadlineAtTimestamp_Reverts(uint64 ts) public {
        ts = uint64(bound(uint256(ts), 1, type(uint64).max / 2));
        vm.warp(ts);

        vm.startPrank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.expectRevert(CheckedEscrow.DeadlineInPast.selector);
        escrow.deposit(seller, AMOUNT, ts); // deadline == block.timestamp  → revert
        vm.stopPrank();
    }
}
