/// One decoded SSE event frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental SSE decoder used for OpenAI-compatible streaming responses.
#[derive(Debug, Default)]
pub struct SseEventDecoder {
    pending_line: Vec<u8>,
    event_name: Option<String>,
    data_lines: Vec<String>,
}

impl SseEventDecoder {
    /// Pushes one text chunk into the decoder and returns completed SSE frames.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.pending_line.extend_from_slice(chunk);

        let mut events = Vec::new();
        while let Some(index) = self.pending_line.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending_line[..index].to_vec();
            self.pending_line.drain(..=index);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.handle_line(&String::from_utf8_lossy(&line), &mut events);
        }

        events
    }

    /// Flushes any remaining buffered state at end-of-stream.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if !self.pending_line.is_empty() {
            let line = std::mem::take(&mut self.pending_line);
            self.handle_line(&String::from_utf8_lossy(&line), &mut events);
        }
        self.flush_event(&mut events);
        events
    }

    fn handle_line(&mut self, line: &str, events: &mut Vec<SseEvent>) {
        if line.is_empty() {
            self.flush_event(events);
            return;
        }

        if let Some(value) = line.strip_prefix("event:") {
            self.event_name = Some(value.trim().to_string());
            return;
        }

        if let Some(value) = line.strip_prefix("data:") {
            self.data_lines.push(value.trim_start().to_string());
        }
    }

    fn flush_event(&mut self, events: &mut Vec<SseEvent>) {
        if self.data_lines.is_empty() && self.event_name.is_none() {
            return;
        }

        events.push(SseEvent {
            event: self.event_name.take(),
            data: self.data_lines.join("\n"),
        });
        self.data_lines.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_sse_frames_across_multiple_chunks() {
        let mut decoder = SseEventDecoder::default();
        let frames = decoder.push(b"data: hello\n\ndata: wor");
        assert_eq!(
            frames,
            vec![SseEvent {
                event: None,
                data: "hello".to_string(),
            }]
        );

        let frames = decoder.push(b"ld\n\ndata: [DONE]\n\n");
        assert_eq!(
            frames,
            vec![
                SseEvent {
                    event: None,
                    data: "world".to_string(),
                },
                SseEvent {
                    event: None,
                    data: "[DONE]".to_string(),
                },
            ]
        );
    }

    #[test]
    fn joins_multiple_data_lines_with_newlines() {
        let mut decoder = SseEventDecoder::default();
        let frames = decoder.push(b"event: message\ndata: one\ndata: two\n\n");

        assert_eq!(
            frames,
            vec![SseEvent {
                event: Some("message".to_string()),
                data: "one\ntwo".to_string(),
            }]
        );
    }

    #[test]
    fn finish_flushes_last_event_without_trailing_blank_line() {
        let mut decoder = SseEventDecoder::default();
        assert!(decoder.push(b"data: partial").is_empty());

        assert_eq!(
            decoder.finish(),
            vec![SseEvent {
                event: None,
                data: "partial".to_string(),
            }]
        );
    }
}
