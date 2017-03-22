const assert = require('assert');
const Path = require('path');
const URL = require('url');
const jsdom = require('jsdom');
const cheerio = require('cheerio');
const fs = require('fs-promise');
const _ = require('lodash');
const delay = require('promise-delay');
const debug = require('debug')('koa-ssr');

const createJSDOMVirtualConsole = console => ({
  log: (console.log || console.log || console).bind(console, '[JSDOM]'),
  error: (console.error || console.log || console).bind(console, '[JSDOM error]'),
  debug: (console.debug || console.log || console).bind(console, '[JSDOM debug]'),
  warn: (console.warn || console.log || console).bind(console, '[JSDOM warn]'),
})

const defaultJSDOMVirtualConsole = createJSDOMVirtualConsole(debug);

const readFile = _.memoize(f => fs.readFile(f, 'utf8'));

module.exports = function koaSSRmiddleware(root, opts) {

  assert(root, 'root directory is required to serve files');

  if (!opts) {
    opts = {}
  }

  if (!opts.index && !opts.html) {
    opts.index = 'index.html'
  }

  if (opts.index) {
    opts.html = fs.readFileSync(Path.join(root, opts.index), 'utf8')
  }

  opts.timeout = opts.timeout || 5000;

  if ((!opts.cache && opts.cache !== false) || opts.cache === true) {
    opts.cache = {}
  }

  const inputHtmlDom = cheerio.load(opts.html);
  // Because JSDOM doesn't execute script with defer/async attribute: https://github.com/tmpvar/jsdom/issues?q=defer+OR+async
  const modifiedScriptTags = {};
  inputHtmlDom('body script').each((i, e) => {
    e = inputHtmlDom(e);
    if (e.attr('defer') || e.attr('async')) {
      modifiedScriptTags[e.attr('src')] = e.attr('defer') ? 'defer' : e.attr('async') ? 'async' : false;
      e.attr('defer', false)
      e.attr('async', false)
    }
  });
  debug({ modifiedScriptTags })

  const inputHtml = inputHtmlDom.html();
  debug({ inputHtml })

  const JSDOMVirtualConsole = jsdom.createVirtualConsole().sendTo(createJSDOMVirtualConsole(opts.console || debug));

  opts.modulesLoadedEventLabel = 'onModulesLoaded'

  return function koaSSR(ctx) {

    const fullUrl = ctx.protocol + '://' + ctx.host + ctx.originalUrl;
    debug({ fullUrl })

    if (opts.cache) {
      let cache
      if (typeof opts.cache === 'function') {
        cache = opts.cache(ctx)
      } else {
        cache = opts.cache[ctx.originalUrl]
      }
      if (cache) {
        ctx.body = cache;
        debug({ cache });
        return;
      }
    }

    const doc = jsdom.jsdom(opts.html, Object.assign({
      features: {
        FetchExternalResources: ['script', 'link', 'css'],
        QuerySelector: true,
      },

      resourceLoader: (resource, cb) => readFile(Path.join(root, resource.url.pathname))
        .then(asset => cb(null, asset))
        .catch(cb),

      virtualConsole: JSDOMVirtualConsole,

    }, opts.jsdom));

    const window = doc.defaultView;

    jsdom.changeURL(window, fullUrl);

    let resolve;
    const loaded = new Promise(r => resolve = r);

    window[opts.modulesLoadedEventLabel] = () => {
      resolve();
      loaded.loaded = true;
    };

    return Promise.race([loaded, delay(opts.timeout)]).then(() => {
      resolve();
      if (!loaded.loaded) {
        const err = new Error(`JSDOM Timed out (${parseInt(opts.timeout/1000, 10)}s), \`window.${opts.modulesLoadedEventLabel}\` was never called.`)
        err.koaSSR = { ctx, window };
        throw err;
      }

      // restore modifiedScriptTags (async/defer)
      for (const script of window.document.querySelectorAll('script')) {
        const src = URL.parse(script.src).path;
        if (src in modifiedScriptTags) {
          script.setAttribute(modifiedScriptTags[src], true);
        }
      }

      ctx.body = jsdom.serializeDocument(window.document);

      if (opts.cache) {
        if (typeof opts.cache === 'function') {
          opts.cache(ctx, ctx.body)
        } else {
          opts.cache[ctx.originalUrl] = ctx.body;
        }
      }
    })
  }
}
