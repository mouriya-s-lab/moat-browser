import { type } from "arktype";
import type { BrowserCommand } from "./messages";

const Navigate = type({
  _tag: "'Navigate'",
  url: "string",
});

const Click = type({
  _tag: "'Click'",
  selector: "string",
});

const Fill = type({
  _tag: "'Fill'",
  selector: "string",
  value: "string",
});

const Snapshot = type({
  _tag: "'Snapshot'",
});

const Screenshot = type({
  _tag: "'Screenshot'",
});

const Evaluate = type({
  _tag: "'Evaluate'",
  expression: "string",
});

const NewTab = type({
  _tag: "'NewTab'",
  "url?": "string",
});

const SwitchTab = type({
  _tag: "'SwitchTab'",
  index: "number",
});

const CloseTab = type({
  _tag: "'CloseTab'",
  index: "number",
});

const Wait = type({
  _tag: "'Wait'",
  selector: "string",
  "timeout?": "number",
});

const BrowserCommandSchema = Navigate
  .or(Click)
  .or(Fill)
  .or(Snapshot)
  .or(Screenshot)
  .or(Evaluate)
  .or(NewTab)
  .or(SwitchTab)
  .or(CloseTab)
  .or(Wait);

export function validateBrowserCommand(
  data: unknown
): BrowserCommand | { readonly _tag: "ValidationError"; readonly message: string } {
  const result = BrowserCommandSchema(data);
  if (result instanceof type.errors) {
    return { _tag: "ValidationError", message: result.summary };
  }
  return result;
}
