#![forbid(unsafe_code)]

use av1_native_sys::{
    ABI_VERSION_V1, BLOCK_DETAILS_MASK_V2, BLOCK_MODE_SKIP_V1, BLOCK_NONE_U8,
    BlockChunkV1, BlockChunkV2, BlockRecordV1, BlockRecordV2,
    INSPECTION_ABI_VERSION_V2, MAX_BLOCKS_PER_CHUNK_V1, MotionVectorV1,
    SAMPLE_FLAGS_MASK_V1, SampleV1, StatusCodeV1, StatusV1,
};
use core::fmt;
use core::mem::size_of;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractError {
    UnknownStatus(StatusCodeV1),
    LayoutTooLarge,
    StructTooSmall { actual: u32, required: u32 },
    AbiMismatch { actual: u32 },
    RangeOverflow,
    RangeOutsideSource,
    ResourceLimit,
    UnknownSampleFlags(u32),
    InvalidBlockGeometry,
    InvalidBlockValue,
    InvalidMotionVector,
    InvalidChunk,
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownStatus(value) => write!(formatter, "unknown native status {value}"),
            Self::LayoutTooLarge => formatter.write_str("native struct size exceeds u32"),
            Self::StructTooSmall { actual, required } => {
                write!(formatter, "native struct is {actual} bytes; {required} required")
            }
            Self::AbiMismatch { actual } => write!(formatter, "unsupported native ABI {actual}"),
            Self::RangeOverflow => formatter.write_str("native range overflows"),
            Self::RangeOutsideSource => formatter.write_str("native range is outside source"),
            Self::ResourceLimit => formatter.write_str("native record exceeds resource budget"),
            Self::UnknownSampleFlags(flags) => write!(formatter, "unknown sample flags {flags:#x}"),
            Self::InvalidBlockGeometry => formatter.write_str("invalid block geometry"),
            Self::InvalidBlockValue => formatter.write_str("invalid block scalar"),
            Self::InvalidMotionVector => formatter.write_str("invalid motion vector"),
            Self::InvalidChunk => formatter.write_str("invalid block chunk"),
        }
    }
}

