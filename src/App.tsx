import { useState, useEffect, useCallback, useRef } from 'react'
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useSwitchChain,
  usePublicClient,
  useDeployContract,
} from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { erc20Abi, parseUnits, formatUnits, isAddress } from 'viem'
import type { Log } from 'viem'
import {
  ExternalLink, Shield, RotateCcw,
  CheckCircle, AlertCircle, Loader2,
  Rocket, ClipboardCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  CHECKED_ESCROW_ABI,
  ARC_USDC_ADDRESS,
  ARC_MAINNET_CHAIN_ID,
  type Network,
  type NetworkConfig,
  getNetworkConfig,
  setStoredMainnetAddress,
} from './contract'
import { buildTxExplorerUrl } from './onchain-facts'
import artifact from '../contracts/out/CheckedEscrow.sol/CheckedEscrow.json'

// ─── Types ────────────────────────────────────────────────────────────────────

type EscrowState = 0 | 1 | 2

interface EscrowRecord {
  id: bigint
  buyer: string
  seller: string
  amount: bigint
  deadline: bigint
  state: EscrowState
  verdict?: string
  reportUrl?: string
}

interface ActivityEvent {
  type: 'Deposited' | 'Released' | 'Refunded'
  id: bigint
  txHash: string
  blockNumber: bigint
  extra?: string
}

type RawReleasedLog = Log & { args: { id: bigint; verdict: string; reportUrl: string } }
type RawDepositedLog = Log & { args: { id: bigint; buyer: string; seller: string; amount: bigint; deadline: bigint } }
type RawRefundedLog = Log & { args: { id: bigint; reason: string } }

// ─── Glass helpers ────────────────────────────────────────────────────────────

