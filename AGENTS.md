# Checked Escrow

> Built with Arc Studio - money-powered apps in minutes

---

## What This App Does

A "check-before-you-pay" USDC escrow on Arc. A buyer deposits USDC; a trusted checker (ChainWard) reviews the seller's address and either releases funds to the seller or refunds the buyer. Sellers and buyers withdraw via a pull-payment pattern. The "Check on ChainWard" button links to https://chainward.ai/report/<address>.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`.
- Chain: Arc Testnet (Chain ID: 5042002) — wired in `src/contract.ts`
- Token: USDC (6 decimals) at 0x3600000000000000000000000000000000000000 (same address on Arc testnet and mainnet)

## Smart Contract

**CheckedEscrow** — `contracts/CheckedEscrow.sol`

| Function | Who | Description |
|---|---|---|
| `deposit(seller, amount, deadline)` | buyer | Pulls USDC, creates escrow, returns `id` |
| `release(id, verdict, reportUrl)` | checker | Requires `verdict == "pay"`; credits seller |
| `refund(id, reason)` | checker (anytime) or buyer (after deadline) | Credits buyer |
| `withdraw()` | anyone with credits | Pull-payment; CEI pattern |

Custom errors: `ZeroAddress`, `ZeroAmount`, `DeadlineInPast`, `NotChecker`, `EscrowNotActive`, `InvalidVerdict`, `NotAuthorized`, `NoCredits`.

## Deployments

| Network | Address | Explorer |
|---|---|---|
| Arc Testnet | 0xbe4846d71ebd15e33b9c54684e662d346431e35e | https://explorer.testnet.arc.io/address/0xbe4846d71ebd15e33b9c54684e662d346431e35e |
| Arc Mainnet | (deploy yourself — see below) | — |

**Constructor arg:** `address checker_` — the checker's wallet address. On testnet this is the platform deployer (0x5B12Ce46C7194aD57d143bC22847224047b1Ef42). On mainnet, pass your own checker address.

## Deploying to Arc Mainnet

1. Review `contracts/CheckedEscrow.sol` and the security review summary in `docs/` (if present).
2. Obtain an independent audit if required.
3. Deploy from your own wallet:
   ```
   forge create contracts/CheckedEscrow.sol:CheckedEscrow \
     --constructor-args <YOUR_CHECKER_ADDRESS> \
     --rpc-url https://rpc.mainnet.arc.io \
     --private-key <YOUR_PRIVATE_KEY>
   ```
4. Update `src/contract.ts`: change `CHECKED_ESCROW_ADDRESS` and `TARGET_CHAIN_ID` (5042 for mainnet).

## Pointing the App at Mainnet

Edit `src/contract.ts`:
```ts
export const CHECKED_ESCROW_ADDRESS = '<YOUR_MAINNET_ADDRESS>' as const
export const TARGET_CHAIN_ID = 5042  // Arc mainnet
```
Also update `src/config.ts` to include the Arc mainnet chain if needed.

## Key Files

- `contracts/CheckedEscrow.sol` — contract source
- `contracts/test/CheckedEscrow.t.sol` — 22 unit tests (all passing)
- `contracts/test-helpers/MockERC20.sol` — test mock
- `contracts/contract-metadata/CheckedEscrow.json` — deployment metadata
- `src/contract.ts` — ABI + address config
- `src/App.tsx` — full single-page app
