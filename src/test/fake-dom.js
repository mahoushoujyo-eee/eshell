/**
 * A minimal fake DOM for component tests.
 *
 * Scope: this exists only so tests can mount real React 19 client roots and
 * assert on STRUCTURE and LIFECYCLE — node tree shape, class/style values,
 * host-node identity across KeepAlive moves, which subtree is attached
 * where, and click handlers firing through React's delegated events. It is
 * NOT a browser: layout (getBoundingClientRect, ResizeObserver) returns inert
 * defaults, events bubble but have no default actions, and only the surface
 * React's client renderer touches is implemented. Anything richer is out of
 * scope; visual layout and real-browser event behavior are verified
 * elsewhere.
 *
 * The project's Vitest config runs in the `node` environment with no jsdom
 * or happy-dom dependency, so tests install this via installFakeDom().
 */

export class FakeStyle {
  constructor() {
    this.__props = {};
    return new Proxy(this, {
      get(target, prop) {
        if (typeof prop === "string") {
          if (prop in target) return Reflect.get(target, prop, target);
          return target.__props[prop] ?? "";
        }
        return Reflect.get(target, prop, target);
      },
      set(target, prop, value) {
        if (typeof prop === "string" && prop in target) {
          return Reflect.set(target, prop, value, target);
        }
        // style.display = "none" and friends land in __props so
        // getPropertyValue("display") reads the same value back.
        target.__props[prop] = value == null ? "" : String(value);
        return true;
      },
    });
  }
  setProperty(name, value) {
    this.__props[name] = String(value);
  }
  removeProperty(name) {
    delete this.__props[name];
  }
  getPropertyValue(name) {
    return this.__props[name] ?? "";
  }
  get cssText() {
    return Object.entries(this.__props)
      .map(([name, value]) => `${name}: ${value};`)
      .join(" ");
  }
}

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.cancelable = init.cancelable ?? true;
    const { target, currentTarget, bubbles, cancelable, composed, ...rest } = init;
    Object.assign(this, rest);
    if (target) this.target = target;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  stopImmediatePropagation() {
    this.propagationStopped = true;
  }
  persist() {}
}

export class FakeNode {
  constructor(nodeType, nodeName, ownerDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.childNodes = [];
    this.parentNode = null;
    this._ownerDocument = ownerDocument ?? null;
    this.style = new FakeStyle();
    this.attributes = {};
    this._className = "";
    this.listeners = {};
    this.data = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.defaultSelected = false;
    this.multiple = false;
    this.type = "";
    this.required = false;
    this.readOnly = false;
    this.indeterminate = false;
  }

