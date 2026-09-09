# libaom v3.12.1 integration

- Upstream tag: `v3.12.1` (`10aece41…` as published by the upstream tag page)
- Debian original archive: `aom_3.12.1.orig.tar.gz`
- Archive SHA-256: `40c929a41b2a59c24319a699c358351422829b3ae646de31b18cbabed0191962`
- Required build flags: `CONFIG_INSPECTION=1`, static library, PIC, one decoder thread
- Existing producer: `native/libaom_builtin_inspection_patch.c`
- Feature mask: `127` (partition/mode/MV/transform/coefficient/qindex/filter)
- Inspection patch SHA-256: `6520bcabf22abf850bf70b67b543bdd7a5b2762d3270874c12a4dce38d285b94`

Implemented patch scope:

1. Copy the decoded `MB_MODE_INFO.partition` into the inspection grid and map the enum explicitly.
2. Count real non-zero luma transform coefficients during token decode and aggregate per coding block.
3. Done: BlockRecord v2 exports `compound_type`, MI coordinates and quant delta while preserving the v1 prefix/layout.

The two checked-in synthetic Golden cases prove all nine semantic coverage categories. The pinned build command now emits and verifies the artifact digests, BSD-2-Clause/AOM PATENTS inventory, and CycloneDX 1.6 SBOM manifest.