const glass = {
  card: {
    background: 'rgba(255,255,255,0.72)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    border: '1px solid rgba(18,45,69,0.1)',
    borderRadius: '1.5rem',
  },
  inner: {
    background: 'rgba(18,45,69,0.04)',
    border: '1px solid rgba(18,45,69,0.08)',
    borderRadius: '1rem',
  },
} as const

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtUsdc(raw: bigint) {
  return parseFloat(formatUnits(raw, 6)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function fmtDeadline(ts: bigint) {
  return new Date(Number(ts) * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function stateLabel(s: EscrowState) {
  return s === 0 ? 'Active' : s === 1 ? 'Released' : 'Refunded'
}

function stateColor(s: EscrowState) {
  return s === 0 ? 'var(--muted)' : s === 1 ? 'var(--success)' : 'var(--danger)'
}

function parseOnchainError(e: unknown): string {
  const msg = (e as { message?: string })?.message?.toLowerCase() ?? ''
  if (msg.includes('user rejected') || msg.includes('4001')) return 'Transaction cancelled.'
  if (msg.includes('notchecker')) return 'Only the checker can do that.'
  if (msg.includes('escrownotactive')) return 'This escrow is no longer active.'
  if (msg.includes('invalidverdict')) return 'Verdict must be "pay".'
  if (msg.includes('notauthorized')) return 'Not authorised. Buyer may only refund after the deadline.'
  if (msg.includes('nocredits')) return 'No credits to withdraw.'
  if (msg.includes('zeroaddress')) return 'Address cannot be zero.'
  if (msg.includes('zeroamount')) return 'Amount cannot be zero.'
  if (msg.includes('deadlineinpast')) return 'Deadline must be in the future.'
  if (msg.includes('insufficient')) return 'Insufficient USDC balance or allowance.'
  if (msg.includes('reverted')) return 'Transaction reverted. Check your inputs.'
  return 'Something went wrong. Please try again.'
}

function explorerAddr(cfg: NetworkConfig, addr: string) {
  return `${cfg.explorerBase}/address/${addr}`
}

// ─── TxButton ─────────────────────────────────────────────────────────────────

function TxButton({
  label,
  disabled,
  onClick,
  isPending,
  isConfirming,
  wrongChain,
  onSwitch,
  networkName,
  variant = 'primary',
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  isPending?: boolean
  isConfirming?: boolean
  wrongChain?: boolean
  onSwitch?: () => void
  networkName?: string
  variant?: 'primary' | 'ghost' | 'danger'
}) {
  const base = 'w-full rounded-2xl py-3 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 flex items-center justify-center gap-2'

  if (wrongChain) {
    return (
      <button
        className={base}
        style={{ background: 'var(--accent)', color: '#fff' }}
        onClick={onSwitch}
      >
        Switch to {networkName ?? 'Arc'}
      </button>
    )
  }

  const styleProp =
    variant === 'primary' ? { background: 'var(--accent)', color: '#fff' }
    : variant === 'danger' ? { background: 'var(--danger)', color: '#fff' }
    : { background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--ink)' }

  return (
    <button
      className={base}
      style={styleProp}
      disabled={(disabled ?? false) || (isPending ?? false) || (isConfirming ?? false)}
      onClick={onClick}
    >
      {isPending ? (
        <><Loader2 className="size-4 animate-spin" /> Confirm in wallet...</>
      ) : isConfirming ? (
        <><Loader2 className="size-4 animate-spin" /> Confirming...</>
      ) : label}
    </button>
  )
}

// ─── Network Toggle ───────────────────────────────────────────────────────────

function NetworkToggle({
  network,
  onChange,
}: {
  network: Network
  onChange: (n: Network) => void
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-xl p-0.5"
      style={{ background: 'rgba(18,45,69,0.06)', border: '1px solid var(--border)' }}
    >
      {(['testnet', 'mainnet'] as Network[]).map(n => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className="rounded-[10px] px-3 py-1.5 text-xs font-semibold transition-all"
          style={
            network === n
              ? { background: 'var(--accent)', color: '#fff' }
              : { background: 'transparent', color: 'var(--muted)' }
          }
        >
          {n === 'testnet' ? 'Testnet' : 'Mainnet'}
        </button>
      ))}
    </div>
  )
}

// ─── Deploy / Configure Panel (mainnet, no contract yet) ─────────────────────

function MainnetSetupPanel({
  onConfigured,
}: {
  onConfigured: (addr: `0x${string}`) => void
}) {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = chainId !== ARC_MAINNET_CHAIN_ID

  const [pasteAddr, setPasteAddr] = useState('')
  const pasteValid = isAddress(pasteAddr)

  // Deploy via wagmi deployContract
  const { deployContract, data: deployHash, isPending: deployPending, error: deployError } = useDeployContract()
  const { isLoading: deployConfirming, isSuccess: deploySuccess, data: receipt } = useWaitForTransactionReceipt({ hash: deployHash })

  // Once deploy receipt arrives, save the address
  const deployDoneRef = useRef<string | undefined>()
  useEffect(() => {
    if (deploySuccess && receipt?.contractAddress && deployDoneRef.current !== deployHash) {
      deployDoneRef.current = deployHash
      const addr = receipt.contractAddress
      setStoredMainnetAddress(addr)
      onConfigured(addr)
      toast.success('Contract deployed on Arc mainnet.')
    }
  }, [deploySuccess, receipt, deployHash, onConfigured])

  useEffect(() => {
    if (deployError) toast.error(parseOnchainError(deployError))
  }, [deployError])

  function handleDeploy() {
    if (!address) return
    deployContract({
      abi: CHECKED_ESCROW_ABI,
      bytecode: artifact.bytecode.object as `0x${string}`,
      args: [address],
    })
  }

  function handlePaste() {
    if (!pasteValid) return
    const addr = pasteAddr
    setStoredMainnetAddress(addr)
    onConfigured(addr)
  }

  return (
    <section className="p-5 space-y-4" style={{ ...glass.card, border: '1.5px solid rgba(18,45,69,0.18)' }}>
      <div className="flex items-center gap-2">
        <Rocket className="size-4 shrink-0" style={{ color: 'var(--accent)' }} />
        <h2 className="display text-base font-semibold" style={{ color: 'var(--ink)' }}>
          Set up on Arc mainnet
        </h2>
      </div>

      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        You need a CheckedEscrow contract on Arc mainnet. Deploy one now from
        your connected wallet (you become the checker), or paste an existing address.
      </p>

      {/* Deploy */}
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--subtle)' }}>
          Deploy new contract
        </div>
        {address && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Your address will be set as the checker:{' '}
            <span className="mono" style={{ color: 'var(--ink)' }}>{fmtAddr(address)}</span>
          </p>
        )}
        <TxButton
          label="Deploy CheckedEscrow"
          onClick={handleDeploy}
          isPending={deployPending}
          isConfirming={deployConfirming}
          wrongChain={wrongChain}
          onSwitch={() => switchChain({ chainId: ARC_MAINNET_CHAIN_ID })}
          networkName="Arc"
          disabled={!address}
        />
        {deployHash && (
          <a
            href={`https://explorer.arc.io/tx/${deployHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs underline"
            style={{ color: 'var(--accent-hover)' }}
          >
            View deploy tx <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
        <span className="text-xs" style={{ color: 'var(--subtle)' }}>or</span>
        <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
      </div>

      {/* Paste existing */}
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--subtle)' }}>
          Use existing contract
        </div>
        <input
          value={pasteAddr}
          onChange={e => setPasteAddr(e.target.value)}
          placeholder="0x..."
          className="mono w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2"
          style={{
            background: 'rgba(18,45,69,0.03)',
            borderColor: pasteAddr && !pasteValid ? 'var(--danger)' : 'var(--border)',
            color: 'var(--ink)',
          }}
        />
        <button
          disabled={!pasteValid}
          onClick={handlePaste}
          className="flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--surface-muted)', color: 'var(--ink)' }}
        >
          <ClipboardCheck className="size-4" /> Use this address
        </button>
      </div>
    </section>
  )
}

// ─── Deposit Panel ─────────────────────────────────────────────────────────────

function DepositPanel({
  cfg,
  checkerAddress,
}: {
  cfg: NetworkConfig
  checkerAddress: string
}) {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = chainId !== cfg.chainId

  const contractAddress = cfg.contractAddress!

  const [seller, setSeller] = useState('')
  const [amount, setAmount] = useState('')
  const [hours, setHours] = useState('')

  const { writeContract: approve, data: approveHash, isPending: approvePending } = useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })

  const { writeContract: doDeposit, data: depositHash, isPending: depositPending, error: depositError } = useWriteContract()
  const { isLoading: depositConfirming, isSuccess: depositSuccess } = useWaitForTransactionReceipt({ hash: depositHash })

  const { data: allowanceRaw, refetch: refetchAllowance } = useReadContract({
    address: ARC_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address ?? '0x0000000000000000000000000000000000000000', contractAddress],
    chainId: cfg.chainId,
  })
  const allowance = allowanceRaw

  const { data: usdcBalanceRaw } = useReadContract({
    address: ARC_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: cfg.chainId,
  })
  const usdcBalance = usdcBalanceRaw

  const approveRef = useRef<string | undefined>()
  useEffect(() => {
    if (approveSuccess && approveHash && approveRef.current !== approveHash) {
      approveRef.current = approveHash
      void refetchAllowance()
    }
  }, [approveSuccess, approveHash, refetchAllowance])

  const depositRef = useRef<string | undefined>()
  useEffect(() => {
    if (depositSuccess && depositHash && depositRef.current !== depositHash) {
      depositRef.current = depositHash
      toast.success('Escrow created.')
      setSeller('')
      setAmount('')
      setHours('')
    }
  }, [depositSuccess, depositHash])

  useEffect(() => {
    if (depositError) toast.error(parseOnchainError(depositError))
  }, [depositError])

  const parsedAmount = amount ? parseUnits(amount, 6) : 0n
  const hasEnoughAllowance = allowance !== undefined && allowance >= parsedAmount && parsedAmount > 0n
  const valid = isAddress(seller) && parsedAmount > 0n && Number(hours) > 0
  // Stable "now" for deadline preview — initialised once per mount, never read during re-render from impure source.
  const [mountedAt] = useState(() => Math.floor(Date.now() / 1000))

  function handleApprove() {
    approve({
      address: ARC_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'approve',
      args: [contractAddress, parsedAmount],
    })
  }

  function handleDeposit() {
    if (!valid) return
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + Math.round(parseFloat(hours) * 3600))
    doDeposit({
      address: contractAddress,
      abi: CHECKED_ESCROW_ABI,
      functionName: 'deposit',
      args: [seller, parsedAmount, deadlineTs],
    })
  }

  return (
    <section className="p-5" style={glass.card}>
      <h2 className="display mb-4 text-base font-semibold" style={{ color: 'var(--ink)' }}>
        Pay a seller
      </h2>

      {/* Seller row */}
      <div className="mb-3">
        <label className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--muted)' }}>
          Seller address
        </label>
        <div className="flex items-center gap-2">
          <input
            value={seller}
            onChange={e => setSeller(e.target.value)}
            placeholder="0x..."
            className="mono flex-1 rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2"
            style={{
              background: 'rgba(18,45,69,0.03)',
              borderColor: seller && !isAddress(seller) ? 'var(--danger)' : 'var(--border)',
              color: 'var(--ink)',
            }}
          />
          {isAddress(seller) && (
            <a
              href={`https://chainward.ai/report/${seller}`}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 flex items-center gap-1 rounded-xl px-3 py-2.5 text-xs font-semibold"
              style={{ background: 'rgba(18,45,69,0.06)', color: 'var(--accent)', border: '1px solid var(--border)' }}
              title="Check this address on ChainWard"
            >
              <Shield className="size-3.5" /> ChainWard
            </a>
          )}
        </div>
        {checkerAddress && isAddress(checkerAddress) && (
          <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
            Checker: <span className="mono">{fmtAddr(checkerAddress)}</span>
          </p>
        )}
      </div>

      {/* Amount */}
      <div className="mb-3" style={glass.inner}>
        <div className="p-4">
          <input
            inputMode="decimal"
            value={amount}
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v)
            }}
            placeholder="0.00"
            className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-300"
            style={{ color: 'var(--ink)' }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--subtle)' }}>USDC</span>
            {usdcBalance !== undefined && (
              <button
                onClick={() => setAmount(formatUnits(usdcBalance, 6))}
                className="text-xs font-semibold"
                style={{ color: 'var(--accent-hover)' }}
              >
                Balance: {fmtUsdc(usdcBalance)} · Max
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hours */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--muted)' }}>
          Deadline (hours from now)
        </label>
        <input
          inputMode="numeric"
          value={hours}
          onChange={e => setHours(e.target.value.replace(/\D/g, ''))}
          placeholder="e.g. 72"
          className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2"
          style={{ background: 'rgba(18,45,69,0.03)', borderColor: 'var(--border)', color: 'var(--ink)' }}
        />
        {Number(hours) > 0 && (
          <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
            Expires {fmtDeadline(BigInt(mountedAt + Number(hours) * 3600))}
          </p>
        )}
      </div>

      {/* Step buttons */}
      {!hasEnoughAllowance ? (
        <TxButton
          label={`Approve ${amount || '0'} USDC`}
          onClick={handleApprove}
          isPending={approvePending}
          isConfirming={approveConfirming}
          wrongChain={wrongChain}
          onSwitch={() => switchChain({ chainId: cfg.chainId })}
          networkName={cfg.name}
          disabled={!valid}
        />
      ) : (
        <TxButton
          label="Deposit into escrow"
          onClick={handleDeposit}
          isPending={depositPending}
          isConfirming={depositConfirming}
          wrongChain={wrongChain}
          onSwitch={() => switchChain({ chainId: cfg.chainId })}
          networkName={cfg.name}
          disabled={!valid}
        />
      )}

      {depositHash && depositSuccess && (
        <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--success)' }}>
          <CheckCircle className="size-3.5" /> Escrow created.
          <a
            href={buildTxExplorerUrl(cfg.chainId, depositHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline flex items-center gap-0.5"
          >
            Explorer <ExternalLink className="size-2.5" />
          </a>
        </div>
      )}
    </section>
  )
}

// ─── Escrow Card ──────────────────────────────────────────────────────────────

function EscrowCard({
  escrow,
  isChecker,
  connectedAddress,
  nowSec,
  cfg,
}: {
  escrow: EscrowRecord
  isChecker: boolean
  connectedAddress: string
  nowSec: bigint
  cfg: NetworkConfig
}) {
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = chainId !== cfg.chainId

  const contractAddress = cfg.contractAddress!

  const [releaseUrl, setReleaseUrl] = useState('')
  const [refundReason, setRefundReason] = useState('hold: flagged by ChainWard')

  const { writeContract: doRelease, data: releaseHash, isPending: releasePending, error: releaseError } = useWriteContract()
  const { isLoading: releaseConfirming, isSuccess: releaseSuccess } = useWaitForTransactionReceipt({ hash: releaseHash })

  const { writeContract: doRefund, data: refundHash, isPending: refundPending, error: refundError } = useWriteContract()
  const { isLoading: refundConfirming, isSuccess: refundSuccess } = useWaitForTransactionReceipt({ hash: refundHash })

  const releaseRef = useRef<string | undefined>()
  useEffect(() => {
    if (releaseHash && releaseSuccess && releaseRef.current !== releaseHash) {
      releaseRef.current = releaseHash
      toast.success(`Escrow #${escrow.id.toString()} released.`)
    }
  }, [releaseHash, releaseSuccess, escrow.id])

  const refundRef = useRef<string | undefined>()
  useEffect(() => {
    if (refundHash && refundSuccess && refundRef.current !== refundHash) {
      refundRef.current = refundHash
      toast.success(`Escrow #${escrow.id.toString()} refunded.`)
    }
  }, [refundHash, refundSuccess, escrow.id])

  useEffect(() => {
    if (releaseError) toast.error(parseOnchainError(releaseError))
  }, [releaseError])

  useEffect(() => {
    if (refundError) toast.error(parseOnchainError(refundError))
  }, [refundError])

  const pastDeadline = nowSec > escrow.deadline
  const isBuyer = connectedAddress.toLowerCase() === escrow.buyer.toLowerCase()
  const canRefundAsUser = isBuyer && pastDeadline && escrow.state === 0

  const stateChip = (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ background: `color-mix(in srgb, ${stateColor(escrow.state)} 12%, transparent)`, color: stateColor(escrow.state) }}
    >
      {stateLabel(escrow.state)}
    </span>
  )

  return (
    <div className="rounded-2xl p-4 space-y-3" style={glass.inner}>
      {/* Header row */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
          #{escrow.id.toString()}
        </span>
        {stateChip}
        <span className="display text-sm font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
          {fmtUsdc(escrow.amount)} USDC
        </span>
      </div>

      {/* Buyer / seller */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div style={{ color: 'var(--subtle)' }}>Buyer</div>
          <a
            href={explorerAddr(cfg, escrow.buyer)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono underline"
            style={{ color: 'var(--ink-2)' }}
          >
            {fmtAddr(escrow.buyer)}
          </a>
        </div>
        <div>
          <div style={{ color: 'var(--subtle)' }}>Seller</div>
          <div className="flex items-center gap-1">
            <a
              href={explorerAddr(cfg, escrow.seller)}
              target="_blank"
              rel="noopener noreferrer"
              className="mono underline"
              style={{ color: 'var(--ink-2)' }}
            >
              {fmtAddr(escrow.seller)}
            </a>
            <a
              href={`https://chainward.ai/report/${escrow.seller}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Check on ChainWard"
              style={{ color: 'var(--muted)' }}
            >
              <Shield className="size-3" />
            </a>
          </div>
        </div>
      </div>

      {/* Deadline */}
      <div className="text-xs" style={{ color: 'var(--subtle)' }}>
        Deadline: {fmtDeadline(escrow.deadline)}
        {pastDeadline && escrow.state === 0 && (
          <span className="ml-1" style={{ color: 'var(--danger)' }}>(expired)</span>
        )}
      </div>

      {/* Verdict (if released) */}
      {escrow.state === 1 && escrow.verdict && (
        <div className="text-xs space-y-0.5">
          <div style={{ color: 'var(--success)' }}>Verdict: {escrow.verdict}</div>
          {escrow.reportUrl && (
            <a
              href={escrow.reportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline flex items-center gap-1"
              style={{ color: 'var(--muted)' }}
            >
              View report <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}

      {/* Checker actions */}
      {isChecker && escrow.state === 0 && (
        <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Checker actions</div>
          <input
            value={releaseUrl}
            onChange={e => setReleaseUrl(e.target.value)}
            placeholder="Report URL (optional)"
            className="w-full rounded-xl border px-3 py-2 text-xs outline-none"
            style={{ background: 'rgba(18,45,69,0.03)', borderColor: 'var(--border)', color: 'var(--ink)' }}
          />
          <div className="grid grid-cols-2 gap-2">
            <TxButton
              label="Release (pay)"
              onClick={() => doRelease({
                address: contractAddress,
                abi: CHECKED_ESCROW_ABI,
                functionName: 'release',
                args: [escrow.id, 'pay', releaseUrl],
              })}
              isPending={releasePending}
              isConfirming={releaseConfirming}
              wrongChain={wrongChain}
              onSwitch={() => switchChain({ chainId: cfg.chainId })}
              networkName={cfg.name}
            />
            <TxButton
              label="Refund"
              variant="danger"
              onClick={() => doRefund({
                address: contractAddress,
                abi: CHECKED_ESCROW_ABI,
                functionName: 'refund',
                args: [escrow.id, refundReason],
              })}
              isPending={refundPending}
              isConfirming={refundConfirming}
              wrongChain={wrongChain}
              onSwitch={() => switchChain({ chainId: cfg.chainId })}
              networkName={cfg.name}
            />
          </div>
          <input
            value={refundReason}
            onChange={e => setRefundReason(e.target.value)}
            placeholder="Refund reason"
            className="w-full rounded-xl border px-3 py-2 text-xs outline-none"
            style={{ background: 'rgba(18,45,69,0.03)', borderColor: 'var(--border)', color: 'var(--ink)' }}
          />
          {releaseSuccess && releaseHash && (
            <a href={buildTxExplorerUrl(cfg.chainId, releaseHash)} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs underline" style={{ color: 'var(--success)' }}>
              Released. Explorer <ExternalLink className="size-3" />
            </a>
          )}
          {refundSuccess && refundHash && (
            <a href={buildTxExplorerUrl(cfg.chainId, refundHash)} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs underline" style={{ color: 'var(--danger)' }}>
              Refunded. Explorer <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}

      {/* Buyer self-refund after deadline */}
      {!isChecker && canRefundAsUser && (
        <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <TxButton
            label="Self-refund (deadline passed)"
            variant="ghost"
            onClick={() => doRefund({
              address: contractAddress,
              abi: CHECKED_ESCROW_ABI,
              functionName: 'refund',
              args: [escrow.id, 'buyer self-refund after deadline'],
            })}
            isPending={refundPending}
            isConfirming={refundConfirming}
            wrongChain={wrongChain}
            onSwitch={() => switchChain({ chainId: cfg.chainId })}
            networkName={cfg.name}
          />
        </div>
      )}
    </div>
  )
}

// ─── My Escrows ───────────────────────────────────────────────────────────────

function MyEscrowsPanel({
  address,
  checkerAddress,
  cfg,
}: {
  address: string
  checkerAddress: string
  cfg: NetworkConfig
}) {
  const [escrows, setEscrows] = useState<EscrowRecord[]>([])
  const [loading, setLoading] = useState(false)
  const client = usePublicClient({ chainId: cfg.chainId })
  const { chainId } = useAccount()
  const isChecker = address.toLowerCase() === checkerAddress.toLowerCase()

  const contractAddress = cfg.contractAddress!

  const loadEscrows = useCallback(async () => {
    if (!client) return
    setLoading(true)
    const records: EscrowRecord[] = []
    try {
      const count = await client.readContract({
        address: contractAddress,
        abi: CHECKED_ESCROW_ABI,
        functionName: 'escrowCount',
      }) as bigint

      for (let i = 0n; i < count; i++) {
        const raw = await client.readContract({
          address: contractAddress,
          abi: CHECKED_ESCROW_ABI,
          functionName: 'escrows',
          args: [i],
        }) as [string, string, bigint, bigint, number]

        const [buyer, seller, amount, deadline, state] = raw
        const relevant = isChecker
          || buyer.toLowerCase() === address.toLowerCase()
          || seller.toLowerCase() === address.toLowerCase()
        if (!relevant) continue

        const record: EscrowRecord = {
          id: i, buyer, seller, amount, deadline,
          state: state as EscrowState,
        }

        if (state === 1) {
          try {
            const logs = (await client.getContractEvents({
              address: contractAddress,
              abi: CHECKED_ESCROW_ABI,
              eventName: 'Released',
              fromBlock: 0n,
            })) as RawReleasedLog[]
            const hit = logs.find(l => l.args.id === i)
            if (hit) {
              record.verdict = hit.args.verdict
              record.reportUrl = hit.args.reportUrl
            }
          } catch { /* log unavailable */ }
        }

        records.push(record)
      }
    } catch (e) {
      console.error(e)
    }
    setEscrows(records.reverse())
    setLoading(false)
  }, [client, address, isChecker, contractAddress])

  const lastChainId = useRef<number | undefined>()
  useEffect(() => {
    if (lastChainId.current === chainId) return
    lastChainId.current = chainId
    void loadEscrows()
  }, [chainId, loadEscrows])

  const active = escrows.filter(e => e.state === 0)
  const resolved = escrows.filter(e => e.state !== 0)
  const [nowSec] = useState(() => BigInt(Math.floor(Date.now() / 1000)))

  return (
    <section className="p-5" style={glass.card}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="display text-base font-semibold" style={{ color: 'var(--ink)' }}>
          {isChecker ? 'Pending escrows (checker view)' : 'Your escrows'}
        </h2>
        <button
          onClick={() => void loadEscrows()}
          className="rounded-xl p-2 transition-opacity hover:opacity-70"
          style={glass.inner}
          title="Refresh"
        >
          <RotateCcw
            className={`size-3.5${loading ? ' animate-spin' : ''}`}
            style={{ color: 'var(--muted)' }}
          />
        </button>
      </div>

      {loading && escrows.length === 0 && (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
          <Loader2 className="size-4 animate-spin" /> Loading...
        </div>
      )}
      {!loading && escrows.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--subtle)' }}>
          No escrows found for your address.
        </p>
      )}

      {active.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
            Active
          </h3>
          {active.map(e => (
            <EscrowCard
              key={e.id.toString()}
              escrow={e}
              isChecker={isChecker}
              connectedAddress={address}
              nowSec={nowSec}
              cfg={cfg}
            />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className={`space-y-3${active.length > 0 ? ' mt-5' : ''}`}>
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
            Resolved
          </h3>
          {resolved.map(e => (
            <EscrowCard
              key={e.id.toString()}
              escrow={e}
              isChecker={isChecker}
              connectedAddress={address}
              nowSec={nowSec}
              cfg={cfg}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ─── Withdraw Panel ────────────────────────────────────────────────────────────

function WithdrawPanel({ address, cfg }: { address: string; cfg: NetworkConfig }) {
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const wrongChain = chainId !== cfg.chainId

  const contractAddress = cfg.contractAddress!

  const { data: creditsRaw } = useReadContract({
    address: contractAddress,
    abi: CHECKED_ESCROW_ABI,
    functionName: 'credits',
    args: [address as `0x${string}`],
    chainId: cfg.chainId,
  })
  const credits = creditsRaw as bigint | undefined

  const { writeContract: doWithdraw, data: withdrawHash, isPending, error } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: withdrawHash })

  useEffect(() => {
    if (error) toast.error(parseOnchainError(error))
  }, [error])

  if (!credits || credits === 0n) return null

  return (
    <section className="p-5" style={{ ...glass.card, border: '1.5px solid rgba(26,128,71,0.25)' }}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-xs font-semibold" style={{ color: 'var(--success)' }}>Credits available</div>
          <div className="display mt-0.5 text-2xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {fmtUsdc(credits)} USDC
          </div>
        </div>
        <div className="w-40 shrink-0">
          <TxButton
            label="Withdraw"
            onClick={() => doWithdraw({ address: contractAddress, abi: CHECKED_ESCROW_ABI, functionName: 'withdraw' })}
            isPending={isPending}
            isConfirming={isConfirming}
            wrongChain={wrongChain}
            onSwitch={() => switchChain({ chainId: cfg.chainId })}
            networkName={cfg.name}
          />
        </div>
      </div>
      {isSuccess && withdrawHash && (
        <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--success)' }}>
          <CheckCircle className="size-3.5" /> Withdrawn.
          <a href={buildTxExplorerUrl(cfg.chainId, withdrawHash)} target="_blank" rel="noopener noreferrer"
            className="underline flex items-center gap-0.5">
            Explorer <ExternalLink className="size-2.5" />
          </a>
        </div>
      )}
    </section>
  )
}

// ─── Activity Feed ────────────────────────────────────────────────────────────

function ActivityFeed({ cfg }: { cfg: NetworkConfig }) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const client = usePublicClient({ chainId: cfg.chainId })

  const contractAddress = cfg.contractAddress!

  const loadActivity = useCallback(async () => {
    if (!client) return
    setLoading(true)
    try {
      const [deposited, released, refunded] = await Promise.all([
        client.getContractEvents({ address: contractAddress, abi: CHECKED_ESCROW_ABI, eventName: 'Deposited', fromBlock: 0n }),
        client.getContractEvents({ address: contractAddress, abi: CHECKED_ESCROW_ABI, eventName: 'Released', fromBlock: 0n }),
        client.getContractEvents({ address: contractAddress, abi: CHECKED_ESCROW_ABI, eventName: 'Refunded', fromBlock: 0n }),
      ])

      const mapped: ActivityEvent[] = [
        ...(deposited as RawDepositedLog[]).map(l => ({
          type: 'Deposited' as const,
          id: l.args.id,
          txHash: l.transactionHash ?? '',
          blockNumber: l.blockNumber ?? 0n,
          extra: `${fmtUsdc(l.args.amount)} USDC`,
        })),
        ...(released as RawReleasedLog[]).map(l => ({
          type: 'Released' as const,
          id: l.args.id,
          txHash: l.transactionHash ?? '',
          blockNumber: l.blockNumber ?? 0n,
          extra: l.args.verdict,
        })),
        ...(refunded as RawRefundedLog[]).map(l => ({
          type: 'Refunded' as const,
          id: l.args.id,
          txHash: l.transactionHash ?? '',
          blockNumber: l.blockNumber ?? 0n,
          extra: l.args.reason,
        })),
      ]

      mapped.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1))
      setEvents(mapped.slice(0, 30))
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }, [client, contractAddress])

  const lastContract = useRef<string | undefined>()
  useEffect(() => {
    if (lastContract.current === contractAddress) return
    lastContract.current = contractAddress
    void loadActivity()
  }, [contractAddress, loadActivity])

  const typeStyle: Record<string, { color: string; icon: React.ReactNode }> = {
    Deposited: { color: 'var(--accent-hover)', icon: <AlertCircle className="size-3.5" /> },
    Released: { color: 'var(--success)', icon: <CheckCircle className="size-3.5" /> },
    Refunded: { color: 'var(--danger)', icon: <AlertCircle className="size-3.5" /> },
  }

  return (
    <section className="p-5" style={glass.card}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="display text-base font-semibold" style={{ color: 'var(--ink)' }}>Activity</h2>
        <button onClick={() => void loadActivity()} className="rounded-xl p-2" style={glass.inner} title="Refresh">
          <RotateCcw
            className={`size-3.5${loading ? ' animate-spin' : ''}`}
            style={{ color: 'var(--muted)' }}
          />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
          <Loader2 className="size-4 animate-spin" /> Loading events...
        </div>
      )}
      {!loading && events.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--subtle)' }}>No activity yet.</p>
      )}

      <div className="space-y-2">
        {events.map((ev, i) => {
          const s = typeStyle[ev.type]
          return (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5"
              style={glass.inner}
            >
              <span style={{ color: s.color }}>{s.icon}</span>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold" style={{ color: s.color }}>
                  {ev.type}
                </span>
                <span className="mx-1 text-xs" style={{ color: 'var(--muted)' }}>
                  Escrow #{ev.id.toString()}
                </span>
                {ev.extra && (
                  <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                    &middot; {ev.extra}
                  </span>
                )}
              </div>
              {ev.txHash && (
                <a
                  href={buildTxExplorerUrl(cfg.chainId, ev.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                  style={{ color: 'var(--muted)' }}
                  title="View on explorer"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { address, isConnected } = useAccount()
  const [network, setNetwork] = useState<Network>('testnet')

  // For mainnet, re-derive cfg whenever mainnet address changes (stored in localStorage).
  // We hold a revision counter to trigger re-reads.
  const [mainnetRev, setMainnetRev] = useState(0)
  const cfg = (() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    mainnetRev // read to track dependency in useEffect below
    return getNetworkConfig(network)
  })()

  function handleMainnetConfigured(addr: `0x${string}`) {
    setStoredMainnetAddress(addr)
    setMainnetRev(r => r + 1)
  }

  const { data: checkerRaw } = useReadContract({
    address: cfg.contractAddress ?? undefined,
    abi: CHECKED_ESCROW_ABI,
    functionName: 'checker',
    chainId: cfg.chainId,
    query: { enabled: !!cfg.contractAddress },
  })

  const checker = (checkerRaw as string | undefined) ?? ''
  const isChecker =
    isConnected &&
    !!address &&
    !!checker &&
    address.toLowerCase() === checker.toLowerCase()

  const showMainnetSetup = network === 'mainnet' && !cfg.contractAddress

  // Mainnet warning pill
  const mainnetWarning = network === 'mainnet' && (
    <div
      className="flex items-center gap-2 rounded-2xl px-4 py-3 text-sm"
      style={{
        background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)',
        color: 'var(--danger)',
      }}
    >
      <AlertCircle className="size-4 shrink-0" />
      <span>
        <strong>Mainnet.</strong> Transactions involve real USDC. Confirm every step in your wallet.
      </span>
    </div>
  )

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      <header
        className="sticky top-0 z-20 flex items-center justify-between px-4 py-3 gap-3"
        style={{
          background: 'rgba(255,255,255,0.82)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="flex items-center gap-2 shrink-0">
          <div
            className="flex size-8 items-center justify-center rounded-xl"
            style={{ background: 'var(--accent)' }}
          >
            <Shield className="size-4 text-white" />
          </div>
          <span className="display text-base font-semibold" style={{ color: 'var(--ink)' }}>
            Checked Escrow
          </span>
        </div>
        <div className="flex items-center gap-3">
          <NetworkToggle network={network} onChange={n => setNetwork(n)} />
          <ConnectKitButton />
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-6 space-y-4">
        {!isConnected ? (
          <section className="p-8 text-center" style={glass.card}>
            <Shield className="mx-auto mb-3 size-10" style={{ color: 'var(--accent)' }} />
            <h1 className="display text-xl font-bold mb-2" style={{ color: 'var(--ink)' }}>
              Checked Escrow
            </h1>
            <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
              Hold USDC in escrow until a trusted checker approves the payment.
              Connect your wallet on Arc to get started.
            </p>
            <ConnectKitButton />
          </section>
        ) : (
          <>
            {mainnetWarning}

            {isChecker && (
              <div
                className="flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold"
                style={{
                  background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)',
                  color: 'var(--accent)',
                }}
              >
                <Shield className="size-4 shrink-0" />
                You are the checker for this contract.
              </div>
            )}

            {showMainnetSetup ? (
              <MainnetSetupPanel onConfigured={handleMainnetConfigured} />
            ) : (
              <>
                {/* Contract address badge for mainnet */}
                {network === 'mainnet' && cfg.contractAddress && (
                  <div
                    className="flex items-center justify-between gap-2 rounded-2xl px-4 py-3 text-xs"
                    style={glass.inner}
                  >
                    <span style={{ color: 'var(--muted)' }}>Contract</span>
                    <div className="flex items-center gap-2">
                      <a
                        href={explorerAddr(cfg, cfg.contractAddress)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mono underline flex items-center gap-1"
                        style={{ color: 'var(--ink-2)' }}
                      >
                        {fmtAddr(cfg.contractAddress)} <ExternalLink className="size-3" />
                      </a>
                      <button
                        onClick={() => {
                          setStoredMainnetAddress('' as `0x${string}`)
                          setMainnetRev(r => r + 1)
                        }}
                        className="text-xs underline"
                        style={{ color: 'var(--subtle)' }}
                        title="Change contract address"
                      >
                        Change
                      </button>
                    </div>
                  </div>
                )}
                <WithdrawPanel address={address!} cfg={cfg} />
                <DepositPanel cfg={cfg} checkerAddress={checker} />
                <MyEscrowsPanel address={address!} checkerAddress={checker} cfg={cfg} />
                <ActivityFeed cfg={cfg} />
              </>
            )}
          </>
        )}
      </main>

      <footer className="px-4 py-6 text-center text-xs" style={{ color: 'var(--subtle)' }}>
        Checks by{' '}
        <a
          href="https://chainward.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
          style={{ color: 'var(--muted)' }}
        >
          ChainWard (chainward.ai)
        </a>
        . A check is not a guarantee.
      </footer>
    </div>
  )
}