  get ownerDocument() {
    return this._ownerDocument ?? globalThis.document;
  }
  get tagName() {
    return this.nodeType === 1 ? this.nodeName : undefined;
  }
  get namespaceURI() {
    return this.nodeType === 1 ? "http://www.w3.org/1999/xhtml" : null;
  }
  // React writes class through setAttribute("class"); hand-written production
  // code (KeepAlive, AppMainWorkspace slot nodes) assigns `.className`. Both
  // paths read back the same value.
  get className() {
    return this.attributes.class ?? this._className;
  }
  set className(value) {
    this._className = String(value);
    this.attributes.class = String(value);
  }
  get classList() {
    const self = this;
    const read = () => new Set(self.className.split(/\s+/).filter(Boolean));
    const write = (tokens) => {
      self.className = [...tokens].join(" ");
    };
    return {
      add(...tokens) {
        const set = read();
        tokens.forEach((t) => set.add(t));
        write(set);
      },
      remove(...tokens) {
        const set = read();
        tokens.forEach((t) => set.delete(t));
        write(set);
      },
      contains(token) {
        return read().has(token);
      },
    };
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const index = parent.childNodes.indexOf(this);
    return parent.childNodes[index + 1] ?? null;
  }
  get previousSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    const index = parent.childNodes.indexOf(this);
    return index > 0 ? parent.childNodes[index - 1] ?? null : null;
  }
  get textContent() {
    if (this.nodeType === 3 || this.nodeType === 8) return this.data;
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.childNodes = [];
    if (value !== "" && value != null) {
      this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
  }
  get innerText() {
    return this.textContent;
  }
  get nodeValue() {
    return this.nodeType === 3 || this.nodeType === 8 ? this.data : null;
  }
  set nodeValue(value) {
    if (this.nodeType === 3 || this.nodeType === 8) this.data = String(value);
  }
  // React's <select> helpers iterate .options.
  get options() {
    return this.childNodes.filter((child) => child.nodeName === "OPTION");
  }

  appendChild(child) {
    if (child.nodeType === 11) {
      [...child.childNodes].forEach((grandchild) => this.appendChild(grandchild));
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore(child, reference) {
    if (child.nodeType === 11) {
      [...child.childNodes].forEach((grandchild) => this.insertBefore(grandchild, reference));
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0) {
      this.appendChild(child);
      return child;
    }
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "value") this.value = String(value);
    if (name === "checked") this.checked = value !== "false";
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || []).filter((existing) => existing !== listener);
  }

  /**
   * Bubbling dispatch: React attaches delegated listeners on the root
   // container, so events dispatched on a child must walk up. stopPropagation
   * is honored; default actions do not exist.
   */
  dispatchEvent(rawEvent) {
    const event =
      rawEvent instanceof FakeEvent
        ? rawEvent
        : new FakeEvent(rawEvent?.type ?? "unknown", rawEvent ?? {});
    if (!event.target) event.target = this;
    if (typeof event.timeStamp !== "number") event.timeStamp = Date.now();
    let node = this;
    while (node) {
      (node.listeners[event.type] || []).slice().forEach((listener) => {
        if (event.propagationStopped) return;
        event.currentTarget = node;
        listener(event);
      });
      if (event.propagationStopped) break;
      node = node.parentNode;
    }
    if (event.type === "focus") this.ownerDocument.activeElement = this;
    return !event.defaultPrevented;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
  }
  click() {
    this.dispatchEvent(new FakeEvent("click", { target: this }));
  }
  select() {}
  setSelectionRange() {}
  get selectionStart() {
    return 0;
  }
  get selectionEnd() {
    return 0;
  }
  // Layout is out of scope: inert defaults.
  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  }
  scrollIntoView() {}
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(9, "#document", null);
    this.documentElement = this.createElement("html");
    this.body = this.createElement("body");
    this.head = this.createElement("head");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = null;
    this.title = "";
    this.readyState = "complete";
    this.visibilityState = "visible";
    // Constructor identity checks React's client renderer performs.
    this.HTMLIFrameElement = class HTMLIFrameElement {};
    this.HTMLInputElement = class HTMLInputElement {};
    this.HTMLTextAreaElement = class HTMLTextAreaElement {};
    this.HTMLSelectElement = class HTMLSelectElement {};
    this.defaultView = null;
  }

  createElement(tag) {
    return new FakeNode(1, String(tag).toUpperCase(), this);
  }
  createElementNS(_namespace, tag) {
    return new FakeNode(1, String(tag).toUpperCase(), this);
  }
  createTextNode(text) {
    const node = new FakeNode(3, "#text", this);
    node.data = String(text);
    return node;
  }
  createComment(text) {
    const node = new FakeNode(8, "#comment", this);
    node.data = String(text);
    return node;
  }
  createDocumentFragment() {
    return new FakeNode(11, "#document-fragment", this);
  }
  getElementById(id) {
    let found = null;
    const walk = (node) => {
      if (found) return;
      if (node.nodeType === 1 && node.getAttribute("id") === id) {
        found = node;
        return;
      }
      node.childNodes.forEach(walk);
    };
    walk(this);
    return found;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }
}

export class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

export function createFakeDocument() {
  return new FakeDocument();
}

