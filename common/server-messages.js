/**
 * Internal extension protocol (not the public MCP API).
 * @typedef {Object} ExtensionRequest
 * @property {string} correlationId
 * @property {string} cmd Allow-listed operation.
 * @property {Object} args Operation arguments, including the resolved numeric tabId.
 * @property {number} deadline Absolute epoch milliseconds; expired work must not start.
 *
 * @typedef {Object} ExtensionResponse
 * @property {string} correlationId
 * @property {*} [data] Successful operation result.
 * @property {{code: string, message: string}} [error] Failure, never an embedded page-result sentinel.
 */
export {};
