#![forbid(unsafe_code)]

use av1_model::{
    ByteRange, Diagnostic, ObuHeader, ObuRecord, ObuType, SCHEMA_VERSION,
    Severity, SyntaxStatus,
};
use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParseOptions {
    pub start: usize,
    pub end: usize,
    pub frame_id: Option<u64>,
    pub allow_unsized_final_obu: bool,
    pub next_obu_id: u64,
    pub maximum_obus: usize,
}

impl ParseOptions {
    #[must_use]
    pub const fn for_input(length: usize) -> Self {
        Self {
            start: 0,
            end: length,
            frame_id: None,
            allow_unsized_final_obu: false,
            next_obu_id: 0,
            maximum_obus: 250_000,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObuIndex {
    pub obus: Vec<ObuRecord>,
    pub diagnostics: Vec<Diagnostic>,
    pub next_obu_id: u64,
    pub limit_reached: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseError {
    InvalidRange,
    IdentifierOverflow,
    OffsetOverflow,
}

impl fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRange => "OBU sequence range is outside input",
            Self::IdentifierOverflow => "OBU identifier overflow",
            Self::OffsetOverflow => "OBU offset arithmetic overflow",
        })
    }
}

impl std::error::Error for ParseError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Leb128Error {
    Truncated { start: usize, length: usize },
    TooLong { start: usize, length: usize },
    ValueTooLarge { start: usize, length: usize },
}

fn read_leb128(input: &[u8], start: usize, end: usize) -> Result<(u64, usize), Leb128Error> {
    let mut value = 0_u64;
    for length in 1..=8 {
        let offset = start
            .checked_add(length - 1)
            .ok_or(Leb128Error::ValueTooLarge { start, length })?;
        if offset >= end {
            return Err(Leb128Error::Truncated {
                start,
                length: end.saturating_sub(start),
            });
        }
        let byte = input[offset];
        let payload = u64::from(byte & 0x7f);
        value |= payload << (7 * (length - 1));
        if byte & 0x80 == 0 {
            if value > 9_007_199_254_740_991 {
                return Err(Leb128Error::ValueTooLarge { start, length });
            }
            return Ok((value, length));
        }
    }
    Err(Leb128Error::TooLong { start, length: 8 })
}

fn diagnostic(
    code: &'static str,
    severity: Severity,
    message: impl Into<String>,
    byte_range: Option<ByteRange>,
    frame_id: Option<u64>,
    obu_id: Option<u64>,
) -> Diagnostic {
    Diagnostic {
        schema_version: SCHEMA_VERSION,
        code,
        severity,
        message: message.into(),
        byte_range,
        frame_id,
        obu_id,
    }
}

#[allow(clippy::too_many_arguments)]
fn record(
    obu_id: u64,
    frame_id: Option<u64>,
    obu_type: ObuType,
    header: ObuHeader,
    start: usize,
    header_length: usize,
    size_field_start: usize,
    size_field_length: usize,
    payload_start: usize,
    actual_payload_length: usize,
    declared_payload_size: Option<u64>,
    complete: bool,
) -> Result<ObuRecord, ParseError> {
    let total = header_length
        .checked_add(size_field_length)
        .and_then(|value| value.checked_add(actual_payload_length))
        .ok_or(ParseError::OffsetOverflow)?;
    let syntax_status = if complete && obu_type.syntax_is_deferred() {
        SyntaxStatus::Pending
    } else {
        SyntaxStatus::NotApplicable
    };
    Ok(ObuRecord {
        schema_version: SCHEMA_VERSION,
        obu_id,
        frame_id,
        obu_type,
        header,
        byte_range: ByteRange::new(start as u64, total as u64),
        header_range: ByteRange::new(start as u64, header_length as u64),
        size_field_range: header.has_size_field.then_some(ByteRange::new(
            size_field_start as u64,
            size_field_length as u64,
        )),
        payload_range: ByteRange::new(payload_start as u64, actual_payload_length as u64),
        declared_payload_size,
        complete,
        syntax_status,
    })
}

