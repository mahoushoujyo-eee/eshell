//! Scripts domain tests: CRUD on saved script definitions.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::config::Storage;
use crate::domain::scripts::model::ScriptInput;

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock drift")
        .as_nanos();
    std::env::temp_dir().join(format!("eshell-{name}-{stamp}"))
}


#[test]
fn script_crud_works() {
    let storage = Storage::new(temp_dir("script")).expect("create storage");
    let created = storage
        .upsert_script(ScriptInput {
            id: None,
            name: "health".to_string(),
            path: Some("/opt/health.sh".to_string()),
            command: None,
            description: Some("health check".to_string()),
            parameters: Vec::new(),
        })
        .expect("create script");

    assert_eq!(storage.list_scripts().len(), 1);
    assert_eq!(created.path, "/opt/health.sh");

    let updated = storage
        .upsert_script(ScriptInput {
            id: Some(created.id.clone()),
            name: "health-v2".to_string(),
            path: Some(String::new()),
            command: Some("uptime".to_string()),
            description: Some("custom command".to_string()),
            parameters: Vec::new(),
        })
        .expect("update script");
    assert_eq!(updated.command, "uptime");

    storage.delete_script(&created.id).expect("delete");
    assert!(storage.list_scripts().is_empty());
}
