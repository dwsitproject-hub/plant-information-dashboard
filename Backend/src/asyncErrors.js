/**
 * Express 4 calls a route handler and ignores the promise an async handler returns, so a rejected await
 * outside a try neither reaches the error handler nor answers the request (Express 5 fixes this). This
 * passes such a rejection to `next`, like Express 5. Imported once, before the app is built.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Layer = require('express/lib/router/layer.js')

Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle
  // A four-argument function is an error handler; Express skips it here.
  if (fn.length > 3) return next()
  try {
    const result = fn(req, res, next)
    if (result && typeof result.then === 'function') result.catch(next)
  } catch (error) {
    next(error)
  }
}
