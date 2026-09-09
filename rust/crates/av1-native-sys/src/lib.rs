#![allow(unsafe_code)]

use core::ffi::c_void;

pub const ABI_VERSION_V1: u32 = 1;
pub const INSPECTION_ABI_VERSION_V2: u32 = 2;
pub const MAX_DIAGNOSTIC_BYTES_V1: u32 = 4_096;
pub const MAX_BLOCKS_PER_CHUNK_V1: u32 = 65_536;
pub const MAX_SAMPLE_BYTES_V1: u64 = 1_073_741_824;
pub const MAX_PROBE_BYTES_V1: u64 = 268_435_456;
pub const SAMPLE_FLAG_KEYFRAME_V1: u32 = 1;
pub const SAMPLE_FLAG_DISCARD_V1: u32 = 2;
pub const SAMPLE_FLAG_CORRUPT_V1: u32 = 4;
pub const SAMPLE_FLAGS_MASK_V1: u32 =
    SAMPLE_FLAG_KEYFRAME_V1 | SAMPLE_FLAG_DISCARD_V1 | SAMPLE_FLAG_CORRUPT_V1;
pub const BLOCK_NONE_I16: i16 = -1;
pub const BLOCK_NONE_I32: i32 = -1;
pub const BLOCK_NONE_U8: u8 = u8::MAX;
pub const BLOCK_FLAG_SKIP_V1: u8 = 1;
pub const BLOCK_FLAG_QINDEX_VALID_V1: u8 = 2;
pub const BLOCK_FLAGS_MASK_V1: u8 = 3;
pub const BLOCK_DETAIL_MI_COORDINATES_V2: u32 = 1;
pub const BLOCK_DETAIL_COMPOUND_TYPE_V2: u32 = 2;
pub const BLOCK_DETAIL_QUANT_DELTA_V2: u32 = 4;
pub const BLOCK_DETAILS_MASK_V2: u32 = 7;
pub const BLOCK_MODE_UNKNOWN_V1: u8 = 0;
pub const BLOCK_MODE_INTRA_V1: u8 = 1;
pub const BLOCK_MODE_INTER_V1: u8 = 2;
pub const BLOCK_MODE_SKIP_V1: u8 = 3;
pub type StatusCodeV1 = u32;

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StatusV1 {
    Ok = 0,
    End = 1,
    Cancelled = 2,
    InvalidArgument = 3,
    Unsupported = 4,
    MalformedInput = 5,
    ResourceLimit = 6,
    AdapterError = 7,
    AbiMismatch = 8,
}

impl StatusV1 {
    #[must_use]
    pub const fn code(self) -> StatusCodeV1 {
        self as StatusCodeV1
    }

