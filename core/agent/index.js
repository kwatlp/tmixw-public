// Player agent foundation (roadmap v4, v0.4.0 item 6) — scaffolding only.
// Mirrors the core/stt/ factory pattern, but ships NO agent behavior: this
// module exists so the config surface, settings tab, and wizard opt-in have
// somewhere durable to point. The agent itself is post-1.0 unless beta demand
// pulls it forward.

/**
 * Future agent adapter interface (not implemented by any backend yet).
 * @typedef {object} AgentAdapter
 * @property {string} backend - "none" | "kobold" | "custom"
 * @property {boolean} enabled
 * @property {(() => Promise<void>) | undefined} [initialize] - reserved
 * @property {((context: object) => Promise<object>) | undefined} [requestAction] - reserved
 */

/**
 * Create an (inert) agent adapter from the `agent` config block.
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]
 * @param {string} [opts.backend] - "none" | "kobold" | "custom"
 * @param {string} [opts.endpoint]
 * @param {string} [opts.bin]
 * @param {string} [opts.args]
 * @returns {AgentAdapter}
 */
export function createAgentAdapter(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  return {
    backend: typeof o.backend === "string" && o.backend ? o.backend : "none",
    enabled: o.enabled === true
  };
}

/** Default `agent` config block (config.example.json mirrors this). */
export function defaultAgentConfig() {
  return {
    enabled: false,
    backend: "none",
    endpoint: "",
    bin: "",
    args: ""
  };
}
