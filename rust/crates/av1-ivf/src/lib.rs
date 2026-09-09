#![forbid(unsafe_code)]

use av1_model::{ByteRange, Diagnostic, SCHEMA_VERSION, Severity};
use core::fmt;

const HEADER_BYTES: usize = 32;
const FRAME_HEADER_BYTES: usize = 12;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IvfContainer {
    pub version: u16,
    pub header_length: u16,
    pub codec: [u8; 4],
    pub width: u16,
    pub height: u16,
    pub timebase_rate: u32,
    pub timebase_scale: u32,
    pub declared_frame_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IvfFrame {
    pub schema_version: u16,
    pub frame_id: u64,
    pub decode_index: u64,
    pub timestamp: u64,
    pub sample_range: ByteRange,
    pub payload_range: ByteRange,
    pub declared_size: u32,
    pub complete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IvfIndex {
    pub container: Option<IvfContainer>,
    pub frames: Vec<IvfFrame>,
    pub diagnostics: Vec<Diagnostic>,
    pub limit_reached: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseError {
    NotIvf,
    InvalidFrameBudget,
    OffsetOverflow,
}

impl fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::NotIvf => "input does not begin with the IVF DKIF signature",
            Self::InvalidFrameBudget => "IVF frame budget must be positive",
            Self::OffsetOverflow => "IVF offset arithmetic overflow",
        })
    }
}

impl std::error::Error for ParseError {}

fn range(start: usize, length: usize) -> Result<ByteRange, ParseError> {
    Ok(ByteRange::new(
        u64::try_from(start).map_err(|_| ParseError::OffsetOverflow)?,
        u64::try_from(length).map_err(|_| ParseError::OffsetOverflow)?,
    ))
}

fn diagnostic(
    code: &'static str,
    severity: Severity,
    message: impl Into<String>,
    byte_range: ByteRange,
    frame_id: Option<u64>,
) -> Diagnostic {
    Diagnostic {
        schema_version: SCHEMA_VERSION,
        code,
        severity,
        message: message.into(),
        byte_range: Some(byte_range),
        frame_id,
        obu_id: None,
    }
}

fn read_u16(input: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([input[offset], input[offset + 1]])
}

fn read_u32(input: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        input[offset],
        input[offset + 1],
        input[offset + 2],
        input[offset + 3],
    ])
}

fn read_u64(input: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes([
        input[offset],
        input[offset + 1],
        input[offset + 2],
        input[offset + 3],
        input[offset + 4],
        input[offset + 5],
        input[offset + 6],
        input[offset + 7],
    ])
}

