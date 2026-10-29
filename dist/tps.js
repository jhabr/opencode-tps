// @bun
import {
  __require
} from "./chunk-2mx7fq49.js";

// tps.ts
var tui = async (api) => {
  const ui = await import("./chunk-7c2ypnxt.js");
  await ui.mount(api);
};
var setup = async (context) => {
  const ui = await import("./chunk-tpf59ad9.js");
  return ui.default.setup(context);
};
var tps_default = { id: "tps", tui, setup };
export {
  tps_default as default
};
