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

// tps-ui.tsx
import { setProp as _$setProp } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal } from "solid-js";
async function mount(api) {
  const [version, setVersion] = createSignal(0);
  const meters = new Map;
  const parentOf = new Map;
  const knownSessions = new Set;
  const meterFor = (sessionID) => {
    let meter = meters.get(sessionID);
    if (!meter) {
      meter = createTpsMeter();
      meters.set(sessionID, meter);
    }
    return meter;
  };
  const isBusy = (sessionID) => api.state.session.status(sessionID)?.type === "busy";
  const offCreated = api.event.on("session.created", (event) => {
    const info = event.properties.info;
    knownSessions.add(info.id);
    parentOf.set(info.id, info.parentID);
  });
  const offMessage = api.event.on("message.updated", (event) => {
    knownSessions.add(event.properties.info.sessionID);
  });
  const inScope = (sessionID, routed) => {
    if (sessionID === routed)
      return true;
    let current = sessionID;
    for (let depth = 0;depth < 16; depth++) {
      if (!parentOf.has(current))
        return true;
      const parent = parentOf.get(current);
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
    for (const sessionID of knownSessions) {
      if (sessionID !== routed && inScope(sessionID, routed))
        result.push(sessionID);
    }
    return result;
  };
  const textChars = (messageID) => {
    let chars = 0;
    for (const part of api.state.part(messageID)) {
      if (part.type === "text" || part.type === "reasoning")
        chars += part.text?.length ?? 0;
    }
    return chars;
  };
  const predictPromptTokens = (sessionID, currentMessageID, meter) => {
    const messages = api.state.session.messages(sessionID);
    let baseline = 0;
    let baselineIndex = -1;
    for (let index = 0;index < messages.length; index++) {
      const message = messages[index];
      if (message.id === currentMessageID)
        break;
      if (message.role === "assistant" && message.tokens?.input) {
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
      charsSince += textChars(message.id);
    }
    return baseline + meter.tokensFromChars(charsSince);
  };
  const feed = (sessionID, busy) => {
    const messages = api.state.session.messages(sessionID);
    const message = messages.findLast((entry) => entry.role === "assistant");
    if (!message)
      return;
    const meter = meterFor(sessionID);
    if (message.time?.completed) {
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
      chars: textChars(message.id),
      busy,
      createdAt: message.time.created,
      predictPromptTokens: () => predictPromptTokens(sessionID, message.id, meter)
    });
  };
  const prune = (routed) => {
    if (knownSessions.size <= MAX_TRACKED_SESSIONS)
      return;
    for (const sessionID of knownSessions) {
      if (knownSessions.size <= MAX_TRACKED_SESSIONS)
        break;
      if (sessionID === routed)
        continue;
      if (isBusy(sessionID))
        continue;
      knownSessions.delete(sessionID);
      meters.delete(sessionID);
      parentOf.delete(sessionID);
    }
  };
  const routedSession = () => {
    const route = api.route.current;
    if (route?.name !== "session")
      return;
    return route.params?.sessionID;
  };
  const poll = () => {
    const routed = routedSession();
    if (!routed)
      return;
    knownSessions.add(routed);
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
  api.lifecycle.onDispose(() => {
    clearInterval(timer);
    offCreated();
    offMessage();
  });
  const segments2 = () => {
    version();
    const routed = routedSession();
    if (!routed)
      return [];
    const active = contributors(meters.get(routed), descendants(routed).map((sessionID) => meters.get(sessionID)));
    return segments(active, api.theme.current.textMuted);
  };
  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right() {
        return (() => {
          var _el$ = _$createElement("text");
          _$insert(_el$, () => segments2().map(([label, colour]) => (() => {
            var _el$2 = _$createElement("span");
            _$setProp(_el$2, "style", {
              fg: colour
            });
            _$insert(_el$2, label);
            return _el$2;
          })()));
          return _el$;
        })();
      }
    }
  });
}
export {
  mount
};
