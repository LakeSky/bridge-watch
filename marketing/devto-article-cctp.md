# CCTP V1 vs V2: The Nonce Mismatch That Breaks Cross-Chain Arrival Checks

While building a cross-chain transaction tracker on Base, I hit a subtle gotcha in Circle's CCTP (Cross-Chain Transfer Protocol) that took me a while to figure out. If you're building anything that tracks "did my USDC bridge transfer arrive on the destination chain?", this will save you a few hours.

## The Goal: Check If a Transfer Arrived

The obvious way to verify a CCTP transfer completed is:

1. On the source chain, decode the `DepositForBurn` event to get the deposit's **nonce**
2. On the destination chain, query `MessageTransmitter.usedNonces(...)` — if the nonce is marked used, the transfer arrived

Simple, right? That's exactly what the docs imply. It's also wrong.

## The Problem

On Base, the `TokenMessenger` (the contract you call `depositForBurn` on) emits this event:

```solidity
event DepositForBurn(
    uint64 indexed nonce,        // <-- uint64 nonce
    address indexed burnToken,
    uint256 amount,
    address indexed depositor,
    bytes32 mintRecipient,
    uint32 destinationDomain,
    bytes32 destinationTokenMessenger,
    bytes32 destinationCaller
)
```

The nonce is a **`uint64`**, scoped per source domain.

But when I queried the destination chain's `MessageTransmitter.usedNonces(bytes32, uint64)` with that nonce, it **reverted**. No error message, just a revert.

Here's what I found after reading the contract source:

The deployed `MessageTransmitter` is **V2**, and V2 keys `usedNonces` by a **`bytes32` nonce** — not a `uint64`:

```solidity
// MessageTransmitterV2
mapping(bytes32 => uint256) public usedNonces;  // single bytes32 key

function usedNonces(bytes32 nonce) external view returns (uint256);
```

And crucially, in V2 the nonce is **computed inside `sendMessage`** — it's *not even present* in the `DepositForBurn` event. The V2 `DepositForBurn` event looks completely different:

```solidity
event DepositForBurn(
    address indexed burnToken,
    uint256 amount,
    address indexed depositor,
    bytes32 mintRecipient,
    uint32 destinationDomain,
    bytes32 destinationTokenMessenger,
    bytes32 destinationCaller,
    uint256 maxFee,
    uint32 indexed minFinalityThreshold,
    bytes hookData
)
```

No nonce at all. It's derived internally from the message.

## The Mismatch

So you have two coexisting, incompatible systems:

| | nonce type | where it's stored | `usedNonces` key |
|---|---|---|---|
| **V1 TokenMessenger** | `uint64`, per source domain | in the event | `bytes32 sourceDomain, uint64 nonce` |
| **V2 MessageTransmitter** | `bytes32`, global | NOT in the event | `bytes32 nonce` |

If you're on a chain with a V1 TokenMessenger but a V2 MessageTransmitter (which is what I hit on Base → Ethereum), you **cannot** go from the V1 `uint64` nonce to the V2 `bytes32` nonce directly. The mapping isn't `bytes32(uint64(nonce))` — it's derived from the message hash internally.

## How I Debugged It

The tell-tale sign was that `localDomain()` worked but `usedNonces(...)` reverted:

```typescript
// works
await transmitter.readContract({ functionName: "localDomain" })  // returns 0 (Ethereum)

// reverts — wrong V1 signature
await transmitter.readContract({ functionName: "usedNonces", args: [sourceDomain, nonce] })

// works — V2 signature
await transmitter.readContract({ functionName: "usedNonces", args: [bytes32Nonce] })
```

If `localDomain()` succeeds but `usedNonces(bytes32, uint64)` reverts, you're talking to a V2 contract with a V1 assumption.

## What This Means for Builders

1. **Don't assume V1 and V2 are interchangeable.** They're two separate systems with different message formats, nonce types, and event signatures.

2. **To check arrival correctly**, you need to use the same version on both sides. If you're decoding a V1 `DepositForBurn`, find the *V1* `MessageTransmitter` (with the nested `usedNonces(bytes32, uint64)` mapping), not the V2 one.

3. **Always verify which contract version you're actually talking to** before assuming a function signature. `localDomain()` working ≠ the rest of the ABI is what you expect.

## TL;DR

CCTP V1 uses `uint64` nonces (per source domain, in the event); V2 uses `bytes32` nonces (global, computed internally, not in the event). They don't map to each other directly. If you're checking "did my bridge transfer arrive," make sure the TokenMessenger and MessageTransmitter versions match — otherwise your `usedNonces` call silently reverts.

---

*I hit this while building [bridge-watch](https://github.com/LakeSky/bridge-watch), an open-source on-chain intel API. The cross-chain arrival check is the one piece I had to leave as "source-side only" until I reconcile the V1/V2 nonce mapping — if anyone has a clean way to map a V1 `uint64` nonce to the V2 `bytes32` nonce, I'd love to hear it.*
