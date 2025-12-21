function Topbar({ connections }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        <div>
          <p className="brand-title">E-Shell Studio</p>
          <p className="brand-subtitle">Multi-node terminal + observability console</p>
        </div>
      </div>
      <div className="topbar-tabs">
        {connections.map((item) => (
          <button key={item.name} className="tab-pill" type="button">
            <span className={`status-dot ${item.status}`} />
            {item.name}
          </button>
        ))}
        <button className="tab-pill ghost" type="button">
          + New Session
        </button>
      </div>
      <div className="topbar-actions">
        <button className="action-btn" type="button">
          Connect
        </button>
        <button className="action-btn secondary" type="button">
          Quick Search
        </button>
        <button className="icon-btn" type="button" aria-label="Settings">
          Settings
        </button>
      </div>
    </header>
  );
}

export default Topbar;
