import { handleStart } from "../_lib/oauth.js";

export function onRequest(context) {
  return handleStart(context.request, context.env || {});
}