/// Parses a low-overhead OBU sequence while retaining a stable valid prefix.
///
/// # Errors
///
/// Returns an error when the caller range is invalid or when record ID/offset
/// arithmetic cannot be represented. Malformed input is otherwise returned as
/// incomplete records plus stable diagnostics.
#[allow(clippy::too_many_lines)]
pub fn parse_obu_sequence(
    input: &[u8],
    options: ParseOptions,
) -> Result<ObuIndex, ParseError> {
    if options.start > options.end || options.end > input.len() {
        return Err(ParseError::InvalidRange);
    }
    let mut cursor = options.start;
    let mut next_obu_id = options.next_obu_id;
    let mut obus = Vec::new();
    let mut diagnostics = Vec::new();
    let mut limit_reached = false;

    while cursor < options.end {
        if obus.len() >= options.maximum_obus {
            diagnostics.push(diagnostic(
                "OBU_RECORD_LIMIT_REACHED",
                Severity::Error,
                "OBU indexing stopped at the configured record budget",
                Some(ByteRange::new(cursor as u64, 0)),
                options.frame_id,
                None,
            ));
            limit_reached = true;
            break;
        }
        let obu_id = next_obu_id;
        next_obu_id = next_obu_id
            .checked_add(1)
            .ok_or(ParseError::IdentifierOverflow)?;
        let obu_start = cursor;
        let byte = input[cursor];
        cursor += 1;
        let forbidden_bit = byte & 0x80 != 0;
        let type_code = (byte >> 3) & 0x0f;
        let extension_flag = byte & 0x04 != 0;
        let has_size_field = byte & 0x02 != 0;
        let reserved_bit = byte & 0x01 != 0;
        let obu_type = ObuType::from_code(type_code);
        let mut temporal_id = None;
        let mut spatial_id = None;
        let mut header_length = 1;

        if forbidden_bit {
            diagnostics.push(diagnostic(
                "OBU_FORBIDDEN_BIT_SET",
                Severity::Error,
                "obu_forbidden_bit must be zero",
                Some(ByteRange::new(obu_start as u64, 1)),
                options.frame_id,
                Some(obu_id),
            ));
        }
        if reserved_bit {
            diagnostics.push(diagnostic(
                "OBU_RESERVED_BIT_SET",
                Severity::Error,
                "obu_reserved_1bit must be zero",
                Some(ByteRange::new(obu_start as u64, 1)),
                options.frame_id,
                Some(obu_id),
            ));
        }
        if matches!(obu_type, ObuType::Reserved(_)) {
            diagnostics.push(diagnostic(
                "OBU_RESERVED_TYPE",
                Severity::Warning,
                format!("OBU type {type_code} is reserved"),
                Some(ByteRange::new(obu_start as u64, 1)),
                options.frame_id,
                Some(obu_id),
            ));
        }

        if extension_flag {
            if cursor >= options.end {
                let header = ObuHeader {
                    forbidden_bit,
                    extension_flag,
                    has_size_field,
                    reserved_bit,
                    temporal_id,
                    spatial_id,
                };
                obus.push(record(
                    obu_id,
                    options.frame_id,
                    obu_type,
                    header,
                    obu_start,
                    header_length,
                    cursor,
                    0,
                    cursor,
                    0,
                    None,
                    false,
                )?);
                diagnostics.push(diagnostic(
                    "OBU_EXTENSION_TRUNCATED",
                    Severity::Error,
                    "OBU extension header is missing",
                    Some(ByteRange::new(cursor as u64, 0)),
                    options.frame_id,
                    Some(obu_id),
                ));
                break;
            }
            let extension = input[cursor];
            temporal_id = Some((extension >> 5) & 0x07);
            spatial_id = Some((extension >> 3) & 0x03);
            cursor += 1;
            header_length += 1;
            if extension & 0x07 != 0 {
                diagnostics.push(diagnostic(
                    "OBU_EXTENSION_RESERVED_BITS_SET",
                    Severity::Error,
                    "OBU extension reserved bits must be zero",
                    Some(ByteRange::new((cursor - 1) as u64, 1)),
                    options.frame_id,
                    Some(obu_id),
                ));
            }
        }

        let size_field_start = cursor;
        let mut size_field_length = 0;
        let declared_payload_size;
        if has_size_field {
            match read_leb128(input, cursor, options.end) {
                Ok((value, length)) => {
                    declared_payload_size = Some(value);
                    size_field_length = length;
                    cursor += length;
                }
                Err(error) => {
                    let (code, start, length) = match error {
                        Leb128Error::Truncated { start, length } => {
                            ("LEB128_TRUNCATED", start, length)
                        }
                        Leb128Error::TooLong { start, length } => {
                            ("LEB128_TOO_LONG", start, length)
                        }
                        Leb128Error::ValueTooLarge { start, length } => {
                            ("LEB128_VALUE_TOO_LARGE", start, length)
                        }
                    };
                    let header = ObuHeader {
                        forbidden_bit,
                        extension_flag,
                        has_size_field,
                        reserved_bit,
                        temporal_id,
                        spatial_id,
                    };
                    let payload_start = start.saturating_add(length).min(options.end);
                    obus.push(record(
                        obu_id,
                        options.frame_id,
                        obu_type,
                        header,
                        obu_start,
                        header_length,
                        size_field_start,
                        length,
                        payload_start,
                        0,
                        None,
                        false,
                    )?);
                    diagnostics.push(diagnostic(
                        code,
                        Severity::Error,
                        "OBU size field is invalid or truncated",
                        Some(ByteRange::new(start as u64, length as u64)),
                        options.frame_id,
                        Some(obu_id),
                    ));
                    break;
                }
            }
        } else if options.allow_unsized_final_obu {
            declared_payload_size = None;
        } else {
            declared_payload_size = None;
            let header = ObuHeader {
                forbidden_bit,
                extension_flag,
                has_size_field,
                reserved_bit,
                temporal_id,
                spatial_id,
            };
            obus.push(record(
                obu_id,
                options.frame_id,
                obu_type,
                header,
                obu_start,
                header_length,
                size_field_start,
                0,
                cursor,
                0,
                None,
                false,
            )?);
            diagnostics.push(diagnostic(
                "OBU_SIZE_FIELD_REQUIRED",
                Severity::Error,
                "OBU has no size field and no enclosing sample boundary",
                Some(ByteRange::new(obu_start as u64, header_length as u64)),
                options.frame_id,
                Some(obu_id),
            ));
            break;
        }

        let payload_start = cursor;
        let header = ObuHeader {
            forbidden_bit,
            extension_flag,
            has_size_field,
            reserved_bit,
            temporal_id,
            spatial_id,
        };
        if !has_size_field {
            let actual = options.end - payload_start;
            obus.push(record(
                obu_id,
                options.frame_id,
                obu_type,
                header,
                obu_start,
                header_length,
                size_field_start,
                0,
                payload_start,
                actual,
                None,
                true,
            )?);
            diagnostics.push(diagnostic(
                "OBU_BOUNDARY_FROM_CONTAINER",
                Severity::Info,
                "OBU payload consumes the remaining container sample",
                Some(ByteRange::new(
                    obu_start as u64,
                    (options.end - obu_start) as u64,
                )),
                options.frame_id,
                Some(obu_id),
            ));
            cursor = options.end;
            continue;
        }

        let declared = declared_payload_size.unwrap_or(0);
        let available = (options.end - payload_start) as u64;
        let actual = usize::try_from(declared.min(available))
            .map_err(|_| ParseError::OffsetOverflow)?;
        let complete = declared <= available;
        obus.push(record(
            obu_id,
            options.frame_id,
            obu_type,
            header,
            obu_start,
            header_length,
            size_field_start,
            size_field_length,
            payload_start,
            actual,
            declared_payload_size,
            complete,
        )?);
        cursor = payload_start
            .checked_add(actual)
            .ok_or(ParseError::OffsetOverflow)?;
        if !complete {
            diagnostics.push(diagnostic(
                "OBU_PAYLOAD_TRUNCATED",
                Severity::Error,
                format!("OBU declares {declared} payload bytes but only {available} remain"),
                Some(ByteRange::new(payload_start as u64, actual as u64)),
                options.frame_id,
                Some(obu_id),
            ));
            break;
        }
    }

    Ok(ObuIndex {
        obus,
        diagnostics,
        next_obu_id,
        limit_reached,
    })
}

