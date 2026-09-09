# Registry account schemas

This directory holds `schemas.ts`, the borsh schemas that
`../borsh-registry.ts` uses to decode Metro, Device, and Link accounts.
The schemas are placeholders and `haveSchemas` is `false`, so the
registry throws instead of returning wrong data.

The directory name is historical. Reading these accounts does not need
a program IDL. The live readers in `../contributor-directory.ts` and
`../dz-rewards-record.ts` decode verified byte offsets from known
programs, and that is the approach to follow here. `../README.md` lists
what each stub still needs.

## Placeholder shapes

The schemas in `schemas.ts` assume length-prefixed strings and standard
borsh scalars. No field below has been checked against a live account:

```idl
account Metro {
  code: string,           // "FRA", "SIN", etc. 3-letter
  name: string,
  latitude: f64,
  longitude: f64,
}

account Device {
  code: string,           // "FRA1", "SIN2", etc.
  status: string,
  device_type: string,
  metro: Pubkey,          // Metro account
  contributor: Pubkey,    // Contributor account
}

account Link {
  code: string,
  status: string,
  link_type: string,      // "WAN" | "DZX" | ...
  bandwidth: u64,         // bps
  side_a: Pubkey,         // Device
  side_z: Pubkey,         // Device
  latency_us: u64,
  contributor: Pubkey,    // Contributor
}

account Contributor {
  code: string,           // "jump_", "glxy", etc.
  ops_manager: Pubkey,
  status: string,
}
```

The Contributor shape above is superseded. `../contributor-directory.ts`
carries the verified layout for that account type. Use it as the model:
read a live account, confirm each offset, then write the schema.

Verify every field against a live account before setting `haveSchemas`
to `true`, and update the `Onchain*` types in `../decoders.ts` if the
real layout differs.
