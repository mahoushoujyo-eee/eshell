pub(crate) mod channel;
pub mod commands;
pub(crate) mod pty;
pub(crate) mod service;
pub(crate) mod transport;

#[cfg(test)]
mod integration_tests;

pub use service::{
    append_server_ops_debug_log, close_shell_session, execute_command, open_shell_session,
    pty_resize, pty_write_input, reopen_shell_pty, run_session_command_for_probe, ssh_ki_respond,
};

/// Re-exports so the pre-migration call surface keeps compiling.
///
/// The implementations live in `plugins::sftp::ops` and `plugins::status`;
/// these are the thin compatibility re-exports the task allows ("可保留内部
/// 薄兼容reexports，但实现必须归插件").
pub use crate::plugins::sftp::ops::{
    default_download_dir, sftp_create_directory, sftp_create_file, sftp_delete_entry,
    sftp_download_file, sftp_download_file_to_local, sftp_list_dir, sftp_read_file,
    sftp_rename_entry, sftp_upload_file, sftp_upload_file_with_progress,
    sftp_upload_local_file_with_progress, sftp_write_file,
};
pub use crate::plugins::status::fetch_server_status;
