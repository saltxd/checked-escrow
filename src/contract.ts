/**
 * CheckedEscrow contract config — supports Arc Testnet and Arc Mainnet.
 */
import artifact from '../contracts/out/CheckedEscrow.sol/CheckedEscrow.json'

export const CHECKED_ESCROW_ABI = artifact.abi

// Arc USDC ERC-20 — same address on testnet and mainnet
export const ARC_USDC_ADDRESS =
  '0x3600000000000000000000000000000000000000' as const

export const ARC_TESTNET_CHAIN_ID = 5042002
export const ARC_MAINNET_CHAIN_ID = 5042

export type Network = 'testnet' | 'mainnet'

export interface NetworkConfig {
  chainId: number
  name: string
  /** Known contract address, or null when not yet deployed/configured. */
  contractAddress: `0x${string}` | null
  explorerBase: string
  rpcUrl: string
}

const TESTNET_CONFIG: NetworkConfig = {
  chainId: ARC_TESTNET_CHAIN_ID,
  name: 'Arc Testnet',
  contractAddress: '0xbe4846d71ebd15e33b9c54684e662d346431e35e',
  explorerBase: 'https://explorer.testnet.arc.io',
  rpcUrl: 'https://rpc.testnet.arc.io',
}

// Mainnet: address comes from localStorage (user-deployed or pasted).
// We read it lazily in getNetworkConfig so the function always reflects the latest stored value.
const MAINNET_STORED_KEY = 'checkedEscrow_mainnet_address'

export function getStoredMainnetAddress(): `0x${string}` | null {
  try {
    const v = localStorage.getItem(MAINNET_STORED_KEY)
    return v && v.startsWith('0x') ? (v as `0x${string}`) : null
  } catch {
    return null
  }
}

export function setStoredMainnetAddress(addr: `0x${string}`) {
  try {
    localStorage.setItem(MAINNET_STORED_KEY, addr)
  } catch { /* ignore */ }
}

export function getNetworkConfig(network: Network): NetworkConfig {
  if (network === 'testnet') return TESTNET_CONFIG
  return {
    chainId: ARC_MAINNET_CHAIN_ID,
    name: 'Arc',
    contractAddress: getStoredMainnetAddress(),
    explorerBase: 'https://explorer.arc.io',
    rpcUrl: 'https://rpc.mainnet.arc.io',
  }
}

export const ESCROW_STATE = {
  0: 'Active',
  1: 'Released',
  2: 'Refunded',
} as const