#[cfg(test)]
mod tests {
    use av1_model::{
        ByteRange, Diagnostic, ObuRecord, ObuType, Severity, SyntaxStatus,
    };

    use super::{ParseOptions, parse_obu_sequence};

    const SHARED_GOLDEN: &str = include_str!(
        "../../../../test/fixtures/obu-structural-golden-v1.tsv"
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

    fn optional_u64(value: &str) -> Option<u64> {
        (value != "-").then(|| value.parse().unwrap())
    }

    fn optional_usize(value: &str) -> Option<usize> {
        (value != "-").then(|| value.parse().unwrap())
    }

    const fn syntax_status_name(status: SyntaxStatus) -> &'static str {
        match status {
            SyntaxStatus::Pending => "pending",
            SyntaxStatus::Partial => "partial",
            SyntaxStatus::Complete => "complete",
            SyntaxStatus::Error => "error",
            SyntaxStatus::NotApplicable => "not_applicable",
        }
    }

    const fn severity_name(severity: Severity) -> &'static str {
        match severity {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
            Severity::Fatal => "fatal",
        }
    }

    fn canonical_record(record: &ObuRecord) -> String {
        let size_range = record.size_field_range.map_or_else(
            || "-".to_owned(),
            |range| format!("{}:{}", range.start, range.length),
        );
        format!(
            "{}/{}/{}/{}/{}/{}/{}/{}/{}/{}/{}/{}/{}/{}",
            record.obu_id,
            record.obu_type.code(),
            record.byte_range.start,
            record.byte_range.length,
            record.header_range.start,
            record.header_range.length,
            size_range,
            record.payload_range.start,
            record.payload_range.length,
            record
                .declared_payload_size
                .map_or_else(|| "-".to_owned(), |value| value.to_string()),
            u8::from(record.complete),
            record
                .header
                .temporal_id
                .map_or_else(|| "-".to_owned(), |value| value.to_string()),
            record
                .header
                .spatial_id
                .map_or_else(|| "-".to_owned(), |value| value.to_string()),
            syntax_status_name(record.syntax_status),
        )
    }

    fn canonical_diagnostic(diagnostic: &Diagnostic) -> String {
        let range = diagnostic.byte_range.map_or_else(
            || "-".to_owned(),
            |value| format!("{}:{}", value.start, value.length),
        );
        let obu_id = diagnostic
            .obu_id
            .map_or_else(|| "-".to_owned(), |value| value.to_string());
        format!(
            "{}@{}@{}@{}",
            diagnostic.code,
            range,
            obu_id,
            severity_name(diagnostic.severity)
        )
    }

    #[test]
    fn golden_two_obu_ranges_match_node_reference_contract() {
        let input = [0x12, 0x00, 0x7e, 0x20, 0x02, 0xaa, 0xbb];
        let parsed = parse_obu_sequence(&input, ParseOptions::for_input(input.len())).unwrap();
        assert!(parsed.diagnostics.is_empty());
        assert_eq!(parsed.obus.len(), 2);
        assert_eq!(parsed.obus[0].obu_type, ObuType::TemporalDelimiter);
        assert_eq!(parsed.obus[0].byte_range, ByteRange::new(0, 2));
        assert_eq!(parsed.obus[0].payload_range, ByteRange::new(2, 0));
        assert_eq!(parsed.obus[1].obu_type, ObuType::Padding);
        assert_eq!(parsed.obus[1].header.temporal_id, Some(1));
        assert_eq!(parsed.obus[1].byte_range, ByteRange::new(2, 5));
        assert_eq!(parsed.obus[1].header_range, ByteRange::new(2, 2));
        assert_eq!(parsed.obus[1].size_field_range, Some(ByteRange::new(4, 1)));
        assert_eq!(parsed.obus[1].payload_range, ByteRange::new(5, 2));
        assert_eq!(parsed.obus[1].syntax_status, SyntaxStatus::NotApplicable);
    }

    #[test]
    fn truncation_retains_a_stable_prefix() {
        let input = [0x0a, 0x80];
        let parsed = parse_obu_sequence(&input, ParseOptions::for_input(input.len())).unwrap();
        assert_eq!(parsed.obus.len(), 1);
        assert!(!parsed.obus[0].complete);
        assert_eq!(parsed.diagnostics[0].code, "LEB128_TRUNCATED");
    }

    #[test]
    fn record_budget_is_explicitly_incomplete() {
        let input = [0x12, 0x00, 0x12, 0x00];
        let mut options = ParseOptions::for_input(input.len());
        options.maximum_obus = 1;
        let parsed = parse_obu_sequence(&input, options).unwrap();
        assert!(parsed.limit_reached);
        assert_eq!(parsed.obus.len(), 1);
        assert_eq!(parsed.diagnostics[0].code, "OBU_RECORD_LIMIT_REACHED");
    }

    #[test]
    fn shared_golden_matches_node_reference_contract() {
        for line in SHARED_GOLDEN
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let columns: Vec<_> = line.split('\t').collect();
            assert_eq!(columns.len(), 12, "invalid Golden row: {line}");
            let name = columns[0];
            let input = decode_hex(columns[1]);
            let mut options = ParseOptions::for_input(input.len());
            options.start = columns[2].parse().unwrap();
            options.end = optional_usize(columns[3]).unwrap_or(input.len());
            options.allow_unsized_final_obu = columns[4] == "1";
            options.maximum_obus = optional_usize(columns[5]).unwrap_or(usize::MAX);
            options.next_obu_id = columns[6].parse().unwrap();
            options.frame_id = optional_u64(columns[7]);

            let parsed = parse_obu_sequence(&input, options).unwrap();
            let records = parsed
                .obus
                .iter()
                .map(canonical_record)
                .collect::<Vec<_>>()
                .join(";");
            let diagnostics = parsed
                .diagnostics
                .iter()
                .map(canonical_diagnostic)
                .collect::<Vec<_>>()
                .join(";");
            assert_eq!(
                if records.is_empty() { "-" } else { &records },
                columns[8],
                "record mismatch: {name}"
            );
            assert_eq!(
                if diagnostics.is_empty() { "-" } else { &diagnostics },
                columns[9],
                "diagnostic mismatch: {name}"
            );
            assert_eq!(
                parsed.next_obu_id,
                columns[10].parse().unwrap(),
                "next ID mismatch: {name}"
            );
            assert_eq!(
                parsed.limit_reached,
                columns[11] == "1",
                "limit mismatch: {name}"
            );
        }
    }
}
