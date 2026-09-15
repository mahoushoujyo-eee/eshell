//! Channel ownership independent of the shared SSH connection.

use std::sync::Arc;
use std::time::Duration;

use russh::{client, Channel, ChannelReadHalf, ChannelWriteHalf};

/// Closing a request or cancelling its future must close only that channel,
/// even when the caller never reaches its normal async cleanup path.
pub(super) struct OwnedChannel {
    pub read: ChannelReadHalf,
    pub write: Arc<ChannelWriteHalf<client::Msg>>,
}

impl OwnedChannel {
    pub fn new(channel: Channel<client::Msg>) -> Self {
        let (read, write) = channel.split();
        Self {
            read,
            write: Arc::new(write),
        }
    }
}

impl Drop for OwnedChannel {
    fn drop(&mut self) {
        let write = Arc::clone(&self.write);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(2), write.close()).await;
            });
        }
    }
}
