#![allow(unsafe_code)]

use av1_native_guard::{ContractError, SampleLimits, normalize_status, validate_sample};
use av1_native_sys::{
    ABI_VERSION_V1, AdapterInfoV1, CallContextV1, Demux, DemuxAdapterInfoFnV1,
    DemuxCloseFnV1, DemuxNextSampleFnV1, DemuxOpenFnV1, DemuxOptionsV1,
    DemuxSourceV1, DemuxStreamInfoFnV1, DiagnosticV1, MAX_PROBE_BYTES_V1,
    MAX_SAMPLE_BYTES_V1, SampleV1, StatusCodeV1, StatusV1, StreamInfoV1,
};
use core::ffi::c_void;
use core::fmt;
use core::marker::PhantomData;
use core::mem::size_of;
use core::ptr::NonNull;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const AV01_FOURCC: u32 = 0x3130_7661;

/// A caller-owned random-access byte source retained for the demux lifetime.
pub trait ReadAtSource: Send + Sync + 'static {
    #[must_use]
    fn source_bytes(&self) -> u64;

    /// Reads at most `destination.len()` bytes from an absolute source offset.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the requested bytes cannot be read.
    fn read_at(&self, offset: u64, destination: &mut [u8]) -> io::Result<usize>;
}

#[derive(Clone, Copy, Debug)]
pub struct DemuxApiV1 {
    adapter_info: DemuxAdapterInfoFnV1,
    open: DemuxOpenFnV1,
    stream_info: DemuxStreamInfoFnV1,
    next_sample: DemuxNextSampleFnV1,
    close: DemuxCloseFnV1,
}

impl DemuxApiV1 {
    /// Creates a dispatch table for one ABI-compatible adapter library.
    ///
    /// # Safety
    ///
    /// Every function must come from the same loaded ABI v1 adapter and obey
    /// the ownership, callback, output-prefix, and diagnostic-pointer contract.
    #[must_use]
    pub const unsafe fn from_raw(
        adapter_info: DemuxAdapterInfoFnV1,
        open: DemuxOpenFnV1,
        stream_info: DemuxStreamInfoFnV1,
        next_sample: DemuxNextSampleFnV1,
        close: DemuxCloseFnV1,
    ) -> Self {
        Self {
            adapter_info,
            open,
            stream_info,
            next_sample,
            close,
        }
    }

