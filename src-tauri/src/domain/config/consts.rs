//! Constants for the config domain: persisted file names and the agent
//! context directory layout under the storage root.

/// Persistent SSH connection profiles.
pub(crate) const SSH_CONFIGS_FILE: &str = "ssh_configs.json";

/// Trust-on-first-use host key store, written by the host-key prompt.
pub(crate) const KNOWN_HOSTS_FILE: &str = "known_hosts.json";

/// Saved script definitions.
pub(crate) const SCRIPTS_FILE: &str = "scripts.json";

/// Root of the agent context file mapping under `.eshell-data/`.
pub(crate) const AGENT_CONTEXT_DIR: &str = "agent";

/// Global agent context file, stored at `agent/AGENTS.md`.
pub(crate) const GLOBAL_AGENTS_FILE: &str = "AGENTS.md";