/// Indexes the IVF container and frame sample ranges without parsing AV1 payloads.
///
/// # Errors
///
/// Returns an error for a missing DKIF signature, a zero frame budget, or
/// arithmetic that cannot be represented. Truncation is a stable diagnostic.
#[allow(clippy::similar_names, clippy::too_many_lines)]
pub fn parse_ivf(input: &[u8], maximum_frames: usize) -> Result<IvfIndex, ParseError> {
    if !input.starts_with(b"DKIF") {
        return Err(ParseError::NotIvf);
    }
    if maximum_frames == 0 {
        return Err(ParseError::InvalidFrameBudget);
    }

    let mut diagnostics = Vec::new();
    if input.len() < HEADER_BYTES {
        diagnostics.push(diagnostic(
            "IVF_HEADER_TRUNCATED",
            Severity::Fatal,
            "IVF header requires 32 bytes",
            range(0, input.len())?,
            None,
        ));
        return Ok(IvfIndex {
            container: None,
            frames: Vec::new(),
            diagnostics,
            limit_reached: false,
        });
    }

    let version = read_u16(input, 4);
    let header_length = read_u16(input, 6);
    let codec = [input[8], input[9], input[10], input[11]];
    let width = read_u16(input, 12);
    let height = read_u16(input, 14);
    let timebase_rate = read_u32(input, 16);
    let timebase_scale = read_u32(input, 20);
    let declared_frame_count = read_u32(input, 24);

    if version != 0 {
        diagnostics.push(diagnostic(
            "IVF_VERSION_UNSUPPORTED",
            Severity::Warning,
            format!("IVF version {version} is not the expected version 0"),
            range(4, 2)?,
            None,
        ));
    }
    if usize::from(header_length) < HEADER_BYTES {
        diagnostics.push(diagnostic(
            "IVF_HEADER_LENGTH_INVALID",
            Severity::Fatal,
            format!("IVF header length {header_length} is smaller than 32"),
            range(6, 2)?,
            None,
        ));
        return Ok(IvfIndex {
            container: None,
            frames: Vec::new(),
            diagnostics,
            limit_reached: false,
        });
    }
    if usize::from(header_length) > input.len() {
        diagnostics.push(diagnostic(
            "IVF_HEADER_TRUNCATED",
            Severity::Fatal,
            format!(
                "IVF declares a {header_length}-byte header but the input has {} bytes",
                input.len()
            ),
            range(0, input.len())?,
            None,
        ));
        return Ok(IvfIndex {
            container: None,
            frames: Vec::new(),
            diagnostics,
            limit_reached: false,
        });
    }
    if codec != *b"AV01" {
        diagnostics.push(diagnostic(
            "IVF_CODEC_NOT_AV1",
            Severity::Error,
            "IVF codec is not AV01",
            range(8, 4)?,
            None,
        ));
    }
    if width == 0 || height == 0 {
        diagnostics.push(diagnostic(
            "IVF_DIMENSIONS_ZERO",
            Severity::Warning,
            format!("IVF dimensions are {width}x{height}"),
            range(12, 4)?,
            None,
        ));
    }
    if timebase_rate == 0 || timebase_scale == 0 {
        diagnostics.push(diagnostic(
            "IVF_TIMEBASE_INVALID",
            Severity::Warning,
            format!("IVF timebase rate/scale is {timebase_rate}/{timebase_scale}"),
            range(16, 8)?,
            None,
        ));
    }

    let container = IvfContainer {
        version,
        header_length,
        codec,
        width,
        height,
        timebase_rate,
        timebase_scale,
        declared_frame_count,
    };
    let mut frames = Vec::new();
    let mut cursor = usize::from(header_length);
    let mut limit_reached = false;
    while cursor < input.len() {
        let frame_id = u64::try_from(frames.len()).map_err(|_| ParseError::OffsetOverflow)?;
        if frames.len() >= maximum_frames {
            diagnostics.push(diagnostic(
                "FRAME_RECORD_LIMIT_REACHED",
                Severity::Error,
                "Frame indexing stopped at the configured record budget",
                range(cursor, 0)?,
                Some(frame_id),
            ));
            limit_reached = true;
            break;
        }
        let remaining = input.len() - cursor;
        if remaining < FRAME_HEADER_BYTES {
            diagnostics.push(diagnostic(
                "IVF_FRAME_HEADER_TRUNCATED",
                Severity::Error,
                format!("Only {remaining} bytes remain for an IVF frame header"),
                range(cursor, remaining)?,
                Some(frame_id),
            ));
            break;
        }

        let frame_start = cursor;
        let declared_size = read_u32(input, cursor);
        let timestamp = read_u64(input, cursor + 4);
        let payload_start = cursor
            .checked_add(FRAME_HEADER_BYTES)
            .ok_or(ParseError::OffsetOverflow)?;
        let available = input.len() - payload_start;
        let declared_usize = usize::try_from(declared_size)
            .map_err(|_| ParseError::OffsetOverflow)?;
        let actual_size = declared_usize.min(available);
        let complete = declared_usize <= available;
        let sample_length = FRAME_HEADER_BYTES
            .checked_add(actual_size)
            .ok_or(ParseError::OffsetOverflow)?;
        frames.push(IvfFrame {
            schema_version: SCHEMA_VERSION,
            frame_id,
            decode_index: frame_id,
            timestamp,
            sample_range: range(frame_start, sample_length)?,
            payload_range: range(payload_start, actual_size)?,
            declared_size,
            complete,
        });
        cursor = payload_start
            .checked_add(actual_size)
            .ok_or(ParseError::OffsetOverflow)?;
        if !complete {
            diagnostics.push(diagnostic(
                "IVF_FRAME_PAYLOAD_TRUNCATED",
                Severity::Error,
                format!(
                    "Frame declares {declared_size} bytes but only {available} remain"
                ),
                range(payload_start, available)?,
                Some(frame_id),
            ));
            break;
        }
    }

    if u64::from(declared_frame_count)
        != u64::try_from(frames.len()).map_err(|_| ParseError::OffsetOverflow)?
    {
        diagnostics.push(diagnostic(
            "IVF_FRAME_COUNT_MISMATCH",
            Severity::Warning,
            format!(
                "IVF declares {declared_frame_count} frames but {} were indexed",
                frames.len()
            ),
            range(24, 4)?,
            None,
        ));
    }

    Ok(IvfIndex {
        container: Some(container),
        frames,
        diagnostics,
        limit_reached,
    })
}

