const Debug = require('debug')

exports.createJSDOMVirtualConsole = (console, prefix) => {
  const debug = Debug('koa-ssr:utils:createJSDOMVirtualConsole');

  debug({ prefix })

  return ['log', 'error', 'debug', 'warn'].reduce((ret, level) => {
    const conLevel = console[level] || console.log || console;
    if (level === 'log') {
      if (prefix !== false) {
        ret[level] = conLevel.bind(null, `[${prefix || 'JSDOM'}]`);
      } else {
        ret[level] = conLevel;
      }
    } else {
      if (prefix !== false) {
        ret[level] = conLevel.bind(null, `[${prefix ? prefix + ' ' : 'JSDOM '}${level}]`);
      } else {
        ret[level] = conLevel.bind(null, `[${level}]`);
      }
    }
    return ret;
  }, {});
}
