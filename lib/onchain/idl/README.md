# DZ on-chain IDL drop point

When DZ Foundation publishes the program IDL (Q6), drop the file here as
`dz-registry.idl.json` and `dz-rewards.idl.json`. Then in
`lib/onchain/decoders.ts`:

```ts
// Replace the stub registry import:
//   import { stubRegistry as registry } from "./idl-registry";
// with the anchor-backed one:
import { anchorRegistry as registry } from "./idl-registry";
```

That's the entire swap. Every consumer of `decodeMetro`, `decodeDevice`,
etc. lights up automatically.

Until then this directory stays empty (except this README) and the
decoders throw `OnchainNotConfigured`, which the routes turn into 503s
with stable shapes the frontend already handles.

## Expected schema (best guess)

```idl
account Metro {
  code: string,           // "FRA", "SIN", etc. — 3-letter
  name: string,
  latitude: f64,
  longitude: f64,
}

account Device {
  code: string,           // "FRA1", "SIN2", etc.
  status: string,
  device_type: string,
  metro: Pubkey,          // → Metro account
  contributor: Pubkey,    // → Contributor account
}

account Link {
  code: string,
  status: string,
  link_type: string,      // "WAN" | "DZX" | ...
  bandwidth: u64,         // bps
  side_a: Pubkey,         // → Device
  side_z: Pubkey,         // → Device
  latency_us: u64,
  contributor: Pubkey,    // → Contributor
}

account Contributor {
  code: string,           // "jump_", "glxy", etc.
  ops_manager: Pubkey,
  status: string,
}
```

Update `lib/onchain/decoders.ts` types if the actual IDL diverges.
