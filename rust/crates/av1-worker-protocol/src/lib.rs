#![forbid(unsafe_code)]

use av1_model::ByteRange;
use core::fmt;

pub const PROTOCOL_NAME: &str = "av1scope.native-demux-worker.v1";
pub const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_RECORDS: u64 = 250_000;
const HEADER_BYTES: usize = 16;
const RECORD_BYTES: usize = 72;
const RECORD_BYTES_U32: u32 = 72;
const MAGIC: &[u8; 8] = b"A1DMO01\0";
const REQUEST_MAGIC: &[u8; 8] = b"A1DMX01\0";
const REQUEST_BYTES: usize = 56;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodeLimits {
    pub source_bytes: u64,
    pub maximum_sample_bytes: u64,
    pub maximum_records: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RequestOptions {
    pub source_bytes: u64,
    pub maximum_probe_bytes: u64,
    pub maximum_sample_bytes: u64,
    pub maximum_records: u64,
    pub requested_track_id: Option<i32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamInfo {
    pub track_id: i32,
    pub width: u32,
    pub height: u32,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub sample_count: Option<u64>,
    pub adapter_version: (u8, u8, u8),
    pub adapter_feature_flags: u32,
    pub worker_sandbox_flags: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Sample {
    pub sample_id: u64,
    pub track_id: i32,
    pub flags: u32,
    pub dts: i64,
    pub pts: i64,
    pub duration: i64,
    pub source_range: ByteRange,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DemuxResponse {
    pub stream: StreamInfo,
    pub samples: Vec<Sample>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecodeError {
    InvalidLimits,
    InvalidFraming,
    RecordBudget,
    UnknownStatus(u32),
    NativeStatus(u32),
    InvalidErrorRecord,
    StatusKindMismatch,
    DuplicateStream,
    NonCanonicalSigned32,
    InvalidStream,
    InvalidSampleOrder,
    InvalidSample,
    InvalidEnd,
    UnknownKind(u32),
    Incomplete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestError {
    InputTooLarge,
    InvalidProbeBudget,
    InvalidSampleBudget,
    InvalidRecordBudget,
    InvalidTrack,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid native demux response: {self:?}")
    }
}

impl std::error::Error for DecodeError {}

impl fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid native demux request: {self:?}")
    }
}

impl std::error::Error for RequestError {}

/// Encodes the fixed 56-byte Worker v1 request header.
///
/// The media bytes immediately follow the returned header on stdin.
///
/// # Errors
///
/// Rejects input, probe, sample, record and track values outside Worker v1.
pub fn encode_request(options: RequestOptions) -> Result<[u8; REQUEST_BYTES], RequestError> {
    if options.source_bytes > MAX_INPUT_BYTES {
        return Err(RequestError::InputTooLarge);
    }
    if !(32..=268_435_456).contains(&options.maximum_probe_bytes) {
        return Err(RequestError::InvalidProbeBudget);
    }
    if !(1..=1_073_741_824).contains(&options.maximum_sample_bytes) {
        return Err(RequestError::InvalidSampleBudget);
    }
    if !(1..=MAX_RECORDS).contains(&options.maximum_records) {
        return Err(RequestError::InvalidRecordBudget);
    }
    if options.requested_track_id.is_some_and(|track| track < 0) {
        return Err(RequestError::InvalidTrack);
    }
    let mut output = [0_u8; REQUEST_BYTES];
    output[..8].copy_from_slice(REQUEST_MAGIC);
    output[8..12].copy_from_slice(&1_u32.to_le_bytes());
    output[12..16].copy_from_slice(&56_u32.to_le_bytes());
    output[16..24].copy_from_slice(&options.source_bytes.to_le_bytes());
    output[24..32].copy_from_slice(&options.maximum_probe_bytes.to_le_bytes());
    output[32..40].copy_from_slice(&options.maximum_sample_bytes.to_le_bytes());
    output[40..48].copy_from_slice(&options.maximum_records.to_le_bytes());
    output[48..52].copy_from_slice(
        &options.requested_track_id.unwrap_or(-1).to_le_bytes(),
    );
    Ok(output)
}

fn u32_le(bytes: &[u8], offset: usize) -> Result<u32, DecodeError> {
    let end = offset
        .checked_add(4)
        .ok_or(DecodeError::InvalidFraming)?;
    let value = bytes
        .get(offset..end)
        .ok_or(DecodeError::InvalidFraming)?;
    Ok(u32::from_le_bytes(value.try_into().map_err(|_| DecodeError::InvalidFraming)?))
}

fn u64_le(bytes: &[u8], offset: usize) -> Result<u64, DecodeError> {
    let end = offset
        .checked_add(8)
        .ok_or(DecodeError::InvalidFraming)?;
    let value = bytes
        .get(offset..end)
        .ok_or(DecodeError::InvalidFraming)?;
    Ok(u64::from_le_bytes(value.try_into().map_err(|_| DecodeError::InvalidFraming)?))
}

fn known_status(status: u32) -> Result<(), DecodeError> {
    if status <= 8 {
        Ok(())
    } else {
        Err(DecodeError::UnknownStatus(status))
    }
}

fn signed32(value: u64) -> Result<i32, DecodeError> {
    let low = u32::try_from(value & u64::from(u32::MAX))
        .map_err(|_| DecodeError::NonCanonicalSigned32)?;
    let decoded = i32::from_le_bytes(low.to_le_bytes());
    let canonical = u64::from_le_bytes(i64::from(decoded).to_le_bytes());
    if value != canonical {
        return Err(DecodeError::NonCanonicalSigned32);
    }
    Ok(decoded)
}

fn values(bytes: &[u8], offset: usize) -> Result<[u64; 8], DecodeError> {
    let mut output = [0_u64; 8];
    for (index, value) in output.iter_mut().enumerate() {
        let value_offset = index
            .checked_mul(8)
            .and_then(|relative| relative.checked_add(8))
            .and_then(|relative| offset.checked_add(relative))
            .ok_or(DecodeError::InvalidFraming)?;
        *value = u64_le(bytes, value_offset)?;
    }
    Ok(output)
}

/// Decodes and validates a complete Worker v1 stdout message.
///
/// # Errors
///
/// Rejects framing/version drift, unknown/native statuses, record ordering,
/// non-canonical signed fields, flags, ranges, budgets and reserved values.
pub fn decode_response(
    bytes: &[u8],
    limits: DecodeLimits,
) -> Result<DemuxResponse, DecodeError> {
    if limits.source_bytes > MAX_INPUT_BYTES
        || limits.maximum_sample_bytes == 0
        || limits.maximum_records == 0
        || limits.maximum_records > MAX_RECORDS
    {
        return Err(DecodeError::InvalidLimits);
    }
    if bytes.len() < HEADER_BYTES
        || bytes.get(..8) != Some(MAGIC.as_slice())
        || u32_le(bytes, 8)? != 1
        || u32_le(bytes, 12)? != RECORD_BYTES_U32
        || (bytes.len() - HEADER_BYTES) % RECORD_BYTES != 0
    {
        return Err(DecodeError::InvalidFraming);
    }
    let record_count = (bytes.len() - HEADER_BYTES) / RECORD_BYTES;
    let maximum_records = usize::try_from(limits.maximum_records)
        .map_err(|_| DecodeError::RecordBudget)?;
    let maximum_protocol_records = maximum_records
        .checked_add(2)
        .ok_or(DecodeError::RecordBudget)?;
    if record_count == 0 || record_count > maximum_protocol_records {
        return Err(DecodeError::RecordBudget);
    }
    let mut stream = None;
    let mut samples = Vec::with_capacity(record_count.saturating_sub(2));
    let mut ended = false;
    for index in 0..record_count {
        let offset = index
            .checked_mul(RECORD_BYTES)
            .and_then(|relative| HEADER_BYTES.checked_add(relative))
            .ok_or(DecodeError::InvalidFraming)?;
        let kind = u32_le(bytes, offset)?;
        let status_offset = offset
            .checked_add(4)
            .ok_or(DecodeError::InvalidFraming)?;
        let status = u32_le(bytes, status_offset)?;
        known_status(status)?;
        let value = values(bytes, offset)?;
        if kind == 4 {
            if index + 1 != record_count
                || status <= 1
                || value.iter().any(|item| *item != 0)
            {
                return Err(DecodeError::InvalidErrorRecord);
            }
            return Err(DecodeError::NativeStatus(status));
        }
        let expected_status = if kind == 3 { 1 } else { 0 };
        if status != expected_status {
            return Err(DecodeError::StatusKindMismatch);
        }
        match kind {
            1 => {
                if stream.is_some() || index != 0 {
                    return Err(DecodeError::DuplicateStream);
                }
                let track_id = signed32(value[0])?;
                let width = u32::try_from(value[1]).map_err(|_| DecodeError::InvalidStream)?;
                let height = u32::try_from(value[2]).map_err(|_| DecodeError::InvalidStream)?;
                let time_base_num = signed32(value[3])?;
                let time_base_den = signed32(value[4])?;
                let version = u32::try_from(value[6]).map_err(|_| DecodeError::InvalidStream)?;
                let flags = u32::try_from(value[7] & u64::from(u32::MAX))
                    .map_err(|_| DecodeError::InvalidStream)?;
                let worker_sandbox_flags = u32::try_from(value[7] >> 32)
                    .map_err(|_| DecodeError::InvalidStream)?;
                if track_id < 0
                    || width == 0
                    || height == 0
                    || time_base_num <= 0
                    || time_base_den <= 0
                    || version == 0
                    || flags & !3 != 0
                    || worker_sandbox_flags & !31 != 0
                    || flags & 1 == 0
                {
                    return Err(DecodeError::InvalidStream);
                }
                stream = Some(StreamInfo {
                    track_id,
                    width,
                    height,
                    time_base_num,
                    time_base_den,
                    sample_count: (value[5] != 0).then_some(value[5]),
                    adapter_version: (
                        u8::try_from(version >> 16).map_err(|_| DecodeError::InvalidStream)?,
                        u8::try_from((version >> 8) & 0xff)
                            .map_err(|_| DecodeError::InvalidStream)?,
                        u8::try_from(version & 0xff)
                            .map_err(|_| DecodeError::InvalidStream)?,
                    ),
                    adapter_feature_flags: flags,
                    worker_sandbox_flags,
                });
            }
            2 => {
                let selected = stream.as_ref().ok_or(DecodeError::InvalidSampleOrder)?;
                if ended || samples.len() >= maximum_records {
                    return Err(DecodeError::InvalidSampleOrder);
                }
                let sample_id = value[0];
                let track_id = signed32(value[1])?;
                let flags = u32::try_from(value[2]).map_err(|_| DecodeError::InvalidSample)?;
                let range = ByteRange::new(value[6], value[7]);
                let expected_id = u64::try_from(samples.len())
                    .map_err(|_| DecodeError::InvalidSample)?;
                if sample_id != expected_id
                    || track_id != selected.track_id
                    || flags & !7 != 0
                    || range.length > limits.maximum_sample_bytes
                    || range.checked_end().is_none_or(|end| end > limits.source_bytes)
                {
                    return Err(DecodeError::InvalidSample);
                }
                samples.push(Sample {
                    sample_id,
                    track_id,
                    flags,
                    dts: i64::from_le_bytes(value[3].to_le_bytes()),
                    pts: i64::from_le_bytes(value[4].to_le_bytes()),
                    duration: i64::from_le_bytes(value[5].to_le_bytes()),
                    source_range: range,
                });
            }
            3 => {
                let expected_count = u64::try_from(samples.len())
                    .map_err(|_| DecodeError::InvalidEnd)?;
                if stream.is_none()
                    || ended
                    || index + 1 != record_count
                    || value[0] != expected_count
                    || value[1..].iter().any(|item| *item != 0)
                {
                    return Err(DecodeError::InvalidEnd);
                }
                ended = true;
            }
            _ => return Err(DecodeError::UnknownKind(kind)),
        }
    }
    if !ended {
        return Err(DecodeError::Incomplete);
    }
    Ok(DemuxResponse {
        stream: stream.ok_or(DecodeError::Incomplete)?,
        samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(input: &str) -> Vec<u8> {
        input
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = core::str::from_utf8(pair).unwrap();
                u8::from_str_radix(text, 16).unwrap()
            })
            .collect()
    }

    fn encode_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|value| format!("{value:02x}")).collect()
    }

    #[test]
    fn shared_worker_request_golden() {
        let corpus = include_str!("../../../../test/fixtures/native-demux-request-golden-v1.tsv");
        for line in corpus.lines().filter(|line| !line.is_empty() && !line.starts_with('#')) {
            let fields: Vec<_> = line.split('\t').collect();
            let track: i32 = fields[5].parse().unwrap();
            let actual = encode_request(RequestOptions {
                source_bytes: fields[1].parse().unwrap(),
                maximum_probe_bytes: fields[2].parse().unwrap(),
                maximum_sample_bytes: fields[3].parse().unwrap(),
                maximum_records: fields[4].parse().unwrap(),
                requested_track_id: (track >= 0).then_some(track),
            });
            let actual = match actual {
                Ok(value) => encode_hex(&value),
                Err(error) => format!("err:{error:?}"),
            };
            assert_eq!(actual, fields[6], "{}", fields[0]);
        }
    }

    #[test]
    fn shared_worker_protocol_golden() {
        let corpus = include_str!("../../../../test/fixtures/native-demux-worker-golden-v1.tsv");
        for line in corpus.lines().filter(|line| !line.is_empty() && !line.starts_with('#')) {
            let fields: Vec<_> = line.split('\t').collect();
            let response = decode_response(
                &hex(fields[1]),
                DecodeLimits {
                    source_bytes: fields[2].parse().unwrap(),
                    maximum_sample_bytes: fields[3].parse().unwrap(),
                    maximum_records: fields[4].parse().unwrap(),
                },
            );
            let actual = match response {
                Ok(value) => {
                    let security = if value.stream.worker_sandbox_flags == 0 {
                        String::new()
                    } else {
                        format!(
                            "@{}/{}",
                            value.stream.adapter_feature_flags,
                            value.stream.worker_sandbox_flags,
                        )
                    };
                    format!(
                        "ok:{}/{}/{}/{}/{}/{}{}:{}",
                        value.stream.track_id,
                        value.stream.width,
                        value.stream.height,
                        value.stream.time_base_num,
                        value.stream.time_base_den,
                        value.samples.len(),
                        security,
                        value.samples.iter().map(|sample| format!(
                            "{}/{}/{}/{}/{}/{}/{}/{}",
                            sample.sample_id, sample.track_id, sample.flags, sample.dts,
                            sample.pts, sample.duration, sample.source_range.start,
                            sample.source_range.length,
                        )).collect::<Vec<_>>().join(";")
                    )
                },
                Err(error) => format!("err:{error:?}"),
            };
            assert_eq!(actual, fields[5], "{}", fields[0]);
        }
    }
}