export function createFakeWindow(document, overrides = {}) {
  const listeners = {};
  const timeouts = new Set();
  const window = {
    localStorage: {
      store: {},
      getItem(key) {
        return this.store[key] ?? null;
      },
      setItem(key, value) {
        this.store[key] = String(value);
      },
      removeItem(key) {
        delete this.store[key];
      },
    },
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    removeEventListener(type, listener) {
      listeners[type] = (listeners[type] || []).filter((existing) => existing !== listener);
    },
    /**
     * Dispatches to the listeners registered above. Without this, a component
     * that binds a `window` keydown handler (every Escape-to-close dialog)
     * could not be exercised at all.
     */
    dispatchEvent(event) {
      const type = event?.type ?? "unknown";
      for (const listener of [...(listeners[type] || [])]) {
        listener(event);
      }
      return true;
    },
    setTimeout(fn, delay, ...args) {
      const handle = setTimeout(() => {
        timeouts.delete(handle);
        fn(...args);
      }, delay);
      timeouts.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle);
      timeouts.delete(handle);
    },
    queueMicrotask: globalThis.queueMicrotask?.bind(globalThis),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    getComputedStyle: () => new FakeStyle(),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1600,
    innerHeight: 900,
    navigator: { language: "en-US", languages: ["en-US", "en"], userAgent: "vitest-fake-window" },
    location: { href: "http://localhost/" },
    ResizeObserver: FakeResizeObserver,
    MessageChannel,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    Event: FakeEvent,
    CustomEvent: FakeEvent,
    HTMLIFrameElement: document.HTMLIFrameElement,
    ...overrides,
  };
  window.document = document;
  window.self = window;
  window.top = window;
  window.parent = window;
  window.window = window;
  document.defaultView = window;
  return window;
}

function defineGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && descriptor.configurable === false && descriptor.get && !descriptor.set) {
    // Node >= 21 exposes readonly getters for some globals (navigator): those
    // keep their real value; the fake window wraps its own.
    return false;
  }
  try {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
    });
    return true;
  } catch {
    return false;
  }
}

const uninstallers = [];

/**
 * Installs a fresh fake `document`/`window` on the global scope. Returns the
 * pair; call uninstallFakeDom() in a finally block.
 */
export function installFakeDom(overrides = {}) {
  const document = createFakeDocument();
  const window = createFakeWindow(document, overrides);
  const installed = [];
  for (const [name, value] of [
    ["document", document],
    ["window", window],
    ["navigator", window.navigator],
    ["localStorage", window.localStorage],
    ["getComputedStyle", window.getComputedStyle],
    ["matchMedia", window.matchMedia],
    ["ResizeObserver", FakeResizeObserver],
  ]) {
    if (defineGlobal(name, value)) installed.push(name);
  }
  uninstallers.push(installed);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { document, window };
}

export function uninstallFakeDom() {
  const installed = uninstallers.pop();
  if (!installed) return;
  for (const name of installed) {
    try {
      delete globalThis[name];
    } catch {
      /* ignore */
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
}

/** Depth-first search for the first element satisfying `predicate`. */
export function findElement(root, predicate) {
  if (root.nodeType === 1 && predicate(root)) return root;
  for (const child of root.childNodes || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

export function findElements(root, predicate, out = []) {
  if (root.nodeType === 1 && predicate(root)) out.push(root);
  for (const child of root.childNodes || []) {
    findElements(child, predicate, out);
  }
  return out;
}

/**
 * Compact structural outline for layout snapshots: tag, class, and the
 * layout-relevant inline style keys (display / flex-basis / sizing), with
 * icon SVG internals collapsed. Stable across text and icon tweaks; loud
 * when panel nesting, split structure, or class names change.
 */
export function serializeOutline(node, depth = 0) {
  if (!node) return "";
  if (node.nodeType === 3) return "";
  if (node.nodeType !== 1) return "";
  const tag = node.nodeName.toLowerCase();
  if (tag === "svg") {
    return "  ".repeat(depth) + "svg(...icons collapsed)";
  }
  const pad = "  ".repeat(depth);
  const styleKeys = ["display", "flexBasis", "flexGrow", "flexShrink", "width", "height", "position", "visibility", "zIndex"];
  const styleEntries = Object.entries(node.style.__props || {})
    .filter(([name, value]) => value !== "" && value != null)
    .filter(([name]) => styleKeys.includes(name))
    .map(([name, value]) => `${name}:${value}`);
  const attrStyle = (node.getAttribute("style") || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => /^(display|flex-basis|flex-grow|flex-shrink|width|height|position|visibility|z-index):/i.test(part));
  const parts = [tag];
  if (node.className) parts.push(`.${node.className.replace(/\s+/g, ".")}`);
  if (styleEntries.length || attrStyle.length) parts.push(`{${[...styleEntries, ...attrStyle].join(",")}}`);
  const children = node.childNodes.map((child) => serializeOutline(child, depth + 1)).filter(Boolean);
  if (children.length === 0) {
    return `${pad}${parts.join(" ")}`;
  }
  return `${pad}${parts.join(" ")}\n${children.join("\n")}`;
}
