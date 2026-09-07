import yaml from "js-yaml";
import allowedToolsYaml from "./allowed-tools.yaml";

const ALLOWED_COMMANDS = new Set(yaml.load(allowedToolsYaml).enabled);
export function getAllowedCommands() { return [...ALLOWED_COMMANDS]; }
export async function getConfig() {
  const { config = {} } = await browser.storage.local.get("config");
  return { ports: config.ports?.length ? config.ports : [8765] };
}
export async function getPorts() { return (await getConfig()).ports; }
export async function setPorts(ports) {
  await browser.storage.local.set({ config: { ports: [...new Set(ports)] } });
}