    /// Copies process-lifetime adapter identity strings into owned Rust data.
    ///
    /// # Errors
    ///
    /// Rejects native failures, unknown statuses, invalid pointers, oversized
    /// strings, or a returned ABI version other than v1.
    pub fn adapter_info(self) -> Result<AdapterInfo, DemuxError> {
        let mut output = AdapterInfoV1 {
            struct_size: struct_size::<AdapterInfoV1>(),
            abi_version: ABI_VERSION_V1,
            name_utf8: core::ptr::null(),
            name_bytes: 0,
            reserved_0: 0,
            build_utf8: core::ptr::null(),
            build_bytes: 0,
            feature_flags: 0,
        };
        let code = unsafe { (self.adapter_info)(&raw mut output) };
        expect_ok(code, None)?;
        if output.struct_size < struct_size::<AdapterInfoV1>()
            || output.abi_version != ABI_VERSION_V1
            || output.reserved_0 != 0
        {
            return Err(DemuxError::InvalidAdapterInfo);
        }
        Ok(AdapterInfo {
            name: copy_borrowed_string(output.name_utf8, output.name_bytes)?,
            build: copy_borrowed_string(output.build_utf8, output.build_bytes)?,
            feature_flags: output.feature_flags,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterInfo {
    pub name: String,
    pub build: String,
    pub feature_flags: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DemuxOptions {
    pub requested_track_id: Option<i32>,
    pub maximum_probe_bytes: u64,
    pub maximum_sample_bytes: u64,
}

impl Default for DemuxOptions {
    fn default() -> Self {
        Self {
            requested_track_id: None,
            maximum_probe_bytes: 16 * 1024 * 1024,
            maximum_sample_bytes: MAX_SAMPLE_BYTES_V1,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug, Default)]
pub struct CallControl {
    pub deadline_unix_ms: Option<u64>,
    pub cancellation: CancellationToken,
}

impl CallControl {
    fn raw(&self) -> CallContextV1 {
        CallContextV1 {
            struct_size: struct_size::<CallContextV1>(),
            abi_version: ABI_VERSION_V1,
            deadline_unix_ms: self.deadline_unix_ms.unwrap_or(0),
            cancelled: Some(cancelled_callback),
            user_data: Arc::as_ptr(&self.cancellation.cancelled)
                .cast_mut()
                .cast::<c_void>(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamInfo {
    pub track_id: i32,
    pub width: u32,
    pub height: u32,
    pub time_base_num: i32,
    pub time_base_den: i32,
    pub sample_count: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sample {
    pub sample_id: u64,
    pub track_id: i32,
    pub flags: u32,
    pub dts: i64,
    pub pts: i64,
    pub duration: i64,
    pub source_start: u64,
    pub source_length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DemuxError {
    Contract(ContractError),
    Native { status: StatusV1, message: String },
    InvalidOptions,
    InvalidAdapterInfo,
    MissingHandle,
    InvalidStreamInfo,
    InvalidSampleSequence,
    InvalidBorrowedBytes,
}

impl fmt::Display for DemuxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Contract(error) => write!(formatter, "native contract error: {error}"),
            Self::Native { status, message } => {
                write!(formatter, "native demux returned {status:?}: {message}")
            }
            Self::InvalidOptions => formatter.write_str("invalid native demux options"),
            Self::InvalidAdapterInfo => formatter.write_str("invalid adapter identity record"),
            Self::MissingHandle => formatter.write_str("adapter returned OK without a handle"),
            Self::InvalidStreamInfo => formatter.write_str("invalid native stream record"),
            Self::InvalidSampleSequence => formatter.write_str("invalid native sample sequence"),
            Self::InvalidBorrowedBytes => formatter.write_str("invalid borrowed native bytes"),
        }
    }
}

impl std::error::Error for DemuxError {}

impl From<ContractError> for DemuxError {
    fn from(value: ContractError) -> Self {
        Self::Contract(value)
    }
}

struct SourceBridge {
    source: Arc<dyn ReadAtSource>,
    source_bytes: u64,
}

pub struct DemuxHandle {
    api: DemuxApiV1,
    raw: NonNull<Demux>,
    source: Box<SourceBridge>,
    limits: SampleLimits,
    stream: Option<StreamInfo>,
    next_sample_id: u64,
    not_send_or_sync: PhantomData<Rc<()>>,
}

impl fmt::Debug for DemuxHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DemuxHandle")
            .field("raw", &self.raw)
            .field("source_bytes", &self.source.source_bytes)
            .field("limits", &self.limits)
            .field("stream", &self.stream)
            .field("next_sample_id", &self.next_sample_id)
            .finish_non_exhaustive()
    }
}

impl DemuxHandle {
    /// Opens a native demux handle while retaining the callback source.
    ///
    /// # Errors
    ///
    /// Rejects invalid budgets/source sizes, any native failure or unknown
    /// status, and an ABI violation where success returns no handle.
    pub fn open(
        api: DemuxApiV1,
        source: Arc<dyn ReadAtSource>,
        options: DemuxOptions,
        control: &CallControl,
    ) -> Result<Self, DemuxError> {
        let source_bytes = source.source_bytes();
        if source_bytes > i64::MAX.unsigned_abs()
            || options.requested_track_id.is_some_and(|track| track < 0)
            || !(32..=MAX_PROBE_BYTES_V1).contains(&options.maximum_probe_bytes)
            || !(1..=MAX_SAMPLE_BYTES_V1).contains(&options.maximum_sample_bytes)
        {
            return Err(DemuxError::InvalidOptions);
        }
        let mut bridge = Box::new(SourceBridge {
            source,
            source_bytes,
        });
        let raw_source = DemuxSourceV1 {
            struct_size: struct_size::<DemuxSourceV1>(),
            abi_version: ABI_VERSION_V1,
            source_bytes,
            read_at: Some(read_at_callback),
            user_data: (&raw mut *bridge).cast::<c_void>(),
        };
        let raw_options = DemuxOptionsV1 {
            struct_size: struct_size::<DemuxOptionsV1>(),
            abi_version: ABI_VERSION_V1,
            requested_track_id: options.requested_track_id.unwrap_or(-1),
            flags: 0,
            maximum_probe_bytes: options.maximum_probe_bytes,
            maximum_sample_bytes: options.maximum_sample_bytes,
        };
        let raw_call = control.raw();
        let mut diagnostic = empty_diagnostic();
        let mut raw = core::ptr::null_mut();
        let code = unsafe {
            (api.open)(
                &raw const raw_source,
                &raw const raw_options,
                &raw const raw_call,
                &raw mut raw,
                &raw mut diagnostic,
            )
        };
        if code != StatusV1::Ok.code() {
            let error = native_error(code, Some(&diagnostic));
            if !raw.is_null() {
                unsafe { (api.close)(raw) };
            }
            return Err(error);
        }
        let raw = NonNull::new(raw).ok_or(DemuxError::MissingHandle)?;
        Ok(Self {
            api,
            raw,
            source: bridge,
            limits: SampleLimits {
                source_bytes,
                maximum_sample_bytes: options.maximum_sample_bytes,
            },
            stream: None,
            next_sample_id: 0,
            not_send_or_sync: PhantomData,
        })
    }

    /// Returns and validates the selected AV1 stream metadata.
    ///
    /// # Errors
    ///
    /// Returns native/contract errors or rejects invalid track, codec,
    /// dimensions, and time-base values.
    pub fn stream_info(&mut self) -> Result<StreamInfo, DemuxError> {
        if let Some(stream) = self.stream {
            return Ok(stream);
        }
        let mut output = StreamInfoV1 {
            struct_size: struct_size::<StreamInfoV1>(),
            abi_version: ABI_VERSION_V1,
            track_id: 0,
            codec_fourcc: 0,
            width: 0,
            height: 0,
            time_base_num: 0,
            time_base_den: 0,
            sample_count: 0,
        };
        let mut diagnostic = empty_diagnostic();
        let code = unsafe {
            (self.api.stream_info)(
                self.raw.as_ptr(),
                &raw mut output,
                &raw mut diagnostic,
            )
        };
        expect_ok(code, Some(&diagnostic))?;
        if output.struct_size < struct_size::<StreamInfoV1>()
            || output.abi_version != ABI_VERSION_V1
            || output.track_id < 0
            || output.codec_fourcc != AV01_FOURCC
            || output.width == 0
            || output.height == 0
            || output.time_base_num <= 0
            || output.time_base_den <= 0
        {
            return Err(DemuxError::InvalidStreamInfo);
        }
        let stream = StreamInfo {
            track_id: output.track_id,
            width: output.width,
            height: output.height,
            time_base_num: output.time_base_num,
            time_base_den: output.time_base_den,
            sample_count: (output.sample_count != 0).then_some(output.sample_count),
        };
        self.stream = Some(stream);
        Ok(stream)
    }

    /// Reads, copies, and validates the next selected-track sample.
    ///
    /// # Errors
    ///
    /// Returns native/contract errors and rejects track changes, non-contiguous
    /// sample IDs, invalid flags, overflow, source escape, or budget escape.
    pub fn next_sample(&mut self, control: &CallControl) -> Result<Option<Sample>, DemuxError> {
        let stream = self.stream_info()?;
        let mut output = SampleV1 {
            struct_size: struct_size::<SampleV1>(),
            abi_version: ABI_VERSION_V1,
            sample_id: 0,
            track_id: 0,
            flags: 0,
            dts: 0,
            pts: 0,
            duration: 0,
            source_range: av1_native_sys::ByteRangeV1 {
                start: 0,
                length: 0,
            },
        };
        let raw_call = control.raw();
        let mut diagnostic = empty_diagnostic();
        let code = unsafe {
            (self.api.next_sample)(
                self.raw.as_ptr(),
                &raw const raw_call,
                &raw mut output,
                &raw mut diagnostic,
            )
        };
        let status = normalize_status(code)?;
        if status == StatusV1::End {
            return Ok(None);
        }
        if status != StatusV1::Ok {
            return Err(native_error(code, Some(&diagnostic)));
        }
        validate_sample(&output, self.limits)?;
        if output.track_id != stream.track_id || output.sample_id != self.next_sample_id {
            return Err(DemuxError::InvalidSampleSequence);
        }
        self.next_sample_id = self
            .next_sample_id
            .checked_add(1)
            .ok_or(DemuxError::InvalidSampleSequence)?;
        Ok(Some(Sample {
            sample_id: output.sample_id,
            track_id: output.track_id,
            flags: output.flags,
            dts: output.dts,
            pts: output.pts,
            duration: output.duration,
            source_start: output.source_range.start,
            source_length: output.source_range.length,
        }))
    }
}

impl Drop for DemuxHandle {
    fn drop(&mut self) {
        unsafe { (self.api.close)(self.raw.as_ptr()) };
    }
}

fn struct_size<T>() -> u32 {
    u32::try_from(size_of::<T>()).unwrap_or(u32::MAX)
}

fn empty_diagnostic() -> DiagnosticV1 {
    DiagnosticV1 {
        struct_size: struct_size::<DiagnosticV1>(),
        status: 0,
        message_utf8: core::ptr::null(),
        message_bytes: 0,
        reserved: 0,
    }
}

fn expect_ok(code: StatusCodeV1, diagnostic: Option<&DiagnosticV1>) -> Result<(), DemuxError> {
    if normalize_status(code)? == StatusV1::Ok {
        Ok(())
    } else {
        Err(native_error(code, diagnostic))
    }
}

fn native_error(code: StatusCodeV1, diagnostic: Option<&DiagnosticV1>) -> DemuxError {
    match normalize_status(code) {
        Ok(status) => DemuxError::Native {
            status,
            message: diagnostic
                .filter(|value| {
                    value.struct_size >= struct_size::<DiagnosticV1>()
                        && value.reserved == 0
                        && value.status == code
                })
                .and_then(|value| copy_borrowed_string(value.message_utf8, value.message_bytes).ok())
                .unwrap_or_default(),
        },
        Err(error) => DemuxError::Contract(error),
    }
}

fn copy_borrowed_string(pointer: *const u8, length: u32) -> Result<String, DemuxError> {
    if length > av1_native_sys::MAX_DIAGNOSTIC_BYTES_V1
        || (length != 0 && pointer.is_null())
    {
        return Err(DemuxError::InvalidBorrowedBytes);
    }
    if length == 0 {
        return Ok(String::new());
    }
    let length = usize::try_from(length).map_err(|_| DemuxError::InvalidBorrowedBytes)?;
    let bytes = unsafe { core::slice::from_raw_parts(pointer, length) };
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

unsafe extern "C" fn cancelled_callback(user_data: *mut c_void) -> u32 {
    if user_data.is_null() {
        return 0;
    }
    let cancelled = unsafe { &*user_data.cast::<AtomicBool>() };
    u32::from(cancelled.load(Ordering::Acquire))
}

unsafe extern "C" fn read_at_callback(
    user_data: *mut c_void,
    offset: u64,
    destination: *mut u8,
    capacity: u64,
) -> i64 {
    if user_data.is_null() || (capacity != 0 && destination.is_null()) {
        return -1;
    }
    let bridge = unsafe { &*user_data.cast::<SourceBridge>() };
    if offset > bridge.source_bytes {
        return -1;
    }
    let available = bridge.source_bytes - offset;
    let bounded = capacity.min(available);
    if bounded > u64::try_from(isize::MAX).unwrap_or(u64::MAX) {
        return -1;
    }
    let Ok(length) = usize::try_from(bounded) else {
        return -1;
    };
    if length == 0 {
        return 0;
    }
    let destination = unsafe { core::slice::from_raw_parts_mut(destination, length) };
    let result = catch_unwind(AssertUnwindSafe(|| bridge.source.read_at(offset, destination)));
    match result {
        Ok(Ok(count)) if count <= length => i64::try_from(count).unwrap_or(-1),
        Ok(Ok(_)) | Ok(Err(_)) | Err(_) => -1,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use av1_native_sys::{
        ByteRangeV1, DemuxSourceV1, SAMPLE_FLAG_KEYFRAME_V1,
    };

    use super::*;

    static DROPPED: AtomicBool = AtomicBool::new(false);
    static ADAPTER_NAME: &[u8] = b"mock-demux";
    static ADAPTER_BUILD: &[u8] = b"mock-build";

    #[derive(Debug)]
    struct MemorySource(Vec<u8>);

    impl ReadAtSource for MemorySource {
        fn source_bytes(&self) -> u64 {
            u64::try_from(self.0.len()).unwrap()
        }

        fn read_at(&self, offset: u64, destination: &mut [u8]) -> io::Result<usize> {
            let offset = usize::try_from(offset)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "offset"))?;
            if offset > self.0.len() {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "offset"));
            }
            let count = destination.len().min(self.0.len() - offset);
            destination[..count].copy_from_slice(&self.0[offset..offset + count]);
            Ok(count)
        }
    }

    struct MockDemux {
        source: DemuxSourceV1,
        next: u64,
    }

    unsafe extern "C" fn mock_adapter_info(output: *mut AdapterInfoV1) -> StatusCodeV1 {
        let output = unsafe { &mut *output };
        output.name_utf8 = ADAPTER_NAME.as_ptr();
        output.name_bytes = u32::try_from(ADAPTER_NAME.len()).unwrap();
        output.build_utf8 = ADAPTER_BUILD.as_ptr();
        output.build_bytes = u32::try_from(ADAPTER_BUILD.len()).unwrap();
        output.feature_flags = 3;
        StatusV1::Ok.code()
    }

    unsafe extern "C" fn mock_open(
        source: *const DemuxSourceV1,
        _options: *const DemuxOptionsV1,
        _call: *const CallContextV1,
        output: *mut *mut Demux,
        _diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1 {
        let source = unsafe { *source };
        let mut signature = [0_u8; 4];
        let read = unsafe {
            source.read_at.unwrap()(source.user_data, 0, signature.as_mut_ptr(), 4)
        };
        if read != 4 || signature != *b"DKIF" {
            return StatusV1::MalformedInput.code();
        }
        let state = Box::new(MockDemux { source, next: 0 });
        unsafe { *output = Box::into_raw(state).cast::<Demux>() };
        StatusV1::Ok.code()
    }

    unsafe extern "C" fn mock_stream_info(
        _demux: *mut Demux,
        output: *mut StreamInfoV1,
        _diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1 {
        let output = unsafe { &mut *output };
        output.track_id = 0;
        output.codec_fourcc = AV01_FOURCC;
        output.width = 64;
        output.height = 36;
        output.time_base_num = 1;
        output.time_base_den = 30;
        output.sample_count = 2;
        StatusV1::Ok.code()
    }

    unsafe extern "C" fn mock_next_sample(
        demux: *mut Demux,
        _call: *const CallContextV1,
        output: *mut SampleV1,
        _diagnostic: *mut DiagnosticV1,
    ) -> StatusCodeV1 {
        let state = unsafe { &mut *demux.cast::<MockDemux>() };
        if state.next == 2 {
            return StatusV1::End.code();
        }
        let mut byte = 0_u8;
        let read = unsafe {
            state.source.read_at.unwrap()(
                state.source.user_data,
                4 + state.next,
                &raw mut byte,
                1,
            )
        };
        if read != 1 {
            return StatusV1::AdapterError.code();
        }
        let output = unsafe { &mut *output };
        output.sample_id = state.next;
        output.track_id = 0;
        output.flags = if state.next == 0 {
            SAMPLE_FLAG_KEYFRAME_V1
        } else {
            0
        };
        output.dts = i64::try_from(state.next).unwrap();
        output.pts = i64::try_from(state.next).unwrap();
        output.duration = 1;
        output.source_range = ByteRangeV1 {
            start: 4 + state.next,
            length: 1,
        };
        state.next += 1;
        StatusV1::Ok.code()
    }

    unsafe extern "C" fn mock_close(demux: *mut Demux) {
        if !demux.is_null() {
            drop(unsafe { Box::from_raw(demux.cast::<MockDemux>()) });
            DROPPED.store(true, Ordering::Release);
        }
    }

    fn mock_api() -> DemuxApiV1 {
        unsafe {
            DemuxApiV1::from_raw(
                mock_adapter_info,
                mock_open,
                mock_stream_info,
                mock_next_sample,
                mock_close,
            )
        }
    }

    #[test]
    fn owns_source_validates_samples_and_closes_once() {
        DROPPED.store(false, Ordering::Release);
        let api = mock_api();
        assert_eq!(api.adapter_info().unwrap().name, "mock-demux");
        let source = Arc::new(MemorySource(b"DKIFpayload".to_vec()));
        let control = CallControl::default();
        let mut demux = DemuxHandle::open(api, source, DemuxOptions::default(), &control).unwrap();
        assert_eq!(demux.stream_info().unwrap().sample_count, Some(2));
        assert_eq!(demux.next_sample(&control).unwrap().unwrap().source_start, 4);
        assert_eq!(demux.next_sample(&control).unwrap().unwrap().sample_id, 1);
        assert_eq!(demux.next_sample(&control).unwrap(), None);
        assert!(!DROPPED.load(Ordering::Acquire));
        drop(demux);
        assert!(DROPPED.load(Ordering::Acquire));
    }

    #[test]
    fn cancellation_callback_uses_stable_arc_storage() {
        let token = CancellationToken::default();
        let control = CallControl {
            deadline_unix_ms: Some(123),
            cancellation: token.clone(),
        };
        let raw = control.raw();
        assert_eq!(unsafe { raw.cancelled.unwrap()(raw.user_data) }, 0);
        token.cancel();
        assert_eq!(unsafe { raw.cancelled.unwrap()(raw.user_data) }, 1);
    }
}