impl std::error::Error for ContractError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SampleLimits {
    pub source_bytes: u64,
    pub maximum_sample_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlockLimits {
    pub frame_width: u32,
    pub frame_height: u32,
    pub maximum_blocks_per_chunk: u32,
}

fn required_size<T>() -> Result<u32, ContractError> {
    u32::try_from(size_of::<T>()).map_err(|_| ContractError::LayoutTooLarge)
}

fn validate_prefix_version<T>(
    struct_size: u32,
    abi_version: u32,
    expected_version: u32,
) -> Result<(), ContractError> {
    let required = required_size::<T>()?;
    if struct_size < required {
        return Err(ContractError::StructTooSmall {
            actual: struct_size,
            required,
        });
    }
    if abi_version != expected_version {
        return Err(ContractError::AbiMismatch {
            actual: abi_version,
        });
    }
    Ok(())
}

fn validate_prefix<T>(struct_size: u32, abi_version: u32) -> Result<(), ContractError> {
    validate_prefix_version::<T>(struct_size, abi_version, ABI_VERSION_V1)
}

/// Converts an untrusted adapter status without ever constructing an invalid enum.
///
/// # Errors
///
/// Returns [`ContractError::UnknownStatus`] for values outside ABI v1.
pub const fn normalize_status(code: StatusCodeV1) -> Result<StatusV1, ContractError> {
    match StatusV1::from_code(code) {
        Some(status) => Ok(status),
        None => Err(ContractError::UnknownStatus(code)),
    }
}

/// Validates a copied sample record before it enters the core model.
///
/// # Errors
///
/// Rejects ABI/layout drift, unknown flags, arithmetic overflow, source escape,
/// or a sample larger than the configured budget.
pub fn validate_sample(sample: &SampleV1, limits: SampleLimits) -> Result<(), ContractError> {
    validate_prefix::<SampleV1>(sample.struct_size, sample.abi_version)?;
    if sample.flags & !SAMPLE_FLAGS_MASK_V1 != 0 {
        return Err(ContractError::UnknownSampleFlags(sample.flags));
    }
    if sample.source_range.length > limits.maximum_sample_bytes {
        return Err(ContractError::ResourceLimit);
    }
    let end = sample
        .source_range
        .start
        .checked_add(sample.source_range.length)
        .ok_or(ContractError::RangeOverflow)?;
    if end > limits.source_bytes {
        return Err(ContractError::RangeOutsideSource);
    }
    Ok(())
}

fn validate_motion_vector(vector: MotionVectorV1) -> Result<(), ContractError> {
    if vector.valid > 1 || vector.reserved != 0 {
        return Err(ContractError::InvalidMotionVector);
    }
    Ok(())
}

/// Validates a copied block record against its frame dimensions.
///
/// # Errors
///
/// Rejects ABI/layout drift, zero/overflowing/out-of-frame geometry, unknown
/// enum/boolean values, invalid references, or malformed motion-vector flags.
pub fn validate_block(record: &BlockRecordV1, limits: BlockLimits) -> Result<(), ContractError> {
    validate_prefix::<BlockRecordV1>(record.struct_size, record.abi_version)?;
    if record.width == 0 || record.height == 0 || record.plane > 2 {
        return Err(ContractError::InvalidBlockGeometry);
    }
    let right = record
        .x
        .checked_add(record.width)
        .ok_or(ContractError::InvalidBlockGeometry)?;
    let bottom = record
        .y
        .checked_add(record.height)
        .ok_or(ContractError::InvalidBlockGeometry)?;
    if right > limits.frame_width || bottom > limits.frame_height {
        return Err(ContractError::InvalidBlockGeometry);
    }
    if record.partition > 10
        || record.mode > BLOCK_MODE_SKIP_V1
        || record.flags & !av1_native_sys::BLOCK_FLAGS_MASK_V1 != 0
    {
        return Err(ContractError::InvalidBlockValue);
    }
    for reference in [record.reference_0, record.reference_1] {
        if reference != BLOCK_NONE_U8 && reference > 7 {
            return Err(ContractError::InvalidBlockValue);
        }
    }
    for vector in record.motion_vectors {
        validate_motion_vector(vector)?;
    }
    Ok(())
}

/// Validates the append-only BlockRecord v2 fields and its inherited v1 values.
///
/// # Errors
///
/// Rejects ABI/layout drift, invalid geometry/scalars/vectors, or unknown detail flags.
pub fn validate_block_v2(
    record: &BlockRecordV2,
    limits: BlockLimits,
) -> Result<(), ContractError> {
    validate_prefix_version::<BlockRecordV2>(
        record.struct_size,
        record.abi_version,
        INSPECTION_ABI_VERSION_V2,
    )?;
    if record.width == 0 || record.height == 0 || record.plane > 2 {
        return Err(ContractError::InvalidBlockGeometry);
    }
    let right = record.x.checked_add(record.width).ok_or(ContractError::InvalidBlockGeometry)?;
    let bottom = record.y.checked_add(record.height).ok_or(ContractError::InvalidBlockGeometry)?;
    if right > limits.frame_width || bottom > limits.frame_height {
        return Err(ContractError::InvalidBlockGeometry);
    }
    if record.partition > 10
        || record.mode > BLOCK_MODE_SKIP_V1
        || record.flags & !av1_native_sys::BLOCK_FLAGS_MASK_V1 != 0
        || record.detail_flags & !BLOCK_DETAILS_MASK_V2 != 0
        || (record.detail_flags & av1_native_sys::BLOCK_DETAIL_MI_COORDINATES_V2 == 0
            && (record.mi_row != 0 || record.mi_column != 0))
        || (record.detail_flags & av1_native_sys::BLOCK_DETAIL_COMPOUND_TYPE_V2 == 0
            && record.compound_type != 0)
        || (record.detail_flags & av1_native_sys::BLOCK_DETAIL_COMPOUND_TYPE_V2 != 0
            && record.compound_type < 0)
        || (record.detail_flags & av1_native_sys::BLOCK_DETAIL_QUANT_DELTA_V2 == 0
            && record.quant_delta != 0)
    {
        return Err(ContractError::InvalidBlockValue);
    }
    for reference in [record.reference_0, record.reference_1] {
        if reference != BLOCK_NONE_U8 && reference > 7 {
            return Err(ContractError::InvalidBlockValue);
        }
    }
    for vector in record.motion_vectors {
        validate_motion_vector(vector)?;
    }
    Ok(())
}

/// Validates chunk metadata without dereferencing the borrowed record pointer.
///
/// The future FFI owner must call this first, then copy exactly `record_count`
/// records inside its small audited unsafe boundary before validating each copy.
///
/// # Errors
///
/// Rejects ABI/layout drift, invalid booleans/pointers, record-ID overflow, or
/// producer/consumer chunk budgets that exceed the ABI hard limit.
pub fn validate_chunk_metadata(
    chunk: &BlockChunkV1,
    limits: BlockLimits,
) -> Result<(), ContractError> {
    validate_prefix::<BlockChunkV1>(chunk.struct_size, chunk.abi_version)?;
    let negotiated = limits
        .maximum_blocks_per_chunk
        .min(MAX_BLOCKS_PER_CHUNK_V1);
    if negotiated == 0 || chunk.record_count > negotiated {
        return Err(ContractError::ResourceLimit);
    }
    if chunk.final_chunk > 1
        || (chunk.record_count != 0 && chunk.records.is_null())
        || chunk
            .first_block_id
            .checked_add(u64::from(chunk.record_count))
            .is_none()
    {
        return Err(ContractError::InvalidChunk);
    }
    Ok(())
}

/// Validates BlockRecord v2 chunk metadata without dereferencing its borrowed pointer.
///
/// # Errors
///
/// Rejects ABI/layout drift, invalid booleans/pointers, ID overflow, or budget overflow.
pub fn validate_chunk_metadata_v2(
    chunk: &BlockChunkV2,
    limits: BlockLimits,
) -> Result<(), ContractError> {
    validate_prefix_version::<BlockChunkV2>(
        chunk.struct_size,
        chunk.abi_version,
        INSPECTION_ABI_VERSION_V2,
    )?;
    let negotiated = limits.maximum_blocks_per_chunk.min(MAX_BLOCKS_PER_CHUNK_V1);
    if negotiated == 0 || chunk.record_count > negotiated {
        return Err(ContractError::ResourceLimit);
    }
    if chunk.final_chunk > 1
        || (chunk.record_count != 0 && chunk.records.is_null())
        || chunk.first_block_id.checked_add(u64::from(chunk.record_count)).is_none()
    {
        return Err(ContractError::InvalidChunk);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use core::mem::size_of;
    use core::ptr::NonNull;

    use av1_native_sys::{
        ABI_VERSION_V1, BLOCK_MODE_INTRA_V1, BLOCK_NONE_I16, BLOCK_NONE_I32,
        BLOCK_NONE_U8, BlockChunkV1, BlockRecordV1, ByteRangeV1, MotionVectorV1,
        SAMPLE_FLAG_KEYFRAME_V1, SampleV1, StatusV1,
    };

    use super::{
        BlockLimits, ContractError, SampleLimits, normalize_status, validate_block,
        validate_chunk_metadata, validate_sample,
    };

    fn sample() -> SampleV1 {
        SampleV1 {
            struct_size: u32::try_from(size_of::<SampleV1>()).unwrap(),
            abi_version: ABI_VERSION_V1,
            sample_id: 0,
            track_id: 1,
            flags: SAMPLE_FLAG_KEYFRAME_V1,
            dts: 0,
            pts: 0,
            duration: 1,
            source_range: ByteRangeV1 {
                start: 4,
                length: 8,
            },
        }
    }

    fn block() -> BlockRecordV1 {
        BlockRecordV1 {
            struct_size: u32::try_from(size_of::<BlockRecordV1>()).unwrap(),
            abi_version: ABI_VERSION_V1,
            frame_id: 0,
            block_id: 0,
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            plane: 0,
            partition: 1,
            mode: BLOCK_MODE_INTRA_V1,
            segment_id: 0,
            flags: av1_native_sys::BLOCK_FLAG_QINDEX_VALID_V1,
            reference_0: BLOCK_NONE_U8,
            reference_1: BLOCK_NONE_U8,
            qindex: 100,
            intra_mode: BLOCK_NONE_I16,
            inter_mode: BLOCK_NONE_I16,
            tx_size: BLOCK_NONE_I16,
            tx_type: BLOCK_NONE_I16,
            coeff_non_zero: BLOCK_NONE_I32,
            filter_summary: BLOCK_NONE_I32,
            motion_vectors: [
                MotionVectorV1 {
                    row: 0,
                    column: 0,
                    precision: 0,
                    valid: 0,
                    reserved: 0,
                };
                2
            ],
        }
    }

    #[test]
    fn status_normalization_rejects_unknown_values() {
        assert_eq!(normalize_status(0), Ok(StatusV1::Ok));
        assert_eq!(normalize_status(u32::MAX), Err(ContractError::UnknownStatus(u32::MAX)));
    }

    #[test]
    fn sample_ranges_and_budgets_are_checked() {
        let limits = SampleLimits {
            source_bytes: 12,
            maximum_sample_bytes: 8,
        };
        assert_eq!(validate_sample(&sample(), limits), Ok(()));
        let mut escaped = sample();
        escaped.source_range.length = 9;
        assert_eq!(validate_sample(&escaped, limits), Err(ContractError::ResourceLimit));
        escaped.source_range.start = u64::MAX;
        escaped.source_range.length = 2;
        assert_eq!(
            validate_sample(
                &escaped,
                SampleLimits {
                    source_bytes: u64::MAX,
                    maximum_sample_bytes: 2,
                },
            ),
            Err(ContractError::RangeOverflow)
        );
    }

    #[test]
    fn block_geometry_and_chunk_metadata_are_checked() {
        let limits = BlockLimits {
            frame_width: 16,
            frame_height: 16,
            maximum_blocks_per_chunk: 4,
        };
        let valid = block();
        assert_eq!(validate_block(&valid, limits), Ok(()));
        let mut outside = valid;
        outside.x = 1;
        assert_eq!(validate_block(&outside, limits), Err(ContractError::InvalidBlockGeometry));

        let chunk = BlockChunkV1 {
            struct_size: u32::try_from(size_of::<BlockChunkV1>()).unwrap(),
            abi_version: ABI_VERSION_V1,
            frame_id: 0,
            first_block_id: 0,
            records: NonNull::<BlockRecordV1>::dangling().as_ptr(),
            record_count: 1,
            final_chunk: 1,
        };
        assert_eq!(validate_chunk_metadata(&chunk, limits), Ok(()));
        let mut too_many = chunk;
        too_many.record_count = 5;
        assert_eq!(
            validate_chunk_metadata(&too_many, limits),
            Err(ContractError::ResourceLimit)
        );
    }
}
