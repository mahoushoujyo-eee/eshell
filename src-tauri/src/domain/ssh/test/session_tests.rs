//! Unit tests for `ssh/service/session.rs`: shell output parsing and the
//! `cd`/`pwd` helpers the session commands rely on.

use russh::ChannelMsg;

use crate::domain::ssh::consts::*;
use crate::domain::ssh::service::session::*;

#[test]
fn unknown_or_home_cwd_does_not_add_a_quoted_tilde() {
    assert_eq!(command_in_directory("", "ls"), "ls");
    assert_eq!(command_in_directory("~", "ls"), "ls");
    assert_eq!(
        command_in_directory("/srv/my app", "ls"),
        "cd '/srv/my app' && ls"
    );
    assert_eq!(command_in_directory("", "cd ~ && pwd"), "cd ~ && pwd");
}

#[test]
fn exec_drains_both_streams_and_waits_for_status_after_eof() {
    let mut output = CommandOutput::default();
    output
        .apply(ChannelMsg::Data {
            data: b"out".to_vec().into(),
        })
        .unwrap();
    output
        .apply(ChannelMsg::ExtendedData {
            data: b"err".to_vec().into(),
            ext: 1,
        })
        .unwrap();
    assert!(!output.apply(ChannelMsg::Eof).unwrap());
    output
        .apply(ChannelMsg::ExitStatus { exit_status: 17 })
        .unwrap();
    assert!(output.apply(ChannelMsg::Close).unwrap());
    assert_eq!(output.finish().unwrap(), ("out".into(), "err".into(), 17));
}

#[test]
fn exec_disconnect_without_status_is_not_success() {
    assert!(CommandOutput::default().finish().is_err());
    assert!(CommandOutput::default().apply(ChannelMsg::Failure).is_err());
}

#[test]
fn exec_output_limit_is_reported_not_silently_truncated() {
    let output = CommandOutput::default();
    assert!(output.check_size(MAX_COMMAND_OUTPUT_BYTES).is_ok());
    assert!(output.check_size(MAX_COMMAND_OUTPUT_BYTES + 1).is_err());
}

#[test]
fn parse_cd_target_rejects_a_cd_that_chains_another_command() {
    assert_eq!(
        parse_cd_target("cd /opt/spring-blog && echo hi > compose.yml && sed -i s/a/b/ x"),
        None
    );
    assert_eq!(parse_cd_target("cd /srv && docker compose down"), None);
    assert_eq!(parse_cd_target("cd /tmp; ls -la"), None);
    assert_eq!(parse_cd_target("cd /tmp || true"), None);
    assert_eq!(parse_cd_target("cd /tmp | tee out"), None);
    assert_eq!(parse_cd_target("cd /tmp &"), None);
    assert_eq!(parse_cd_target("cd /tmp > out"), None);
    assert_eq!(parse_cd_target("cd /tmp < in"), None);
    assert_eq!(parse_cd_target("cd /tmp\nrm -rf /"), None);
}

#[test]
fn parse_cd_target_accepts_a_directory_change_on_its_own() {
    assert_eq!(parse_cd_target("cd"), Some(None));
    assert_eq!(parse_cd_target("  cd  "), Some(None));
    assert_eq!(parse_cd_target("cd "), Some(None));
    assert_eq!(
        parse_cd_target("cd /opt/spring-blog"),
        Some(Some("/opt/spring-blog".to_string()))
    );
    assert_eq!(parse_cd_target("cd .."), Some(Some("..".to_string())));
    assert_eq!(parse_cd_target("cd -"), Some(Some("-".to_string())));
    assert_eq!(parse_cd_target("cd ~"), Some(Some("~".to_string())));
    assert_eq!(
        parse_cd_target("cd ~/work"),
        Some(Some("~/work".to_string()))
    );
    assert_eq!(
        parse_cd_target("cd $HOME/logs"),
        Some(Some("$HOME/logs".to_string()))
    );
}

#[test]
fn parse_cd_target_ignores_commands_that_merely_start_with_cd() {
    assert_eq!(parse_cd_target("cdk deploy"), None);
    assert_eq!(parse_cd_target("cd/tmp"), None);
    assert_eq!(parse_cd_target("echo cd /tmp"), None);
    assert_eq!(parse_cd_target("ls"), None);
    assert_eq!(parse_cd_target(""), None);
}

#[test]
fn parse_pwd_output_accepts_only_one_absolute_path() {
    assert_eq!(
        parse_pwd_output("/opt/spring-blog\n"),
        Some("/opt/spring-blog".to_string())
    );
    assert_eq!(
        parse_pwd_output("  /srv/app  "),
        Some("/srv/app".to_string())
    );
    assert_eq!(parse_pwd_output("/"), Some("/".to_string()));
    assert_eq!(parse_pwd_output(""), None);
    assert_eq!(parse_pwd_output("   "), None);
    assert_eq!(parse_pwd_output("relative/path"), None);
    assert_eq!(
        parse_pwd_output("services:\n  web:\n    image: nginx\n/opt/spring-blog"),
        None
    );
    assert_eq!(
        parse_pwd_output(&format!("/{}", "a".repeat(MAX_REMOTE_CWD_LEN))),
        None
    );
}

#[test]
fn parse_pwd_output_rejects_what_sanitize_cwd_would_have_reshaped() {
    let compose_dump = "services:\n  web:\n    image: nginx:alpine\n";
    assert_eq!(
        sanitize_cwd(compose_dump),
        "/services:\n  web:\n    image: nginx:alpine"
    );
    assert_eq!(parse_pwd_output(compose_dump), None);
}
