import { handleCallback } from "../_lib/oauth.js";

export function onRequest(context) {
  return handleCallback(context.request, context.env || {}, fetch);
}
