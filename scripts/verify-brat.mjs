import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let page;
for (let i = 0; i < 90 && !page; i++) {
  try {
    page = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find(
      (p) =>
        p.url.startsWith("app://obsidian.md/") &&
        p.title.includes("BRAT Sandbox"),
    );
  } catch {}
  if (!page) await wait(1000);
}
assert(page, "Sandbox unavailable");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let id = 0;
async function evaluate(expression) {
  const number = ++id;
  return new Promise((resolve, reject) => {
    function handle(ev) {
      const msg = JSON.parse(ev.data);
      if (msg.id !== number) return;
      ws.removeEventListener("message", handle);
      if (msg.result?.exceptionDetails || msg.error)
        reject(
          Error(JSON.stringify(msg.result?.exceptionDetails || msg.error)),
        );
      else resolve(msg.result.result.value);
    }
    ws.addEventListener("message", handle);
    ws.send(
      JSON.stringify({
        id: number,
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        },
      }),
    );
  });
}
try {
  const result = await evaluate(
    "(" +
      async function () {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 240 && !window.app?.plugins?.setEnable; i++)
          await sleep(250);
        await app.plugins.setEnable(true);
        await new Promise((resolve) => app.workspace.onLayoutReady(resolve));
        await app.plugins.loadManifests();
        if (app.plugins.manifests["video-fullscreen-helper"])
          throw Error("Already installed");
        await app.plugins.enablePluginAndSave("obsidian42-brat");
        for (const modal of document.querySelectorAll(".modal-close-button"))
          modal.click();
        app.commands.executeCommandById("obsidian42-brat:AddBetaPlugin");
        const modal =
          document
            .querySelector('.modal input[placeholder*="github" i]')
            ?.closest(".modal") ||
          [...document.querySelectorAll(".modal")].at(-1);
        const input = modal.querySelector("input");
        input.focus();
        input.value =
          "https://github.com/tlatndms2-droid/obsidian-video-fullscreen";
        for (const type of ["input", "change"])
          input.dispatchEvent(new Event(type, { bubbles: true }));
        input.blur();
        for (
          let i = 0;
          i < 120 && !modal.querySelector('select option[value="0.1.1"]');
          i++
        )
          await sleep(250);
        const select = modal.querySelector("select");
        if (![...select.options].some((o) => o.value === "0.1.1"))
          throw Error(modal.innerText);
        const notices = new Set();
        const observer = new MutationObserver(() =>
          document
            .querySelectorAll(".notice")
            .forEach((n) => notices.add(n.innerText)),
        );
        observer.observe(document.body, { childList: true, subtree: true });
        select.value = "latest";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        const button = [...modal.querySelectorAll("button")].find(
          (x) => x.textContent.trim() === "Add plugin",
        );
        if (!button || button.disabled) throw Error(modal.innerText);
        button.click();
        for (let i = 0; i < 120; i++) {
          if (app.plugins.plugins["video-fullscreen-helper"]) break;
          await sleep(500);
        }
        const brat = app.plugins.plugins["obsidian42-brat"];
        return {
          brat: brat.manifest.version,
          installed: app.plugins.manifests["video-fullscreen-helper"]?.version,
          enabled: !!app.plugins.plugins["video-fullscreen-helper"],
          tracked: brat.settings.pluginList,
          notice: [...notices],
          dialog: modal.innerText,
        };
      }.toString() +
      ")()",
  );
  console.log(result);
  assert.equal(result.installed, "0.1.1");
  assert.equal(result.enabled, true);
  assert(result.tracked.includes("tlatndms2-droid/obsidian-video-fullscreen"));
  for (const file of ["manifest.json", "main.js", "styles.css"]) {
    const installed = readFileSync(
      process.env.RUNNER_TEMP +
        "/BRAT Sandbox/.obsidian/plugins/video-fullscreen-helper/" +
        file,
      "utf8",
    );
    assert.equal(
      installed.replaceAll("\r\n", "\n"),
      readFileSync(file, "utf8").replaceAll("\r\n", "\n"),
    );
  }
} finally {
  ws.close();
}
