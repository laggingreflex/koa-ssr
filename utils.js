const assert = require('assert');
const Debug = require('debug')
const JSDOM = require('jsdom');

exports.createJSDOMVirtualConsole = (console, prefix) => {
  const debug = Debug('koa-ssr:utils:virtualConsole');

  debug({ prefix })

  return ['log', 'error', 'debug', 'warn'].reduce((ret, level) => {
    const conLevel = console[level] || console.log || console;
    if (level === 'log') {
      if (prefix !== false) {
        ret[level] = conLevel.bind(null, '[JSDOM]');
      } else {
        ret[level] = conLevel;
      }
    } else {
      if (prefix !== false) {
        ret[level] = conLevel.bind(null, `[JSDOM ${level}]`);
      } else {
        ret[level] = conLevel.bind(null, `[${level}]`);
      }
    }
    return ret;
  }, {});
}

exports.handleUserHtmlModification = async([userFn, userFnLabel], [ctx, htmlArg, window]) => {
  const debug = Debug('koa-ssr:utils:handleUserFn');
  let html = htmlArg
  if (!userFn) {
    return html;
  }
  userFnLabel = userFnLabel || userFn.name || 'userFn';
  // debug('')
  let ret
  try {
    ret = userFn(ctx, html, window, JSDOM.serializeDocument);
    if (ret.then) {
      ret = await ret;
    }
  } catch (err) {
    err.message = `Error in ${userFnLabel}: ` + err.message
  }

  // assert(ret, `${userFnLabel} didn't resolve to anything`)
  if (!ret) {
    debug(`${userFnLabel} didn't return anything`)
    return htmlArg;
  }

  if (typeof ret !== 'string') {
    try {
      ret = JSDOM.serializeDocument(ret.document);
    } catch (error) {
      error.message = `${userFnLabel}'s returned window object couldn't be serialized. ` + error.message;
      throw error;
    }
  }
  return ret;
}
