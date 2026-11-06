// Turns raw results into short plain-English explanations.
import { isLocalUrl } from "./format.js";

const LOCAL_HINT =
  " Supabase's servers cannot reach \"localhost\" on your computer. " +
  "Use a public address (for example through a tunnel), or run Supabase locally.";

/**
 * @param {{status?: number|null, timedOut?: boolean, error?: string|null,
 *          url?: string|null, hasResponse?: boolean}} r
 * @returns {{label: string, tone: "ok"|"warn"|"fail", text: string}}
 */
export function explain(r = {}) {
  const { status = null, timedOut = false, error = null, url = null } = r;
  const err = String(error ?? "").toLowerCase();
  const local = url ? isLocalUrl(url) : false;
  const hint = local ? LOCAL_HINT : "";

  if (r.hasResponse === false) {
    return {
      label: "No reply saved",
      tone: "warn",
      text:
        "We saw this request but no reply was recorded. It may still be running, " +
        "or the reply expired before it was copied.",
    };
  }

  if (timedOut || err.includes("timeout") || err.includes("timed out")) {
    return {
      label: "Timed out",
      tone: "fail",
      text:
        "The other server did not answer in time. Check that it is online and fast, " +
        "or give the request more time." + hint,
    };
  }
  if (err.includes("resolve")) {
    return {
      label: "Cannot find server",
      tone: "fail",
      text:
        "The web address could not be found. Check it for typos and make sure the " +
        "website exists." + hint,
    };
  }
  if (err.includes("refused") || err.includes("couldn't connect") || err.includes("could not connect")) {
    return {
      label: "Connection refused",
      tone: "fail",
      text:
        "The server was found but would not accept the connection. It may be " +
        "switched off or the port number may be wrong." + hint,
    };
  }
  if (err.includes("ssl") || err.includes("tls") || err.includes("certificate")) {
    return {
      label: "Certificate problem",
      tone: "fail",
      text:
        "The secure connection failed. The server's security certificate may be " +
        "expired, wrong, or self-signed.",
    };
  }
  if (error) {
    return {
      label: "Could not send",
      tone: "fail",
      text: `The request failed before any answer came back: ${error}` + hint,
    };
  }
  if (status === null || status === undefined) {
    return {
      label: "No answer",
      tone: "fail",
      text: "No answer and no error message were recorded." + hint,
    };
  }

  if (status >= 200 && status < 300) {
    return { label: "Worked", tone: "ok", text: "The other server accepted the message." };
  }
  if (status >= 300 && status < 400) {
    return {
      label: "Redirected",
      tone: "warn",
      text:
        "The server said to go to a different address. Update the webhook to " +
        "use the final address.",
    };
  }

  const byCode = {
    400: ["Rejected the data", "The server did not understand the message. Check the data format it expects."],
    401: ["Not logged in", "The server wants a key or password that is missing or wrong."],
    403: ["Not allowed", "The server understood but refuses. Check the key, password or permissions."],
    404: ["Address not found", "The server has nothing at this address. Check the path in the web address."],
    405: ["Wrong method", "The server does not accept this kind of request (for example POST instead of GET)."],
    408: ["Server timed out", "The server gave up waiting. Try again, or check how slow it is."],
    413: ["Message too large", "The message is bigger than the server allows."],
    415: ["Wrong content type", "The server does not accept this kind of data. Check the Content-Type header."],
    422: ["Rejected the data", "The server understood the message but did not like its contents."],
    429: ["Too many requests", "The server is limiting how often you can call it. Slow down or retry later."],
    500: ["Server error", "The other server hit an error while handling the message. Check its logs."],
    502: ["Server unavailable", "A gateway in front of the server could not reach it."],
    503: ["Server unavailable", "The server is overloaded or switched off for now."],
    504: ["Server timed out", "A gateway in front of the server waited too long for it."],
  };
  if (byCode[status]) {
    const [label, text] = byCode[status];
    return { label, tone: "fail", text };
  }
  if (status >= 400 && status < 500) {
    return { label: `Rejected (${status})`, tone: "fail", text: "The server refused the message. Check what it expects." };
  }
  return { label: `Server error (${status})`, tone: "fail", text: "The other server had a problem. Check its logs." };
}