const { Plugin } = require("obsidian");
const { remote } = require("electron");
const { randomUUID } = require("crypto");

// Runs inside the player's frame. No Electron or vault API is exposed here.
function connectPlayer(key, signal) {
  if (window[key]) return;
  const original = Element.prototype.requestFullscreen;
  const originalExit = document.exitFullscreen;
  const exitDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "exitFullscreen",
  );
  const log = console.info.bind(console);
  let target, style, savedGetter;
  let frameStyle, expandedFrame;
  const parentSignal = (state) => {
    if (parent !== window) parent.postMessage({ channel: key, state }, "*");
  };
  const notify = (state) => {
    log(signal + ":" + state);
    parentSignal(state);
  };
  // Keep the player and its ancestor chain. Hide sibling branches at every
  // level, including content YouTube adds while playback is fullscreen.
  function isolate(selector) {
    return `
      :has(${selector}) > :not(${selector}):not(:has(${selector})) {
        display: none !important;
      }
      html:has(${selector}), body:has(${selector}) {
        overflow: hidden !important;
        scrollbar-width: none !important;
      }
    `;
  }
  function clearFrame() {
    expandedFrame?.removeAttribute("data-vfh-frame");
    frameStyle?.remove();
    expandedFrame = frameStyle = undefined;
  }
  function handleChild(e) {
    if (e.data?.channel !== key) return;
    const frame = [...document.querySelectorAll("iframe")].find(
      (el) => el.contentWindow === e.source,
    );
    if (!frame) return;
    if (e.data.state === "leave" && expandedFrame === frame) {
      clearFrame();
      parentSignal("leave");
      return;
    }
    if (e.data.state !== "enter") return;
    clearFrame();
    expandedFrame = frame;
    frame.setAttribute("data-vfh-frame", "");
    frameStyle = document.createElement("style");
    frameStyle.textContent =
      "[data-vfh-frame]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;border:0!important;margin:0!important;z-index:2147483647!important} :has([data-vfh-frame]){transform:none!important;contain:none!important;overflow:visible!important;clip-path:none!important}";
    frameStyle.textContent += isolate("[data-vfh-frame]");
    document.documentElement.append(frameStyle);
    parentSignal("enter");
  }
  window.addEventListener("message", handleChild);
  function change() {
    document.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
  }
  function leave() {
    if (!target) return;
    const el = target;
    target = null;

    el.removeAttribute("data-vfh-player");

    style.remove();
    if (savedGetter)
      Object.defineProperty(document, "fullscreenElement", savedGetter);
    else delete document.fullscreenElement;
    notify("leave");
    change();
  }
  function enter(el) {
    if (target || !navigator.userActivation.isActive) return false;
    if (!el.matches("video") && !el.querySelector("video")) return false;
    target = el;

    savedGetter = Object.getOwnPropertyDescriptor(
      document,
      "fullscreenElement",
    );
    style = document.createElement("style");
    style.textContent =
      "[data-vfh-player]{position:fixed!important;z-index:2147483647!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:black!important;overflow:hidden!important;color:white}:has([data-vfh-player]){transform:none!important;contain:none!important;clip-path:none!important;overflow:visible!important} :has(>[data-vfh-player]),body:has([data-vfh-player]){isolation:auto!important} [data-vfh-player] video{position:absolute!important;inset:0!important;width:100vw!important;height:100vh!important;object-fit:contain!important}";
    style.textContent += isolate("[data-vfh-player]");
    document.documentElement.append(style);
    try {
      el.setAttribute("data-vfh-player", "");

      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => target,
      });
    } catch {
      leave();
      return false;
    }
    notify("enter");
    change();
    return true;
  }
  function request(...args) {
    if (args.length === 0 || args[0]?.screen == null) {
      if (enter(this)) return Promise.resolve();
    }
    return original.apply(this, args);
  }
  function exit(...args) {
    if (!target) return originalExit.apply(this, args);
    leave();
    return Promise.resolve();
  }
  function click(e) {
    const button = e.target.closest?.(
      ".ytp-fullscreen-button,button.fullscreen-icon",
    );
    if (!button || !navigator.userActivation.isActive) return;
    const player =
      button.closest(".html5-video-player") ||
      (button.matches(".fullscreen-icon") &&
      /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)
        ? document.body
        : null);
    if (!player) return;
    if (target) leave();
    else if (!enter(player)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function keydown(e) {
    if (target && e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      leave();
    }
  }
  Element.prototype.requestFullscreen = request;
  document.exitFullscreen = exit;
  window.addEventListener("click", click, true);
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("pagehide", leave);
  window[key] = {
    leave,
    dispose() {
      leave();
      if (Element.prototype.requestFullscreen === request)
        Element.prototype.requestFullscreen = original;
      if (document.exitFullscreen === exit) {
        if (exitDescriptor)
          Object.defineProperty(document, "exitFullscreen", exitDescriptor);
        else delete document.exitFullscreen;
      }
      clearFrame();
      window.removeEventListener("message", handleChild);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("pagehide", leave);
      delete window[key];
    },
  };
}
module.exports = class VideoFullscreen extends Plugin {
  onload() {
    this.sessions = new Map();
    this.roots = new Map();
    this.active = new Map();
    this.app.workspace.onLayoutReady(() => this.sync());
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.sync()),
    );
  }
  sync() {
    const roots = new Set(
      ["canvas", "webviewer"].flatMap((t) =>
        this.app.workspace.getLeavesOfType(t).map((l) => l.view.containerEl),
      ),
    );
    for (const [root, observer] of this.roots)
      if (!roots.has(root)) {
        observer.disconnect();
        this.roots.delete(root);
      }
    for (const root of roots)
      if (!this.roots.has(root)) {
        const observer = new MutationObserver((changes) => {
          if (
            changes.some((c) =>
              [...c.addedNodes, ...c.removedNodes].some(
                (n) => n.matches?.("webview") || n.querySelector?.("webview"),
              ),
            )
          )
            this.scan();
        });
        observer.observe(root, { childList: true, subtree: true });
        this.roots.set(root, observer);
      }
    this.scan();
  }
  scan() {
    const live = new Set(
      [...this.roots.keys()].flatMap((r) => [...r.querySelectorAll("webview")]),
    );
    for (const [w, dispose] of this.sessions)
      if (!live.has(w)) {
        dispose();
        this.sessions.delete(w);
      }
    for (const w of live) if (!this.sessions.has(w)) this.attach(w);
  }
  attach(w) {
    const token = "vfh_" + randomUUID().replaceAll("-", "");
    const signal = randomUUID();
    let contents,
      disposed = false;
    const frames = () => {
      try {
        return contents.mainFrame.framesInSubtree;
      } catch {
        return [];
      }
    };
    const run = (frame, code) => {
      try {
        return frame.executeJavaScript(code).catch(() => {});
      } catch {}
    };
    const inject = () => {
      if (disposed) return;
      for (const frame of frames())
        if (/^https?:/.test(frame.url))
          run(
            frame,
            "(" +
              connectPlayer.toString() +
              ")(" +
              JSON.stringify(token) +
              "," +
              JSON.stringify(signal) +
              ")",
          );
    };
    const ready = () => {
      try {
        if (!contents) {
          contents = remote.webContents.fromId(w.getWebContentsId());
          contents.on("did-frame-finish-load", inject);
          contents.on("before-input-event", beforeInput);
        }
        inject();
      } catch {}
    };
    const doc = w.ownerDocument;
    const restore = () => {
      const a = this.active.get(doc);
      if (a?.w !== w) return;
      this.active.delete(doc);
      for (const el of a.path) el.classList.remove("vfh-path");
      if (!a.wasFull && !a.win.isDestroyed()) a.win.setFullScreen(false);
    };
    const leave = () => {
      for (const f of frames())
        run(f, "window[" + JSON.stringify(token) + "]?.leave()");
      restore();
    };
    const beforeInput = (event, input) => {
      if (
        input.type === "keyDown" &&
        input.key === "Escape" &&
        this.active.get(doc)?.w === w
      ) {
        event.preventDefault();
        leave();
      }
    };
    const navigate = (e) => {
      if (e.isMainFrame && !e.isInPlace) leave();
    };
    const message = (e) => {
      if (e.message === signal + ":leave") {
        restore();
        return;
      }
      if (e.message !== signal + ":enter" || this.active.get(doc)?.w === w)
        return;
      this.active.get(doc)?.leave();
      const win = doc.defaultView.electronWindow || remote.getCurrentWindow();
      if (!win) return;
      const path = [];
      for (
        let el = w;
        el && el !== doc.documentElement;
        el = el.parentElement
      ) {
        path.push(el);
        el.classList.add("vfh-path");
      }
      this.active.set(doc, {
        w,
        path,
        win,
        wasFull: win.isFullScreen(),
        leave,
      });
      win.setFullScreen(true);
      w.focus();
    };
    const escape = (e) => {
      if (this.active.get(doc)?.w === w && e.key === "Escape") leave();
    };
    w.addEventListener("console-message", message);
    w.addEventListener("dom-ready", ready);
    w.addEventListener("did-start-navigation", navigate);
    w.addEventListener("destroyed", restore);
    doc.addEventListener("keydown", escape, true);
    this.sessions.set(w, () => {
      disposed = true;
      restore();
      for (const f of frames())
        run(f, "window[" + JSON.stringify(token) + "]?.dispose()");
      try {
        contents?.removeListener("before-input-event", beforeInput);
        contents?.removeListener("did-frame-finish-load", inject);
      } catch {}
      w.removeEventListener("console-message", message);
      w.removeEventListener("dom-ready", ready);
      w.removeEventListener("did-start-navigation", navigate);
      w.removeEventListener("destroyed", restore);
      doc.removeEventListener("keydown", escape, true);
    });
    ready();
  }
  onunload() {
    for (const o of this.roots.values()) o.disconnect();
    this.roots.clear();
    for (const dispose of this.sessions.values()) dispose();
    this.sessions.clear();
  }
};

