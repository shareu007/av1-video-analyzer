#![forbid(unsafe_code)]

pub const SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteRange {
    pub start: u64,
    pub length: u64,
}

impl ByteRange {
    #[must_use]
    pub const fn new(start: u64, length: u64) -> Self {
        Self { start, length }
    }

    #[must_use]
    pub const fn checked_end(self) -> Option<u64> {
        self.start.checked_add(self.length)
    }

    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        match (self.checked_end(), other.checked_end()) {
            (Some(end), Some(other_end)) => {
                other.start >= self.start && other_end <= end
            }
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BitRange {
    pub start_bit: u64,
    pub length_bits: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Severity {
    Info,
    Warning,
    Error,
    Fatal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SyntaxStatus {
    Pending,
    Partial,
    Complete,
    Error,
    NotApplicable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObuType {
    Reserved(u8),
    SequenceHeader,
    TemporalDelimiter,
    FrameHeader,
    TileGroup,
    Metadata,
    Frame,
    RedundantFrameHeader,
    TileList,
    Padding,
}

impl ObuType {
    #[must_use]
    pub const fn from_code(code: u8) -> Self {
        match code {
            1 => Self::SequenceHeader,
            2 => Self::TemporalDelimiter,
            3 => Self::FrameHeader,
            4 => Self::TileGroup,
            5 => Self::Metadata,
            6 => Self::Frame,
            7 => Self::RedundantFrameHeader,
            8 => Self::TileList,
            15 => Self::Padding,
            value => Self::Reserved(value),
        }
    }

    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Reserved(code) => code,
            Self::SequenceHeader => 1,
            Self::TemporalDelimiter => 2,
            Self::FrameHeader => 3,
            Self::TileGroup => 4,
            Self::Metadata => 5,
            Self::Frame => 6,
            Self::RedundantFrameHeader => 7,
            Self::TileList => 8,
            Self::Padding => 15,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Reserved(_) => "reserved",
            Self::SequenceHeader => "sequence_header",
            Self::TemporalDelimiter => "temporal_delimiter",
            Self::FrameHeader => "frame_header",
            Self::TileGroup => "tile_group",
            Self::Metadata => "metadata",
            Self::Frame => "frame",
            Self::RedundantFrameHeader => "redundant_frame_header",
            Self::TileList => "tile_list",
            Self::Padding => "padding",
        }
    }

    #[must_use]
    pub const fn syntax_is_deferred(self) -> bool {
        matches!(
            self,
            Self::SequenceHeader
                | Self::FrameHeader
                | Self::TileGroup
                | Self::Metadata
                | Self::Frame
                | Self::RedundantFrameHeader
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObuHeader {
    pub forbidden_bit: bool,
    pub extension_flag: bool,
    pub has_size_field: bool,
    pub reserved_bit: bool,
    pub temporal_id: Option<u8>,
    pub spatial_id: Option<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObuRecord {
    pub schema_version: u16,
    pub obu_id: u64,
    pub frame_id: Option<u64>,
    pub obu_type: ObuType,
    pub header: ObuHeader,
    pub byte_range: ByteRange,
    pub header_range: ByteRange,
    pub size_field_range: Option<ByteRange>,
    pub payload_range: ByteRange,
    pub declared_payload_size: Option<u64>,
    pub complete: bool,
    pub syntax_status: SyntaxStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    pub schema_version: u16,
    pub code: &'static str,
    pub severity: Severity,
    pub message: String,
    pub byte_range: Option<ByteRange>,
    pub frame_id: Option<u64>,
    pub obu_id: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::{ByteRange, ObuType};

    #[test]
    fn checked_ranges_never_wrap() {
        assert_eq!(ByteRange::new(4, 3).checked_end(), Some(7));
        assert_eq!(ByteRange::new(u64::MAX, 1).checked_end(), None);
        assert!(ByteRange::new(4, 8).contains(ByteRange::new(5, 2)));
        assert!(!ByteRange::new(4, 8).contains(ByteRange::new(3, 2)));
    }

    #[test]
    fn obu_codes_round_trip() {
        for code in 0..=15 {
            assert_eq!(ObuType::from_code(code).code(), code);
        }
    }
}
