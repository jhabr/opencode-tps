// @bun
import {
  MAX_TRACKED_SESSIONS,
  TICK_MS,
  contributors,
  createTpsMeter,
  generatedTokens,
  needsSample,
  segments
} from "./chunk-j6k8bxdd.js";
import"./chunk-2mx7fq49.js";

// tui.tsx
import { setProp as _$setProp } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, untrack } from "solid-js";
var setup = (context) => {
  const [version, setVersion] = createSignal(0);
  const meters = new Map;
  const meterFor = (sessionID) => {
    let meter = meters.get(sessionID);
    if (!meter) {
      meter = createTpsMeter();
      meters.set(sessionID, meter);
    }
    return meter;
  };
  const isBusy = (sessionID) => context.data.session.status(sessionID) === "running";
  const beneath = (sessionID, routed) => {
    let current = sessionID;
    for (let depth = 0;depth < 16; depth++) {
      const parent = context.data.session.get(current)?.parentID;
      if (!parent)
        return false;
      if (parent === routed)
        return true;
      current = parent;
    }
    return false;
  };
  const descendants = (routed) => {
    const result = [];
    for (const sessionID of context.data.session.family(routed)) {
      if (sessionID !== routed && beneath(sessionID, routed))
        result.push(sessionID);
    }
    return result;
  };
  const assistantChars = (message) => {
    let chars = 0;
    for (const item of message.content) {
      if (item.type === "text" || item.type === "reasoning")
        chars += item.text.length;
    }
    return chars;
  };
  const messageChars = (message) => {
    if (message.type === "assistant")
      return assistantChars(message);
    if ("text" in message && typeof message.text === "string")
      return message.text.length;
    return 0;
  };
  const predictPromptTokens = (sessionID, currentMessageID, meter) => {
    const messages = context.data.session.message.list(sessionID);
    let baseline = 0;
    let baselineIndex = -1;
    for (let index = 0;index < messages.length; index++) {
      const message = messages[index];
      if (message.id === currentMessageID)
        break;
      if (message.type === "assistant" && message.tokens?.input) {
        baseline = message.tokens.input + generatedTokens(message.tokens);
        baselineIndex = index;
      }
    }
    if (baseline === 0)
      return 0;
    let charsSince = 0;
    for (let index = baselineIndex + 1;index < messages.length; index++) {
      const message = messages[index];
      if (message.id === currentMessageID)
        break;
      charsSince += messageChars(message);
    }
    return baseline + meter.tokensFromChars(charsSince);
  };
  const feed = (sessionID, busy) => {
    const messages = context.data.session.message.list(sessionID);
    const message = messages.findLast((entry) => entry.type === "assistant");
    if (!message)
      return;
    const meter = meterFor(sessionID);
    if (message.time.completed) {
      const tokens = message.tokens;
      meter.complete({
        messageID: message.id,
        outputTokens: generatedTokens(tokens),
        prefilledTokens: Math.max(0, (tokens?.input ?? 0) - (tokens?.cache?.read ?? 0))
      });
      return;
    }
    meter.sample({
      messageID: message.id,
      chars: assistantChars(message),
      busy,
      createdAt: message.time.created,
      predictPromptTokens: () => predictPromptTokens(sessionID, message.id, meter)
    });
  };
  const prune = (routed) => {
    if (meters.size <= MAX_TRACKED_SESSIONS)
      return;
    for (const sessionID of meters.keys()) {
      if (meters.size <= MAX_TRACKED_SESSIONS)
        break;
      if (sessionID === routed)
        continue;
      if (isBusy(sessionID))
        continue;
      meters.delete(sessionID);
    }
  };
  const routedSession = () => {
    const route = context.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const poll = () => {
    const routed = routedSession();
    if (!routed)
      return;
    feed(routed, isBusy(routed));
    for (const sessionID of descendants(routed)) {
      const busy = isBusy(sessionID);
      if (needsSample(busy, meters.get(sessionID)))
        feed(sessionID, busy);
    }
    prune(routed);
  };
  const timer = setInterval(() => {
    poll();
    setVersion((count) => count + 1);
  }, TICK_MS);
  const releaseSlot = context.ui.slot({
    append: "prompt.footer.status",
    render: () => (() => {
      var _el$ = _$createElement("text");
      _$insert(_el$, () => (() => {
        version();
        return untrack(() => {
          const routed = routedSession();
          if (!routed)
            return [];
          const active = contributors(meters.get(routed), descendants(routed).map((sessionID) => meters.get(sessionID)));
          return segments(active, context.theme.text.subdued);
        });
      })().map(([label, colour]) => (() => {
        var _el$2 = _$createElement("span");
        _$setProp(_el$2, "style", {
          fg: colour
        });
        _$insert(_el$2, label);
        return _el$2;
      })()));
      return _el$;
    })()
  });
  return () => {
    clearInterval(timer);
    releaseSlot();
  };
};
var tui_default = {
  id: "tps",
  setup
};
export {
  tui_default as default
};