#[cfg(test)]
mod tests {
    use av1_model::{Diagnostic, Severity};

    use super::{IvfContainer, IvfFrame, ParseError, parse_ivf};

    const SHARED_GOLDEN: &str = include_str!(
        "../../../../test/fixtures/ivf-index-golden-v1.tsv"
    );

    fn decode_hex(input: &str) -> Vec<u8> {
        fn nibble(value: u8) -> u8 {
            match value {
                b'0'..=b'9' => value - b'0',
                b'a'..=b'f' => value - b'a' + 10,
                b'A'..=b'F' => value - b'A' + 10,
                _ => panic!("invalid shared Golden hex"),
            }
        }

        let bytes = input.as_bytes();
        assert_eq!(bytes.len() % 2, 0, "shared Golden hex must be even");
        bytes
            .chunks_exact(2)
            .map(|pair| (nibble(pair[0]) << 4) | nibble(pair[1]))
            .collect()
    }

    const fn severity_name(severity: Severity) -> &'static str {
        match severity {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
            Severity::Fatal => "fatal",
        }
    }

    fn canonical_container(container: Option<IvfContainer>) -> String {
        container.map_or_else(
            || "-".to_owned(),
            |value| {
                format!(
                    "{}/{}/{}/{}/{}/{}/{}/{}",
                    value.version,
                    value.header_length,
                    String::from_utf8_lossy(&value.codec),
                    value.width,
                    value.height,
                    value.timebase_rate,
                    value.timebase_scale,
                    value.declared_frame_count
                )
            },
        )
    }

    fn canonical_frame(frame: &IvfFrame) -> String {
        format!(
            "{}/{}/{}:{}/{}:{}/{}/{}",
            frame.frame_id,
            frame.timestamp,
            frame.sample_range.start,
            frame.sample_range.length,
            frame.payload_range.start,
            frame.payload_range.length,
            frame.declared_size,
            u8::from(frame.complete)
        )
    }

    fn canonical_diagnostic(diagnostic: &Diagnostic) -> String {
        let byte_range = diagnostic.byte_range.unwrap();
        let frame_id = diagnostic
            .frame_id
            .map_or_else(|| "-".to_owned(), |value| value.to_string());
        format!(
            "{}@{}@{}:{}@{}",
            diagnostic.code,
            severity_name(diagnostic.severity),
            byte_range.start,
            byte_range.length,
            frame_id
        )
    }

    #[test]
    fn rejects_non_ivf_and_zero_budget() {
        assert_eq!(parse_ivf(b"nope", 1), Err(ParseError::NotIvf));
        assert_eq!(parse_ivf(b"DKIF", 0), Err(ParseError::InvalidFrameBudget));
    }

    #[test]
    fn shared_golden_matches_node_reference_contract() {
        for line in SHARED_GOLDEN
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let columns: Vec<_> = line.split('\t').collect();
            assert_eq!(columns.len(), 6, "invalid Golden row: {line}");
            let name = columns[0];
            let input = decode_hex(columns[1]);
            let parsed = parse_ivf(&input, columns[2].parse().unwrap()).unwrap();
            assert_eq!(
                canonical_container(parsed.container),
                columns[3],
                "container mismatch: {name}"
            );
            let frames = parsed
                .frames
                .iter()
                .map(canonical_frame)
                .collect::<Vec<_>>()
                .join(";");
            let diagnostics = parsed
                .diagnostics
                .iter()
                .map(canonical_diagnostic)
                .collect::<Vec<_>>()
                .join(";");
            assert_eq!(
                if frames.is_empty() { "-" } else { &frames },
                columns[4],
                "frame mismatch: {name}"
            );
            assert_eq!(
                if diagnostics.is_empty() { "-" } else { &diagnostics },
                columns[5],
                "diagnostic mismatch: {name}"
            );
        }
    }
}
