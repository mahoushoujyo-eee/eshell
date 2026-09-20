// Error boundary for external plugin runtime code (controllers, panels).
//
// A render error in one external plugin is contained at that plugin's
// boundary: the boundary renders a small placeholder instead of the plugin's
// subtree, logs once, and never crashes the workbench. The core terminal and
// the builtin panels are unaffected — they never render through this boundary.
//
// `render` selects the fallback node (a panel placeholder box, or null for
// controller hosts, which render nothing on success anyway).
import { Component } from "react";

export default class PluginRuntimeErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.warn(
      `[plugin-runtime] ${this.props.label || "plugin"} render failed`,
      error,
      info?.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return this.props.render === undefined ? null : this.props.render;
    }
    return this.props.children ?? null;
  }
}
