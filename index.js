const assert = require('assert');
const Path = require('path');
const URL = require('url');
const JSDOM = require('jsdom');
const cheerio = require('cheerio');
const fs = require('fs-promise');
const _ = require('lodash');
const delay = require('promise-delay');
const Debug = require('debug')
const helpers = require('./helpers');
const utils = require('./utils');

const debug = Debug('koa-ssr');
const debugJSDOM = Debug('koa-ssr:jsdom');
const debugJSDOMClient = Debug('koa-ssr:jsdom-client');

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

  const JSDOMVirtualConsole = JSDOM.createVirtualConsole().sendTo(utils.createJSDOMVirtualConsole(opts.console || debugJSDOMClient, Boolean(opts.console)));

  opts.modulesLoadedEventLabel = 'onModulesLoaded'

  opts.render = opts.render || ((ctx, html) => ctx.body = html);

  return function koaSSR(ctx) {

    const fullUrl = ctx.protocol + '://' + ctx.host + ctx.originalUrl;
    debug({ fullUrl })

    return checkCache(invokeJSDOM);

    function checkCache(next) {
      if (opts.cache) {
        let cache
        if (typeof opts.cache === 'function') {
          cache = opts.cache(ctx)
        } else {
          cache = opts.cache[ctx.originalUrl]
        }
        if (cache) {
          if (cache.then) {
            return cache.then(cache => {
              if (cache) {
                return opts.render(ctx, cache)
              } else {
                return next();
              }
            })
          } else {
            return opts.render(ctx, cache);
          }
        } else {
          return next();
        }
      }
    }

    function invokeJSDOM() {
      const jsdom = JSDOM.jsdom(opts.html, Object.assign({
        features: {
          FetchExternalResources: ['script', 'link', 'css'],
          QuerySelector: true,
        },

        resourceLoader: (resource, cb) => {
          debugJSDOM({ resourceLoader: resource.url.pathname });
          readFile(Path.join(root, resource.url.pathname))
            .then(asset => cb(null, asset))
            .catch(cb);
        },

        virtualConsole: JSDOMVirtualConsole,

      }, opts.jsdom));

      const window = jsdom.defaultView;

      JSDOM.changeURL(window, fullUrl);

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

        const preCache = JSDOM.serializeDocument(window.document);

        let final;
        if (typeof opts.cache === 'function') {
          final = opts.cache(ctx, preCache, window, JSDOM.serializeDocument);
          assert(final, `opts.cache() didn't return anything`)
          if (final.then) {
            return final.then(final => {
              assert(final, `opts.cache() didn't resolve to anything`)
              if (typeof final !== 'string') {
                try {
                  final = JSDOM.serializeDocument(final.document);
                } catch (error) {
                  error.message = `Failed trying to serialize opts.cache()'s resolved object. ` + error.message;
                  throw error;
                }
              }
              return opts.render(ctx, final)
            })
          } else {
            if (typeof final !== 'string') {
              try {
                final = JSDOM.serializeDocument(final.document);
              } catch (error) {
                error.message = `Failed trying to serialize opts.cache()'s returned object. ` + error.message;
                throw error;
              }
            }
            return opts.render(ctx, final);
          }
        } else {
          final = opts.cache[ctx.originalUrl] = preCache;
          return opts.render(ctx, final);
        }
      });
    }
  }
}

Object.assign(exports, helpers);
