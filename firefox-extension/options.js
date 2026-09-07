import { getPorts, setPorts, getAllowedCommands } from "./extension-config.js";
const portsInput = document.getElementById("ports-input");
const savePortsButton = document.getElementById("save-ports");
const portsStatus = document.getElementById("ports-status");
const grantPermissionButton = document.getElementById("grant-permission");
const permissionStatus = document.getElementById("permission-status");
const toolList = document.getElementById("tool-list");
const containersButton = document.getElementById("grant-containers");
const containersStatus = document.getElementById("containers-status");
async function refreshContainers() {
    const granted = await browser.permissions.contains({ permissions: ["cookies"] });
    containersButton.disabled = granted;
    containersButton.classList.toggle("granted", granted);
    containersButton.textContent = granted ? "Isolated sessions enabled" : "Enable isolated sessions";
}
containersButton.addEventListener("click", async (event) => {
    if (!event.isTrusted) return;
    try {
        const granted = await browser.permissions.request({ permissions: ["cookies"] });
        flashStatus(containersStatus, granted ? "Isolated sessions enabled." : "Permission was not granted.", !granted);
    } catch (error) {
        flashStatus(containersStatus, error.message, true);
    }
    await refreshContainers();
});
function flashStatus(el, message, isError = false) {
    el.textContent = message;
    el.style.color = isError ? "red" : "#4caf50";
    setTimeout(() => {
        el.textContent = "";
        el.style.color = "";
    }, 3000);
}
async function loadPorts() {
    try {
        const ports = await getPorts();
        portsInput.value = ports.join(", ");
    }
    catch (error) {
        console.error("mcp-zen: error loading ports:", error);
        flashStatus(portsStatus, "Error loading ports.", true);
    }
}
async function savePorts(event) {
    if (!event.isTrusted)
        return;
    try {
        const portStrings = portsInput.value
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
        const ports = [];
        for (const portStr of portStrings) {
            const port = parseInt(portStr, 10);
            if (isNaN(port) || port < 1 || port > 65535) {
                throw new Error(`Invalid port number: ${portStr}`);
            }
            ports.push(port);
        }
        if (ports.length === 0)
            throw new Error("At least one port must be specified.");
        await setPorts(ports);
        browser.runtime.reload();
    }
    catch (error) {
        flashStatus(portsStatus, error instanceof Error ? error.message : "Failed to save ports", true);
    }
}
async function refreshPermissionStatus() {
    const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
    grantPermissionButton.textContent = granted ? "Browser automation enabled" : "Enable browser automation";
    grantPermissionButton.classList.toggle("granted", granted);
    grantPermissionButton.disabled = granted;
}
async function grantPermission(event) {
    if (!event.isTrusted)
        return;
    try {
        const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
        if (granted) {
            flashStatus(permissionStatus, "Browser automation enabled.");
        }
        else {
            flashStatus(permissionStatus, "Permission was not granted.", true);
        }
    }
    catch (error) {
        console.error("mcp-zen: error requesting permission:", error);
        flashStatus(permissionStatus, "Failed to request permission.", true);
    }
    finally {
        await refreshPermissionStatus();
    }
}
function renderToolList() {
    toolList.innerHTML = "";
    for (const cmd of getAllowedCommands()) {
        const li = document.createElement("li");
        li.textContent = cmd;
        toolList.appendChild(li);
    }
}
savePortsButton.addEventListener("click", savePorts);
grantPermissionButton.addEventListener("click", grantPermission);
document.addEventListener("DOMContentLoaded", () => {
    loadPorts();
    refreshPermissionStatus();
    refreshContainers();
    renderToolList();
});
