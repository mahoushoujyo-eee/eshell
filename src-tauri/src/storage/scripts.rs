use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::{now_rfc3339, ScriptDefinition, ScriptInput};

use super::io::write_json_pretty;
use super::Storage;

impl Storage {
    /// Returns script definitions in persistent order.
    pub fn list_scripts(&self) -> Vec<ScriptDefinition> {
        self.scripts.read().expect("script lock poisoned").clone()
    }

    /// Creates or updates a script definition and persists the collection.
    pub fn upsert_script(&self, input: ScriptInput) -> AppResult<ScriptDefinition> {
        if input.name.trim().is_empty() {
            return Err(AppError::Validation(
                "script name cannot be empty".to_string(),
            ));
        }

        let path = input.path.unwrap_or_default().trim().to_string();
        let command = input.command.unwrap_or_default().trim().to_string();
        if path.is_empty() && command.is_empty() {
            return Err(AppError::Validation(
                "script path and command cannot both be empty".to_string(),
            ));
        }

        let mut guard = self.scripts.write().expect("script lock poisoned");
        let now = now_rfc3339();

        let script = match input.id.as_deref() {
            Some(id) => {
                let index = guard
                    .iter()
                    .position(|item| item.id == id)
                    .ok_or_else(|| AppError::NotFound(format!("script {id}")))?;
                let existing = &guard[index];
                let updated = ScriptDefinition {
                    id: existing.id.clone(),
                    name: input.name.trim().to_string(),
                    path,
                    command,
                    description: input.description.unwrap_or_default().trim().to_string(),
                    created_at: existing.created_at.clone(),
                    updated_at: now,
                };
                guard[index] = updated.clone();
                updated
            }
            None => {
                let created = ScriptDefinition {
                    id: Uuid::new_v4().to_string(),
                    name: input.name.trim().to_string(),
                    path,
                    command,
                    description: input.description.unwrap_or_default().trim().to_string(),
                    created_at: now.clone(),
                    updated_at: now,
                };
                guard.push(created.clone());
                created
            }
        };

        write_json_pretty(&self.scripts_path, &*guard)?;
        Ok(script)
    }

    /// Deletes a script definition by id and persists changes.
    pub fn delete_script(&self, id: &str) -> AppResult<()> {
        let mut guard = self.scripts.write().expect("script lock poisoned");
        let before = guard.len();
        guard.retain(|script| script.id != id);
        if guard.len() == before {
            return Err(AppError::NotFound(format!("script {id}")));
        }
        write_json_pretty(&self.scripts_path, &*guard)?;
        Ok(())
    }

    /// Returns a script by id.
    pub fn find_script(&self, id: &str) -> AppResult<ScriptDefinition> {
        self.scripts
            .read()
            .expect("script lock poisoned")
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("script {id}")))
    }
}
