# Checked Escrow

A check-before-you-pay USDC escrow on [Arc](https://arc.network).

1. A buyer deposits USDC for a seller, with a deadline.
2. A checker looks at the seller's address first. The app links each seller to their free [ChainWard](https://chainward.ai) report.
3. The checker either releases the money to the seller or refunds the buyer.
4. Both sides then withdraw what they are owed (pull payments).

Built with [Arc Studio](https://studio.arc.io) ([the Studio project](https://studio.arc.io/app/f5d18397-f620-47ba-a966-af6d092c8931)).

**Live app:** https://saltxd.github.io/checked-escrow/

## Contract

- **Source:** [`contracts/CheckedEscrow.sol`](contracts/CheckedEscrow.sol), Solidity 0.8.28 with OpenZeppelin.
- **Tests:** [`contracts/test`](contracts/test). They run on every push, in the [Pages workflow](.github/workflows/pages.yml).
- **Arc Testnet (chain 5042002):** [`0xbe4846d71ebd15e33b9c54684e662d346431e35e`](https://explorer.testnet.arc.io/address/0xbe4846d71ebd15e33b9c54684e662d346431e35e)
- **Arc Mainnet (chain 5042), example escrow:** [`0x2a5846a871c6221dcc156538a3a89840df5b3267`](https://explorer.arc.io/address/0x2a5846a871c6221dcc156538a3a89840df5b3267), deployed from the app on 2026-10-22, then one full deposit, release and withdraw of 0.50 USDC.
- **USDC:** `0x3600000000000000000000000000000000000000` on both Arc networks. Arc also uses USDC to pay for gas.

The app has a Testnet / Mainnet switch. On mainnet you deploy your own escrow from your connected wallet, and that wallet becomes the checker. The contract is unaudited, so use small amounts.

## Run it locally

Needs [Bun](https://bun.sh) and [Foundry](https://getfoundry.sh).

```sh
bun install
forge build
forge test
bunx vite
```
