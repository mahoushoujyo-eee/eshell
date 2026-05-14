## ADDED Requirements

### Requirement: SSH profiles support explicit authentication modes
The system SHALL allow each SSH profile to use either password authentication or private-key authentication.

#### Scenario: Create password-auth profile
- **WHEN** a user creates an SSH profile with authentication type `password`
- **THEN** the system SHALL require host, port, username, and password-compatible credential input
- **AND** the saved profile SHALL remain usable by the existing password login flow

#### Scenario: Create private-key-auth profile
- **WHEN** a user creates an SSH profile with authentication type `privateKey`
- **THEN** the system SHALL require host, port, username, and private key path
- **AND** the saved profile SHALL include the authentication type and private key path

#### Scenario: Load legacy password profile
- **WHEN** the system loads an existing SSH profile that does not contain an authentication type
- **THEN** the system SHALL treat the profile as password authentication
- **AND** the profile SHALL remain editable and connectable without manual migration

### Requirement: Private key authentication supports optional passphrases
The system SHALL support private key files that are unencrypted or encrypted with a passphrase.

#### Scenario: Connect with unencrypted private key
- **WHEN** a profile uses private-key authentication with a readable unencrypted private key path
- **THEN** the backend SHALL authenticate the SSH session using the configured username and key path

#### Scenario: Connect with encrypted private key
- **WHEN** a profile uses private-key authentication with a readable encrypted private key path and a passphrase
- **THEN** the backend SHALL authenticate the SSH session using the configured username, key path, and passphrase

#### Scenario: Missing key passphrase
- **WHEN** a profile uses an encrypted private key and no passphrase is available
- **THEN** the backend SHALL fail authentication with an actionable error that indicates the key passphrase is required or invalid

### Requirement: SSH profile form exposes key-auth fields
The system SHALL let users configure key-based authentication from the SSH profile modal.

#### Scenario: Switch to private key mode
- **WHEN** a user selects private-key authentication in the SSH profile form
- **THEN** the form SHALL show private key path and optional passphrase inputs
- **AND** the form SHALL keep shared fields such as name, host, port, username, and description available

#### Scenario: Switch to password mode
- **WHEN** a user selects password authentication in the SSH profile form
- **THEN** the form SHALL show the password input
- **AND** the form SHALL not require a private key path

#### Scenario: Localized credential labels
- **WHEN** the SSH profile modal renders credential fields
- **THEN** all user-facing labels and validation copy SHALL be available through the shared `src/lib/i18n.js` translator for `en-US` and `zh-CN`

### Requirement: Backend validation rejects incomplete key-auth profiles
The system SHALL validate SSH profile credential fields before saving and before attempting connection.

#### Scenario: Save key-auth profile without key path
- **WHEN** a user saves a private-key SSH profile without a private key path
- **THEN** the backend SHALL reject the save with a validation error

#### Scenario: Connect with missing key file
- **WHEN** a user connects with a private-key SSH profile whose private key path does not exist or cannot be read
- **THEN** the backend SHALL fail before or during authentication with an actionable error that identifies the key path problem

#### Scenario: Invalid authentication type
- **WHEN** the backend receives an SSH profile with an unknown authentication type
- **THEN** the backend SHALL reject it with a validation error instead of attempting a connection

### Requirement: SSH connection behavior remains shared across terminal and SFTP workflows
The system SHALL use the selected SSH authentication mode consistently for all operations that establish SSH connections.

#### Scenario: Open terminal with key-auth profile
- **WHEN** a user opens a terminal session with a private-key SSH profile
- **THEN** the terminal connection SHALL authenticate with the configured key credentials

#### Scenario: Use SFTP with key-auth profile
- **WHEN** a user uses SFTP operations from a session based on a private-key SSH profile
- **THEN** backend SFTP connections SHALL authenticate with the same key credentials

#### Scenario: Use status and script features with key-auth profile
- **WHEN** a user runs status monitoring or script execution for a session based on a private-key SSH profile
- **THEN** backend SSH connections SHALL authenticate with the same key credentials

### Requirement: SSH host fingerprints are verified before user authentication
The system SHALL verify the SSH server host key fingerprint after handshake and before sending password or private-key authentication credentials.

#### Scenario: First connection to unknown host
- **WHEN** a user connects to a host and port with no saved trusted host fingerprint
- **THEN** the system SHALL present the server host key type and fingerprint for user confirmation
- **AND** the system SHALL NOT send password or private-key authentication credentials until the user accepts the fingerprint

#### Scenario: User trusts unknown host fingerprint
- **WHEN** a user accepts the fingerprint for an unknown host and port
- **THEN** the system SHALL save the trusted fingerprint locally
- **AND** the system SHALL continue the SSH connection using the selected user authentication mode

#### Scenario: User rejects unknown host fingerprint
- **WHEN** a user rejects the fingerprint for an unknown host and port
- **THEN** the system SHALL abort the SSH connection
- **AND** the system SHALL NOT save the fingerprint
- **AND** the system SHALL NOT send password or private-key authentication credentials

### Requirement: Changed SSH host fingerprints are blocked
The system SHALL detect when a known host presents a different host key fingerprint than the locally trusted fingerprint.

#### Scenario: Known host fingerprint matches
- **WHEN** a user connects to a host and port whose presented fingerprint matches the locally trusted fingerprint
- **THEN** the system SHALL continue the SSH connection without prompting for host trust

#### Scenario: Known host fingerprint changed
- **WHEN** a user connects to a host and port whose presented fingerprint differs from the locally trusted fingerprint
- **THEN** the system SHALL block the connection before user authentication
- **AND** the system SHALL show both the trusted fingerprint and the presented fingerprint with a high-risk warning

#### Scenario: User replaces changed host fingerprint
- **WHEN** a user explicitly confirms that a changed host fingerprint should replace the stored fingerprint
- **THEN** the system SHALL update the local trusted fingerprint record
- **AND** the system SHALL allow a new connection attempt to continue with the selected user authentication mode

### Requirement: Host fingerprint trust is shared across profiles
The system SHALL store trusted host fingerprints as local host-and-port trust records rather than duplicating trust on each SSH profile.

#### Scenario: Second profile for trusted host
- **WHEN** a user connects with a different SSH profile targeting a host and port that already has a matching trusted fingerprint
- **THEN** the system SHALL reuse the existing trust record
- **AND** the system SHALL NOT ask the user to trust the same matching fingerprint again

#### Scenario: Delete SSH profile
- **WHEN** a user deletes one SSH profile for a trusted host and port
- **THEN** the system SHALL NOT delete the host fingerprint trust record if other profiles or future connections may use that host and port

#### Scenario: Localized host trust prompts
- **WHEN** the system presents host fingerprint confirmation or mismatch warnings
- **THEN** all user-facing labels and warning copy SHALL be available through the shared `src/lib/i18n.js` translator for `en-US` and `zh-CN`