    #[must_use]
    pub const fn from_code(code: StatusCodeV1) -> Option<Self> {
        match code {
            0 => Some(Self::Ok),
            1 => Some(Self::End),
            2 => Some(Self::Cancelled),
            3 => Some(Self::InvalidArgument),
            4 => Some(Self::Unsupported),
            5 => Some(Self::MalformedInput),
            6 => Some(Self::ResourceLimit),
            7 => Some(Self::AdapterError),
            8 => Some(Self::AbiMismatch),
            _ => None,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteRangeV1 {
    pub start: u64,
    pub length: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BytesV1 {
    pub data: *const u8,
    pub length: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct DiagnosticV1 {
    pub struct_size: u32,
    pub status: u32,
    pub message_utf8: *const u8,
    pub message_bytes: u32,
    pub reserved: u32,
}

pub type CancelledFnV1 = unsafe extern "C" fn(user_data: *mut c_void) -> u32;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CallContextV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub deadline_unix_ms: u64,
    pub cancelled: Option<CancelledFnV1>,
    pub user_data: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct AdapterInfoV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub name_utf8: *const u8,
    pub name_bytes: u32,
    pub reserved_0: u32,
    pub build_utf8: *const u8,
    pub build_bytes: u32,
    pub feature_flags: u32,
}

pub type ReadAtFnV1 = unsafe extern "C" fn(
    user_data: *mut c_void,
    offset: u64,
    destination: *mut u8,
    capacity: u64,
) -> i64;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct DemuxSourceV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub source_bytes: u64,
    pub read_at: Option<ReadAtFnV1>,
    pub user_data: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct DemuxOptionsV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub requested_track_id: i32,
    pub flags: u32,
    pub maximum_probe_bytes: u64,
    pub maximum_sample_bytes: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct StreamInfoV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub track_id: i32,
    pub codec_fourcc: u32,
    pub width: u32,
    pub height: u32,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub sample_count: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct SampleV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub sample_id: u64,
    pub track_id: i32,
    pub flags: u32,
    pub dts: i64,
    pub pts: i64,
    pub duration: i64,
    pub source_range: ByteRangeV1,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MotionVectorV1 {
    pub row: i32,
    pub column: i32,
    pub precision: u8,
    pub valid: u8,
    pub reserved: u16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlockRecordV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub frame_id: u64,
    pub block_id: u64,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub plane: u8,
    pub partition: u8,
    pub mode: u8,
    pub segment_id: u8,
    pub flags: u8,
    pub reference_0: u8,
    pub reference_1: u8,
    pub qindex: u8,
    pub intra_mode: i16,
    pub inter_mode: i16,
    pub tx_size: i16,
    pub tx_type: i16,
    pub coeff_non_zero: i32,
    pub filter_summary: i32,
    pub motion_vectors: [MotionVectorV1; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlockRecordV2 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub frame_id: u64,
    pub block_id: u64,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub plane: u8,
    pub partition: u8,
    pub mode: u8,
    pub segment_id: u8,
    pub flags: u8,
    pub reference_0: u8,
    pub reference_1: u8,
    pub qindex: u8,
    pub intra_mode: i16,
    pub inter_mode: i16,
    pub tx_size: i16,
    pub tx_type: i16,
    pub coeff_non_zero: i32,
    pub filter_summary: i32,
    pub motion_vectors: [MotionVectorV1; 2],
    pub detail_flags: u32,
    pub mi_row: u32,
    pub mi_column: u32,
    pub compound_type: i16,
    pub quant_delta: i16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BlockChunkV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub frame_id: u64,
    pub first_block_id: u64,
    pub records: *const BlockRecordV1,
    pub record_count: u32,
    pub final_chunk: u32,
}

pub type BlockChunkFnV1 = unsafe extern "C" fn(
    user_data: *mut c_void,
    chunk: *const BlockChunkV1,
) -> StatusCodeV1;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct InspectionOptionsV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub feature_flags: u32,
    pub maximum_blocks_per_chunk: u32,
    pub maximum_frame_bytes: u64,
    pub on_block_chunk: Option<BlockChunkFnV1>,
    pub user_data: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BlockChunkV2 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub frame_id: u64,
    pub first_block_id: u64,
    pub records: *const BlockRecordV2,
    pub record_count: u32,
    pub final_chunk: u32,
}

pub type BlockChunkFnV2 = unsafe extern "C" fn(
    user_data: *mut c_void,
    chunk: *const BlockChunkV2,
) -> StatusCodeV1;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct InspectionOptionsV2 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub feature_flags: u32,
    pub maximum_blocks_per_chunk: u32,
    pub maximum_frame_bytes: u64,
    pub on_block_chunk: Option<BlockChunkFnV2>,
    pub user_data: *mut c_void,
}

#[repr(C)]
#[derive(Debug)]
pub struct Demux {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Debug)]
pub struct Inspector {
    _private: [u8; 0],
}

pub type DemuxAdapterInfoFnV1 =
    unsafe extern "C" fn(out_info: *mut AdapterInfoV1) -> StatusCodeV1;
pub type DemuxOpenFnV1 = unsafe extern "C" fn(
    source: *const DemuxSourceV1,
    options: *const DemuxOptionsV1,
    call: *const CallContextV1,
    out_demux: *mut *mut Demux,
    out_diagnostic: *mut DiagnosticV1,
) -> StatusCodeV1;
pub type DemuxStreamInfoFnV1 = unsafe extern "C" fn(
    demux: *mut Demux,
    out_stream: *mut StreamInfoV1,
    out_diagnostic: *mut DiagnosticV1,
) -> StatusCodeV1;
pub type DemuxNextSampleFnV1 = unsafe extern "C" fn(
    demux: *mut Demux,
    call: *const CallContextV1,
    out_sample: *mut SampleV1,
    out_diagnostic: *mut DiagnosticV1,
) -> StatusCodeV1;
pub type DemuxCloseFnV1 = unsafe extern "C" fn(demux: *mut Demux);

unsafe extern "C" {
    pub fn av1scope_demux_adapter_info_v1(out_info: *mut AdapterInfoV1) -> StatusCodeV1;
    pub fn av1scope_demux_open_v1(
        source: *const DemuxSourceV1,
        options: *const DemuxOptionsV1,
        call: *const CallContextV1,
        out_demux: *mut *mut Demux,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_demux_stream_info_v1(
        demux: *mut Demux,
        out_stream: *mut StreamInfoV1,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_demux_next_sample_v1(
        demux: *mut Demux,
        call: *const CallContextV1,
        out_sample: *mut SampleV1,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_demux_close_v1(demux: *mut Demux);

    pub fn av1scope_inspection_adapter_info_v1(
        out_info: *mut AdapterInfoV1,
    ) -> StatusCodeV1;
    pub fn av1scope_inspector_create_v1(
        options: *const InspectionOptionsV1,
        out_inspector: *mut *mut Inspector,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_inspector_decode_frame_v1(
        inspector: *mut Inspector,
        frame_id: u64,
        sample: BytesV1,
        call: *const CallContextV1,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_inspector_flush_v1(
        inspector: *mut Inspector,
        call: *const CallContextV1,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_inspector_destroy_v1(inspector: *mut Inspector);
    pub fn av1scope_inspector_create_v2(
        options: *const InspectionOptionsV2,
        out_inspector: *mut *mut Inspector,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_inspector_decode_frame_v2(
        inspector: *mut Inspector,
        frame_id: u64,
        sample: BytesV1,
        call: *const CallContextV1,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_inspector_flush_v2(
        inspector: *mut Inspector,
        call: *const CallContextV1,
        out_diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1;
    pub fn av1scope_inspector_destroy_v2(inspector: *mut Inspector);
}

#[cfg(test)]
mod tests {
    use core::mem::{offset_of, size_of};

    use super::{BlockRecordV1, BlockRecordV2, ByteRangeV1, MotionVectorV1, SampleV1, StatusV1};

    #[test]
    fn rust_layout_matches_c11_smoke_contract() {
        assert_eq!(size_of::<ByteRangeV1>(), 16);
        assert_eq!(size_of::<MotionVectorV1>(), 12);
        assert_eq!(size_of::<BlockRecordV1>(), 88);
        assert_eq!(offset_of!(BlockRecordV1, flags), 44);
        assert_eq!(offset_of!(BlockRecordV1, qindex), 47);
        assert_eq!(offset_of!(BlockRecordV1, motion_vectors), 64);
        assert_eq!(size_of::<BlockRecordV2>(), 104);
        assert_eq!(offset_of!(BlockRecordV2, detail_flags), 88);
        assert_eq!(offset_of!(BlockRecordV2, mi_row), 92);
        assert_eq!(offset_of!(BlockRecordV2, compound_type), 100);
        assert_eq!(size_of::<SampleV1>(), 64);
        assert_eq!(offset_of!(SampleV1, source_range), 48);
        assert_eq!(size_of::<StatusV1>(), 4);
    }

    #[test]
    fn unknown_status_codes_remain_data() {
        assert_eq!(StatusV1::from_code(8), Some(StatusV1::AbiMismatch));
        assert_eq!(StatusV1::from_code(u32::MAX), None);
    }
}
